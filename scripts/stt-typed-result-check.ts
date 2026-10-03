// Typed STT results + error/content separation (Phase 4 R4, issue #17).
//
// WHY THIS EXISTS
// ---------------
// Two channels used to carry failure as if it were content:
//
//   * `fetchSTT` returned a plain string. A 401, an unreadable body and the
//     literal sentence "No transcription found" all came back on the *success*
//     path, and a job-based provider (Speechmatics, Rev.ai) returned its job id.
//     Every caller treated the string as speech: it entered the transcript and
//     was handed to the model as a user utterance.
//   * `fetchAIResponse` is an async generator that signalled failure by
//     *yielding* a string at five sites, so a provider error was concatenated
//     into the assistant's answer, persisted as an assistant turn, and re-sent
//     as history.
//
// R4 makes the separation structural — `SttResult` is a union whose only text
// carrier is `ok`, and the generator throws instead of yielding an error — and
// fixes the provider contracts that kept the failures invisible (Azure's
// case-mangled `DisplayText`, the unsubstituted `{{AUDIO}}` form field, job APIs
// treated as synchronous, and the CORS-bound browser `fetch`).
//
// THIS SCRIPT runs the REAL modules with an injected fetch (no network, no
// Tauri, no browser) and asserts:
//   A. fetchSTT never expresses failure as text
//        1. a 401 is `error`, not a transcript;
//        2. an empty transcription is `empty`, never the literal
//           "No transcription found";
//        3. a network failure is `error`;
//        4. an aborted request is `cancelled` (before and during the request);
//        5. the caller's AbortSignal reaches the HTTP client (R6 depends on it).
//   B. the provider contracts hold
//        6. Azure's `DisplayText` resolves at its real case, and only that case;
//        7. the metric field named by `{{AUDIO}}` (`data_file`, `media`) receives
//           the audio blob — the placeholder is never sent as text;
//        8. `file={{AUDIO}}` providers still post the blob under `file`;
//        9. a job-based provider reports an error instead of returning its id;
//       10. a `response_format=text` 2xx body is still speech (no regression).
//   C. fetchAIResponse never yields an error
//       11. a 401 throws and yields nothing, so no assistant turn is persisted
//           and no follow-up is generated from error text;
//       12. network, parse, missing-body and stream-read failures all throw;
//       13. the success paths still stream and normalise content unchanged.
//   D. structurally: no error text is expressible as content, the Tauri HTTP
//      client is used for http(s) URLs, and the job APIs are declared as such.
//
// Run with:  node --experimental-strip-types scripts/stt-typed-result-check.ts

import { register } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

// ---- module loading ---------------------------------------------------------
// The app source uses the bundler alias `@/…` and extensionless relative
// imports; Node knows neither. A resolver hook teaches it both, so this check
// exercises the real modules instead of a copy of them.
const HOOK = `
import { statSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, sep } from "node:path";
const ROOT = ${JSON.stringify(ROOT)};
const SRC = resolvePath(ROOT, "src") + sep;
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
export async function resolve(specifier, context, nextResolve) {
  let base = null;
  if (specifier.startsWith("@/")) {
    base = resolvePath(SRC, specifier.slice(2));
  } else if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL &&
    context.parentURL.startsWith("file:")
  ) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.startsWith(SRC)) base = resolvePath(dirname(parent), specifier);
  }
  if (base) {
    const candidates = [
      base,
      base + ".ts",
      base + ".tsx",
      base + sep + "index.ts",
      base + sep + "index.tsx",
    ];
    for (const candidate of candidates) {
      if (isFile(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);

// `getResponseSettings` (reached when the enhanced system prompt is built) reads
// localStorage; the WebView normally provides it.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  configurable: true,
  writable: true,
});

// ---- harness ----------------------------------------------------------------

type Failure = { name: string; problem: string };
const failures: Failure[] = [];
const fail = (name: string, problem: string) => {
  failures.push({ name, problem });
  console.log(`  FAIL  ${name}`);
  console.log(`        ${problem}`);
};
const ok = (line: string) => console.log(`  ok    ${line}`);
const check = (name: string, condition: boolean, detail: () => string) => {
  if (condition) ok(name);
  else fail(name, detail());
};

let fetchSTT: (params: any) => Promise<any>;
let fetchAIResponse: (params: any) => AsyncIterable<string>;
let providers: any[];

try {
  fetchSTT = (await import("../src/lib/functions/stt.function.ts")).fetchSTT;
  fetchAIResponse = (
    await import("../src/lib/functions/ai-response.function.ts")
  ).fetchAIResponse;
  providers = (await import("../src/config/stt.constants.ts"))
    .SPEECH_TO_TEXT_PROVIDERS;
} catch (error) {
  console.log("  FAIL  could not load the modules under test");
  console.log(
    `        ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}

const providerById = (id: string) => {
  const found = providers.find((p) => p.id === id);
  if (!found) throw new Error(`built-in provider ${id} is missing`);
  return found;
};

type Call = { url: string; init: RequestInit };
const requestRecorder = (
  reply: (call: Call) => Response | Promise<Response>
) => {
  const calls: Call[] = [];
  const impl = (async (input: any, init?: RequestInit) => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
};

const audioBlob = () =>
  new Blob([new Uint8Array(128).fill(7)], { type: "audio/wav" });
const json = (body: unknown, status = 200, statusText = "OK") =>
  new Response(JSON.stringify(body), { status, statusText });
const abortedError = () => {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
};
/** A provider shaped exactly like the built-in form providers. */
const formProvider = (over: Record<string, unknown> = {}) => ({
  id: "test-form",
  curl: `curl -X POST "https://api.example.com/stt" \\
      -H "Authorization: Bearer {{API_KEY}}" \\
      -F "file={{AUDIO}}" \\
      -F "model={{MODEL}}"`,
  responseContentPath: "text",
  streaming: false,
  ...over,
});
const formVars = (extra: Record<string, string> = {}) => ({
  provider: "test-form",
  variables: { api_key: "k", model: "m", ...extra },
});

console.log("=".repeat(72));
console.log("STT results are typed; provider errors are not content (Phase 4 R4)");
console.log("=".repeat(72));

// ---- A. fetchSTT never expresses failure as text ----------------------------

console.log("\nA. fetchSTT returns ok | empty | error | cancelled");

// A1. a bad key is an error, not a transcript (the issue's pass condition).
{
  const { impl } = requestRecorder(() =>
    json({ error: { message: "Invalid API key" } }, 401, "Unauthorized")
  );
  const result = await fetchSTT({
    provider: formProvider(),
    selectedProvider: formVars(),
    audio: audioBlob(),
    fetchImpl: impl,
  });
  check(
    "a 401 is an error, not a transcript",
    result.status === "error" &&
      result.message.includes("401") &&
      !("text" in result),
    () => `got ${JSON.stringify(result)}`
  );
}

// A2. an empty transcription is empty - never the sentence that used to be
// returned as if it were speech.
{
  const { impl } = requestRecorder(() => json({ text: "   " }));
  const result = await fetchSTT({
    provider: formProvider(),
    selectedProvider: formVars(),
    audio: audioBlob(),
    fetchImpl: impl,
  });
  check(
    "no transcription is empty, not the string it used to fake",
    result.status === "empty" &&
      !JSON.stringify(result).includes("No transcription"),
    () => `got ${JSON.stringify(result)}`
  );
}

// A3. a network failure is an error.
{
  const impl = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof globalThis.fetch;
  const result = await fetchSTT({
    provider: formProvider(),
    selectedProvider: formVars(),
    audio: audioBlob(),
    fetchImpl: impl,
  });
  check(
    "a network failure is an error",
    result.status === "error" && result.message.includes("Failed to fetch"),
    () => `got ${JSON.stringify(result)}`
  );
}

// A4. aborts are `cancelled`, before the request and during it.
{
  const before = requestRecorder(() => json({ text: "never sent" }));
  const preAborted = await fetchSTT({
    provider: formProvider(),
    selectedProvider: formVars(),
    audio: audioBlob(),
    signal: AbortSignal.abort(),
    fetchImpl: before.impl,
  });
  check(
    "an already-aborted request is cancelled without calling the client",
    preAborted.status === "cancelled" && before.calls.length === 0,
    () => `got ${JSON.stringify(preAborted)}, calls=${before.calls.length}`
  );

  const controller = new AbortController();
  const impl = (async (_input: any, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      const onAbort = () => reject(abortedError());
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort);
    })) as unknown as typeof globalThis.fetch;
  const pending = fetchSTT({
    provider: formProvider(),
    selectedProvider: formVars(),
    audio: audioBlob(),
    signal: controller.signal,
    fetchImpl: impl,
  });
  controller.abort();
  const result = await pending;
  check(
    "an abort mid-request is cancelled, not an error",
    result.status === "cancelled",
    () => `got ${JSON.stringify(result)}`
  );
}

// A5. the signal is forwarded (R6's Stop depends on this plumbing).
{
  const controller = new AbortController();
  const { impl, calls } = requestRecorder(() => json({ text: "hello" }));
  await fetchSTT({
    provider: formProvider(),
    selectedProvider: formVars(),
    audio: audioBlob(),
    signal: controller.signal,
    fetchImpl: impl,
  });
  check(
    "the caller's AbortSignal reaches the HTTP client",
    calls.length === 1 && calls[0].init.signal === controller.signal,
    () => `calls=${calls.length}`
  );
}

// ---- B. the provider contracts ---------------------------------------------

console.log("\nB. the provider contracts");

// B6. Azure resolves at the real case of the path, and only that case.
{
  const azure = providerById("azure-stt");
  const selectedProvider = {
    provider: "azure-stt",
    variables: { api_key: "k", region: "westus" },
  };
  const upper = requestRecorder(() =>
    json({ RecognitionStatus: "Success", DisplayText: "hello world" })
  );
  const resolved = await fetchSTT({
    provider: azure,
    selectedProvider,
    audio: audioBlob(),
    fetchImpl: upper.impl,
  });
  check(
    "Azure's DisplayText resolves at its real case",
    resolved.status === "ok" && resolved.text === "hello world",
    () => `got ${JSON.stringify(resolved)}`
  );
  check(
    "the binary body carries the audio and the URL the region",
    upper.calls.length === 1 &&
      upper.calls[0].init.body instanceof Blob &&
      upper.calls[0].url.includes("westus"),
    () => `url=${upper.calls[0]?.url}`
  );

  const lower = requestRecorder(() =>
    json({ recognitionStatus: "Success", displayText: "wrong case" })
  );
  const mismatched = await fetchSTT({
    provider: azure,
    selectedProvider,
    audio: audioBlob(),
    fetchImpl: lower.impl,
  });
  check(
    "the lookup stays case-sensitive (a wrong case does not match)",
    mismatched.status === "empty",
    () => `got ${JSON.stringify(mismatched)}`
  );
}

// B7. the field named by {{AUDIO}} receives the blob; the placeholder is never
// sent as text.
{
  const dataFile = formProvider({
    id: "test-data-file",
    curl: `curl -X POST "https://api.example.com/jobs" \\
      -H "Authorization: Bearer {{API_KEY}}" \\
      -F "data_file={{AUDIO}}" \\
      -F 'config={"type": "transcription", "transcription_config": {"language": "en"}}'`,
  });
  const audio = audioBlob();
  const { impl, calls } = requestRecorder(() => json({ text: "hi" }));
  await fetchSTT({
    provider: dataFile,
    selectedProvider: { provider: "test-data-file", variables: { api_key: "k" } },
    audio,
    fetchImpl: impl,
  });
  const body = calls[0]?.init.body as FormData;
  const field = body?.get("data_file") as Blob | string | null;
  check(
    "the {{AUDIO}} field receives the audio blob",
    field instanceof Blob &&
      field.size === audio.size &&
      field.type === "audio/wav",
    () =>
      `field=${
        field instanceof Blob
          ? `Blob(${field.size}, ${field.type})`
          : String(field)
      }`
  );
  let placeholderSent = false;
  let configValue = "";
  if (body && typeof (body as any).entries === "function") {
    for (const [key, value] of (body as any).entries()) {
      if (typeof value === "string" && value.includes("{{AUDIO}}")) {
        placeholderSent = true;
      }
      if (key === "config") configValue = String(value);
    }
  }
  check(
    "the literal {{AUDIO}} placeholder is never sent",
    !placeholderSent,
    () => "a text field still contains the placeholder"
  );
  check(
    "the JSON form field survives intact",
    configValue.includes('"language": "en"'),
    () => `config=${configValue}`
  );
}

// B8. `file={{AUDIO}}` providers keep working, header included.
{
  const whisper = providerById("openai-whisper");
  const audio = audioBlob();
  const { impl, calls } = requestRecorder(() => json({ text: "openai text" }));
  const result = await fetchSTT({
    provider: whisper,
    selectedProvider: {
      provider: "openai-whisper",
      variables: { api_key: "k", model: "whisper-1" },
    },
    audio,
    fetchImpl: impl,
  });
  const body = calls[0]?.init.body as FormData;
  const headers = calls[0]?.init.headers as Record<string, string>;
  check(
    "an OpenAI-shaped provider posts the blob under `file` with its model",
    result.status === "ok" &&
      result.text === "openai text" &&
      (body?.get("file") as Blob)?.size === audio.size &&
      body?.get("model") === "whisper-1" &&
      headers?.Authorization === "Bearer k" &&
      calls[0].url.includes("api.openai.com"),
    () =>
      `result=${JSON.stringify(result)} model=${body?.get("model")} auth=${
        headers?.Authorization
      }`
  );
}

// B9. job APIs report an error instead of returning the job id.
{
  for (const id of ["speechmatics-stt", "rev-ai-stt"]) {
    const provider = providerById(id);
    const { impl, calls } = requestRecorder(() =>
      json({ job: { id: "job-42" }, id: "job-42" })
    );
    const result = await fetchSTT({
      provider,
      selectedProvider: { provider: id, variables: { api_key: "k" } },
      audio: audioBlob(),
      fetchImpl: impl,
    });
    check(
      `${id} reports an error instead of returning its job id`,
      result.status === "error" &&
        !JSON.stringify(result).includes("job-42") &&
        result.message.includes("asynchronous") &&
        calls.length === 0,
      () => `got ${JSON.stringify(result)}, calls=${calls.length}`
    );
  }
}

// B10. `response_format=text` still yields speech (a provider that worked must
// not start failing because of R4).
{
  const groq = providerById("groq");
  const { impl } = requestRecorder(
    () => new Response("  transcribe me  ", { status: 200 })
  );
  const result = await fetchSTT({
    provider: groq,
    selectedProvider: {
      provider: "groq",
      variables: { api_key: "k", model: "whisper-large-v3" },
    },
    audio: audioBlob(),
    fetchImpl: impl,
  });
  check(
    "a plain-text 2xx body is still speech",
    result.status === "ok" && result.text === "transcribe me",
    () => `got ${JSON.stringify(result)}`
  );
}

// ---- C. fetchAIResponse never yields an error ------------------------------

console.log("\nC. fetchAIResponse throws instead of yielding an error");

const aiProvider = (over: Record<string, unknown> = {}) => ({
  id: "test-ai",
  curl: `curl https://api.example.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{API_KEY}}" \\
  -d '{
    "model": "{{MODEL}}",
    "messages": [{"role": "system", "content": "{{SYSTEM_PROMPT}}"}, {"role": "user", "content": "{{TEXT}}"}]
  }'`,
  responseContentPath: "choices[0].message.content",
  streaming: true,
  ...over,
});
const aiVars = (extra: Record<string, string> = {}) => ({
  provider: "test-ai",
  variables: { api_key: "bad", model: "gpt-4o", ...extra },
});
/** Consume the generator the way every caller does, recording what it yielded. */
const drain = async (params: any) => {
  const chunks: string[] = [];
  let thrown: Error | null = null;
  try {
    for await (const chunk of fetchAIResponse(params)) chunks.push(chunk);
  } catch (error) {
    thrown = error as Error;
  }
  return { chunks, thrown };
};

// C11. a 401 must throw, and must not put anything in the content stream - the
// consumers persist on non-empty content, so that is what stops an error
// becoming an assistant turn.
{
  const { impl } = requestRecorder(
    () =>
      new Response('{"error":{"message":"Invalid API key"}}', {
        status: 401,
        statusText: "Unauthorized",
      })
  );
  const { chunks, thrown } = await drain({
    provider: aiProvider(),
    selectedProvider: aiVars(),
    userMessage: "hello",
    fetchImpl: impl,
  });
  check(
    "a 401 makes the generator throw",
    thrown !== null &&
      chunks.length === 0 &&
      chunks.join("") === "" &&
      /401/.test(thrown.message),
    () =>
      `thrown=${thrown?.message ?? "none"} content=${JSON.stringify(chunks)}`
  );
  check(
    "...so nothing is yielded and no assistant turn can be persisted",
    chunks.join("") === "",
    () => `content=${JSON.stringify(chunks.join(""))}`
  );
}

// C12. every other failure is a throw too, not a token.
{
  const impl = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof globalThis.fetch;
  const { chunks, thrown } = await drain({
    provider: aiProvider(),
    selectedProvider: aiVars(),
    userMessage: "hi",
    fetchImpl: impl,
  });
  check(
    "a network failure throws, yielding nothing",
    thrown !== null && chunks.length === 0,
    () => `thrown=${thrown?.message ?? "none"} chunks=${JSON.stringify(chunks)}`
  );
}
{
  const { impl } = requestRecorder(
    () => new Response("not json at all", { status: 200 })
  );
  const { chunks, thrown } = await drain({
    provider: aiProvider({ streaming: false }),
    selectedProvider: aiVars(),
    userMessage: "hi",
    fetchImpl: impl,
  });
  check(
    "an unparseable non-streaming body throws, yielding nothing",
    thrown !== null && chunks.length === 0,
    () => `thrown=${thrown?.message ?? "none"} chunks=${JSON.stringify(chunks)}`
  );
}
{
  const { impl } = requestRecorder(() => new Response(null, { status: 204 }));
  const { chunks, thrown } = await drain({
    provider: aiProvider(),
    selectedProvider: aiVars(),
    userMessage: "hi",
    fetchImpl: impl,
  });
  check(
    "a response with no body throws, yielding nothing",
    thrown !== null && chunks.length === 0,
    () => `thrown=${thrown?.message ?? "none"} chunks=${JSON.stringify(chunks)}`
  );
}
{
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n'
        )
      );
      // Error *after* the queued chunk has been read, so this is a genuine
      // mid-stream failure rather than one that discards the queue.
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.error(new Error("socket closed"));
    },
  });
  const { impl } = requestRecorder(() => new Response(stream, { status: 200 }));
  const { chunks, thrown } = await drain({
    provider: aiProvider(),
    selectedProvider: aiVars(),
    userMessage: "hi",
    fetchImpl: impl,
  });
  check(
    "a mid-stream read failure throws; only real content is yielded",
    thrown !== null &&
      chunks.join("") === "partial" &&
      !JSON.stringify(chunks).includes("Error reading stream"),
    () => `thrown=${thrown?.message} chunks=${JSON.stringify(chunks)}`
  );
}

// C13. the success paths are unchanged.
{
  const body = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "data: [DONE]",
    "",
  ].join("\n");
  const { impl, calls } = requestRecorder(
    () => new Response(body, { status: 200 })
  );
  const { chunks, thrown } = await drain({
    provider: aiProvider(),
    selectedProvider: aiVars({ api_key: "good" }),
    userMessage: "hi",
    fetchImpl: impl,
  });
  const sentStreamFlag =
    JSON.parse(String(calls[0]?.init.body ?? "{}")).stream === true;
  check(
    "a streaming answer still arrives as deltas (with stream:true requested)",
    thrown === null && chunks.join("") === "Hello" && sentStreamFlag,
    () =>
      `thrown=${thrown?.message ?? "none"} content=${JSON.stringify(
        chunks.join("")
      )} streamFlag=${sentStreamFlag}`
  );
}
{
  const { impl } = requestRecorder(
    () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "the answer" } }] }),
        { status: 200 }
      )
  );
  const { chunks, thrown } = await drain({
    provider: aiProvider({ streaming: false }),
    selectedProvider: aiVars({ api_key: "good" }),
    userMessage: "hi",
    fetchImpl: impl,
  });
  check(
    "a non-streaming answer still arrives once",
    thrown === null && chunks.join("") === "the answer",
    () => `thrown=${thrown?.message ?? "none"} content=${JSON.stringify(chunks)}`
  );
}

// ---- D. structurally, errors cannot be expressed as content ----------------

console.log("\nD. structural");

const readSource = (relPath: string) => readFileSync(join(ROOT, relPath), "utf8");
const sttSource = readSource("src/lib/functions/stt.function.ts");
const aiSource = readSource("src/lib/functions/ai-response.function.ts");
const modelsSource = readSource("src/lib/functions/fetch-models.function.ts");
const constantsSource = readSource("src/config/stt.constants.ts");

const bannedYields: Array<[string, RegExp]> = [
  ["network error", /yield\s+`Network error/],
  ["API request failed", /yield\s+`API request failed/],
  ["non-streaming parse failure", /yield\s+`Failed to parse non-streaming/],
  ["missing body", /yield\s+"Streaming not supported/],
  ["stream read error", /yield\s+`Error reading stream/],
];
const survivingYields = bannedYields
  .filter(([, pattern]) => pattern.test(aiSource))
  .map(([name]) => name);
check(
  "no ai-response failure path yields content",
  survivingYields.length === 0,
  () => `still yielded: ${survivingYields.join(", ")}`
);

check(
  "fetchSTT declares the four typed outcomes",
  /export type SttResult/.test(sttSource) &&
    ['"ok"', '"empty"', '"error"', '"cancelled"'].every((member) =>
      sttSource.includes(member)
    ) &&
    /Promise<SttResult>/.test(sttSource),
  () => "SttResult is missing one of ok|empty|error|cancelled"
);

check(
  '"No transcription found" is not returned as success',
  !/return[^;\n]*No transcription found/.test(sttSource),
  () => "the literal is still returned on the success path"
);

// Compare code, not prose: the fix is documented in a comment that quotes the
// old expression verbatim.
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
for (const [name, source] of [
  ["stt", sttSource],
  ["ai-response", aiSource],
  ["fetch-models", modelsSource],
] as const) {
  check(
    `${name} uses the Tauri HTTP client for http(s) URLs`,
    !/includes\("http"\)\s*\?\s*fetch\s*:\s*tauriFetch/.test(
      stripComments(source)
    ),
    () => "the CORS-bound browser client is still selected for http(s)"
  );
}

const jobBasedIds = providers
  .filter((provider) => provider.jobBased === true)
  .map((provider) => provider.id);
check(
  "exactly the two job APIs are flagged as job-based",
  jobBasedIds.length === 2 &&
    jobBasedIds.includes("speechmatics-stt") &&
    jobBasedIds.includes("rev-ai-stt"),
  () => `flagged: ${jobBasedIds.join(", ") || "none"}`
);

check(
  "the job APIs no longer declare a job id as a transcript path",
  !/responseContentPath:\s*"job\.id"/.test(constantsSource) &&
    !/responseContentPath:\s*"id"/.test(constantsSource),
  () => "a job id is still configured as a transcript path"
);

// ---- report ----------------------------------------------------------------

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log(
    "PASS - a provider error is a typed error and can never be content:\n" +
      "       a 401 produces an error, not a transcript and not an assistant turn."
  );
  process.exit(0);
}
console.log(`FAIL - ${failures.length} check(s) failed:`);
for (const f of failures) console.log(`  ${f.name}\n    ${f.problem}`);
process.exit(1);
