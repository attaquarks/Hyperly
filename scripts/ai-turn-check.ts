// One in-flight AI turn, and Stop that actually stops (Phase 4 R6, issue #19).
//
// WHY THIS EXISTS
// ---------------
// Verified in the source (P2B §6, §7):
//
//   * `useSystemAudio` created an AbortController but never passed its signal to
//     `fetchAIResponse`, which accepts one — so Stop was a no-op for a request
//     already streaming;
//   * nothing serialised `processWithAI`, so two answers' chunks interleaved into
//     the same `lastAIResponse`, and an aborted turn could still record its
//     partial answer;
//   * the session stores messages NEWEST-FIRST and passed them straight to the
//     model, so a LIVE session sent reverse-chronological context while a
//     RELOADED one was correct (`chat-history.action.ts` reads
//     `ORDER BY timestamp ASC`).
//
// WHAT R6 CHANGES
// ---------------
//   * `src/lib/ai-turn.ts` — one owner of the in-flight turn. `begin()` cancels
//     and supersedes whatever was streaming, `cancel()` is Stop, `mayPublish()`
//     refuses a partial answer, and `finish(id)` is identity-checked so a
//     superseded turn cannot retire a newer one.
//   * `src/lib/message-order.ts` — one chronological projection, applied once at
//     the boundary, never at each call site.
//
// THIS SCRIPT proves, by driving the REAL gate, the REAL request generator and
// the REAL projection:
//   A. the gate's turn algebra (supersede, Stop, identity, idle Stop);
//   B. cancellation is OBSERVABLE end to end: pressing Stop during a stream
//      aborts the request (the client's abort path runs and the response body is
//      cancelled), no further chunk arrives, and the publish rule refuses the
//      partial answer — while an uninterrupted turn still publishes;
//   C. the ordering projection is chronological, stable and non-mutating, and
//      matches the reload order;
//   D. structurally: the signal is passed, the publish is guarded, Stop cancels,
//      the orphaned AbortController is gone, ordering happens exactly once.
//
// Run with:  node --experimental-strip-types scripts/ai-turn-check.ts

import { register } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relPath: string): string => {
  try {
    return readFileSync(join(ROOT, relPath), "utf8");
  } catch {
    return "";
  }
};
/** Compare code, not prose: comments legitimately quote the old expressions. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const count = (source: string, pattern: RegExp): number =>
  (source.match(new RegExp(pattern.source, "g")) ?? []).length;

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

console.log("=".repeat(72));
console.log("one AI turn at a time, and a Stop that stops (Phase 4 R6)");
console.log("=".repeat(72));

const turnSource = read("src/lib/ai-turn.ts");
const orderSource = read("src/lib/message-order.ts");
const systemAudioSource = code(read("src/hooks/useSystemAudio.ts"));
const responseSource = code(read("src/lib/functions/ai-response.function.ts"));
const historySource = code(read("src/lib/database/chat-history.action.ts"));

// ---- D. structural --------------------------------------------------------

console.log("\nD. structural wiring");

check(
  "the turn gate exists and is pure",
  turnSource.length > 0 && !/^import\s/m.test(turnSource),
  () => "src/lib/ai-turn.ts is missing, or it imports something"
);
check(
  "it exports the gate and the publish rule",
  /export class AiTurnGate/.test(turnSource) &&
    /export interface AiTurn/.test(turnSource) &&
    /begin\(/.test(turnSource) &&
    /cancel\(/.test(turnSource) &&
    /finish\(/.test(turnSource) &&
    /mayPublish\(/.test(turnSource),
  () => "ai-turn.ts is missing part of the turn API"
);
check(
  "the ordering helper exists and is pure",
  orderSource.length > 0 &&
    !/^import\s/m.test(orderSource) &&
    /export const chronological/.test(orderSource),
  () => "src/lib/message-order.ts is missing or imports something"
);
check(
  "the request is driven by the turn's signal",
  /signal:\s*turn\.signal/.test(systemAudioSource),
  () => "fetchAIResponse is not given the turn's signal, so Stop cannot reach it"
);
check(
  "the request generator still honours an abort",
  /signal\?\.aborted/.test(responseSource),
  () => "ai-response.function.ts no longer checks signal.aborted"
);
check(
  "the answer is published only while its turn is current",
  /mayPublish\(/.test(systemAudioSource),
  () => "the persistence path is not guarded by the publish rule"
);
const cancelSites = count(systemAudioSource, /getAiTurns\(\)\.cancel\(\)/);
check(
  "Stop cancels the in-flight turn (and so does unmount)",
  cancelSites >= 2,
  () => `only ${cancelSites} cancel() call site(s); the Stop path and unmount must both cancel`
);
check(
  "the orphaned AbortController is gone",
  !/abortControllerRef/.test(systemAudioSource),
  () =>
    "useSystemAudio still owns an AbortController whose signal reaches no request"
);
const orderSites = count(systemAudioSource, /chronological\(/);
check(
  "ordering happens once, at the boundary",
  orderSites === 1 && !/const previousMessages/.test(systemAudioSource),
  () =>
    `chronological() appears ${orderSites} time(s); per-site history projections are ${
      /const previousMessages/.test(systemAudioSource) ? "still present" : "gone"
    }`
);
check(
  "the projection matches the reload order",
  /ORDER BY timestamp ASC/.test(historySource),
  () => "chat-history.action.ts no longer reads messages in timestamp order"
);

// ---- module loading --------------------------------------------------------

// The app source uses the bundler alias `@/…` and extensionless relative imports;
// Node knows neither. A resolver hook teaches it both, so this check drives the
// real modules rather than a copy of them.
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

// Building the enhanced system prompt reads localStorage, as in the WebView.
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

type Turn = { id: number; signal: AbortSignal; isCurrent(): boolean };
type Gate = {
  begin(): Turn;
  cancel(): boolean;
  finish(id: number): void;
  mayPublish(turn: Turn): boolean;
  readonly inFlight: boolean;
  readonly activeId: number;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

let GateClass: (new () => Gate) | null = null;
let chronological: (<T extends { timestamp?: number }>(m: readonly T[]) => T[]) | null =
  null;
let fetchAIResponse: ((params: any) => AsyncIterable<string>) | null = null;

try {
  const mod: any = await import("../src/lib/ai-turn.ts");
  if (typeof mod.AiTurnGate !== "function") {
    throw new Error("ai-turn.ts must export AiTurnGate");
  }
  GateClass = mod.AiTurnGate;
} catch (error) {
  fail("the turn gate runs", messageOf(error));
}
try {
  const mod: any = await import("../src/lib/message-order.ts");
  if (typeof mod.chronological !== "function") {
    throw new Error("message-order.ts must export chronological");
  }
  chronological = mod.chronological;
} catch (error) {
  fail("the ordering helper runs", messageOf(error));
}
try {
  const mod: any = await import("../src/lib/functions/ai-response.function.ts");
  if (typeof mod.fetchAIResponse !== "function") {
    throw new Error("ai-response.function.ts must export fetchAIResponse");
  }
  fetchAIResponse = mod.fetchAIResponse;
} catch (error) {
  fail("the request generator runs", messageOf(error));
}

// ---- A. the gate's turn algebra -------------------------------------------

console.log("\nA. the turn gate");

if (GateClass) {
  const gate = new GateClass();
  const first = gate.begin();
  check(
    "begin() starts a turn with a live signal",
    gate.inFlight && first.isCurrent() && !first.signal.aborted,
    () => `inFlight=${gate.inFlight} current=${first.isCurrent()}`
  );

  const second = gate.begin();
  check(
    "a second turn supersedes the first: its request is aborted",
    first.signal.aborted && !first.isCurrent(),
    () => `aborted=${first.signal.aborted} current=${first.isCurrent()}`
  );
  check(
    "only the newer turn is current (one in-flight turn per session)",
    second.isCurrent() && gate.activeId === second.id,
    () => `current=${second.isCurrent()} activeId=${gate.activeId}`
  );
  check(
    "the superseded turn may not publish, the current one may",
    !gate.mayPublish(first) && gate.mayPublish(second),
    () => `first=${gate.mayPublish(first)} second=${gate.mayPublish(second)}`
  );

  const stopped = gate.cancel();
  check(
    "cancel() is Stop: it aborts the in-flight request",
    stopped && second.signal.aborted,
    () => `cancelled=${stopped} aborted=${second.signal.aborted}`
  );
  check(
    "...and refuses the partial answer",
    !gate.mayPublish(second) && !gate.inFlight,
    () => `mayPublish=${gate.mayPublish(second)} inFlight=${gate.inFlight}`
  );
  check(
    "a Stop with nothing in flight is a no-op",
    gate.cancel() === false,
    () => "cancel() reported a cancellation with no turn in flight"
  );

  const oldTurn = gate.begin();
  const newTurn = gate.begin();
  gate.finish(oldTurn.id);
  check(
    "a superseded turn cannot retire a newer one",
    gate.activeId === newTurn.id && newTurn.isCurrent(),
    () => `activeId=${gate.activeId} expected=${newTurn.id}`
  );
  gate.finish(newTurn.id);
  check(
    "the current turn retires the gate",
    !gate.inFlight && gate.activeId === 0,
    () => `inFlight=${gate.inFlight} activeId=${gate.activeId}`
  );
  check(
    "Stop after a finished turn does nothing",
    gate.cancel() === false,
    () => "cancel() after finish() reported a cancellation"
  );
}

// ---- B. cancellation, observed end to end ---------------------------------

console.log("\nB. Stop during a stream");

const sse = (text: string) =>
  new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`
  );

const aiProvider = {
  id: "test-ai",
  curl: `curl https://api.example.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{API_KEY}}" \\
  -d '{"model":"{{MODEL}}","messages":[{"role":"system","content":"{{SYSTEM_PROMPT}}"},{"role":"user","content":"{{TEXT}}"}]}'`,
  responseContentPath: "choices[0].message.content",
  streaming: true,
};
const aiVars = { provider: "test-ai", variables: { api_key: "k", model: "gpt-4o" } };

/** A streaming response whose body the test controls chunk by chunk. */
const controlledStream = () => {
  const state = {
    aborted: false,
    bodyCancelled: false,
    push: (_text: string): void => {},
    error: (_error: unknown): void => {},
    close: (): void => {},
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      state.push = (text) => controller.enqueue(sse(text));
      state.error = (error) => controller.error(error);
      state.close = () => controller.close();
    },
    cancel() {
      state.bodyCancelled = true;
    },
  });
  /**
   * The client. With `errorOnAbort` it mirrors the Tauri HTTP client, which
   * cancels the request when the signal aborts; without it the body is left
   * alone, so only the generator's own abort handling can stop the stream.
   */
  const client = (errorOnAbort: boolean) =>
    (async (_input: any, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        state.aborted = true;
        if (errorOnAbort) state.error(new Error("Request cancelled"));
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof globalThis.fetch;
  return { state, client };
};

const openTurn = (client: typeof globalThis.fetch, turn: Turn) =>
  fetchAIResponse!({
    provider: aiProvider,
    selectedProvider: aiVars,
    userMessage: "hello",
    history: [],
    fetchImpl: client,
    signal: turn.signal,
  })[Symbol.asyncIterator]();

if (GateClass && fetchAIResponse) {
  {
    // Stop mid-answer, with a client that leaves the body alone: the generator
    // itself must stop, drop the in-flight chunk, and cancel the body.
    const gate = new GateClass();
    const { state, client } = controlledStream();
    const turn = gate.begin();
    const iterator = openTurn(client(false), turn);

    state.push("Hel");
    const first = await iterator.next();
    const delivered = first.done ? [] : [first.value];

    const cancelled = gate.cancel();
    state.push("lo");
    const next = await iterator.next();

    check(
      "Stop during a stream stops the generator - no further chunk is delivered",
      delivered.join("") === "Hel" && next.done === true,
      () => `delivered=${JSON.stringify(delivered)} nextDone=${next.done}`
    );
    check(
      "Stop aborts the request's signal, and the client's abort path runs",
      cancelled === true && turn.signal.aborted && state.aborted,
      () =>
        `cancelled=${cancelled} aborted=${turn.signal.aborted} clientAborted=${state.aborted}`
    );
    check(
      "the response body is cancelled, not left being read",
      state.bodyCancelled === true,
      () => `bodyCancelled=${state.bodyCancelled}`
    );
    check(
      "the partial answer is refused by the publish rule, so it is never persisted",
      gate.mayPublish(turn) === false,
      () => "the stopped turn would have been published"
    );
  }

  {
    // The same Stop, with a client that cancels the request on abort (the real
    // one). The cancellation must not surface as an error to the user.
    const gate = new GateClass();
    const { state, client } = controlledStream();
    const turn = gate.begin();
    const iterator = openTurn(client(true), turn);

    state.push("Par");
    await iterator.next();
    let surfaced: unknown = null;
    gate.cancel();
    try {
      await iterator.next();
    } catch (error) {
      surfaced = error;
    }
    check(
      "a client-cancelled request is not surfaced as an error",
      surfaced === null && gate.mayPublish(turn) === false,
      () =>
        `surfaced=${surfaced === null ? "none" : messageOf(surfaced)} mayPublish=${gate.mayPublish(
          turn
        )}`
    );
  }

  {
    // Control: an uninterrupted turn still publishes, so the guard is not
    // trivially refusing every answer.
    const gate = new GateClass();
    const { state, client } = controlledStream();
    const turn = gate.begin();
    const iterator = openTurn(client(false), turn);

    state.push("Hel");
    state.push("lo");
    state.close();
    const chunks: string[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      if (!turn.isCurrent()) break;
      chunks.push(step.value);
    }
    const published = gate.mayPublish(turn) ? chunks.join("") : null;
    gate.finish(turn.id);
    check(
      "an uninterrupted turn still publishes its full answer",
      published === "Hello",
      () => `published=${JSON.stringify(published)}`
    );
  }

  {
    // A second utterance arrives while the first answer is streaming: one turn
    // at a time, and only the current answer may be recorded.
    const gate = new GateClass();
    const first = controlledStream();
    const second = controlledStream();
    const turnA = gate.begin();
    const iteratorA = openTurn(first.client(false), turnA);

    first.state.push("old-answer-part");
    await iteratorA.next();
    const turnB = gate.begin();
    second.state.push("new-answer");
    second.state.close();
    const iteratorB = openTurn(second.client(false), turnB);
    const collected: string[] = [];
    for (;;) {
      const step = await iteratorB.next();
      if (step.done) break;
      if (!turnB.isCurrent()) break;
      collected.push(step.value);
    }
    const tailA = await iteratorA.next();
    const publishedB = gate.mayPublish(turnB) ? collected.join("") : null;

    check(
      "a new turn supersedes the streaming one; only the current answer is recorded",
      turnA.signal.aborted &&
        !gate.mayPublish(turnA) &&
        tailA.done === true &&
        publishedB === "new-answer",
      () =>
        `oldAborted=${turnA.signal.aborted} oldMayPublish=${gate.mayPublish(
          turnA
        )} oldDone=${tailA.done} published=${JSON.stringify(publishedB)}`
    );
  }
}

// ---- C. the ordering projection -------------------------------------------

console.log("\nC. the history projection");

if (chronological) {
  {
    // As the session stores it: newest-first, because each turn prepends its pair.
    const stored = [
      { role: "assistant", content: "a2", timestamp: 30 },
      { role: "user", content: "u2", timestamp: 29 },
      { role: "assistant", content: "a1", timestamp: 20 },
      { role: "user", content: "u1", timestamp: 19 },
    ];
    const projected = chronological(stored);
    check(
      "the live projection is chronological, exactly as a reload is",
      projected.map((m) => m.timestamp).join(",") === "19,20,29,30" &&
        projected[projected.length - 1].content === "a2",
      () => `order=${projected.map((m) => m.timestamp).join(",")}`
    );
    check(
      "the projection does not mutate the stored array",
      stored[0].timestamp === 30 && stored[3].timestamp === 19,
      () => `stored=${stored.map((m) => m.timestamp).join(",")}`
    );
  }

  {
    // The mixed case: the quick-action path pushes a new message onto the END of
    // a newest-first array - exactly the array that used to be sent as-is.
    const mixed = [
      { role: "assistant", content: "a1", timestamp: 20 },
      { role: "user", content: "u1", timestamp: 19 },
      { role: "user", content: "u2", timestamp: 40 },
    ];
    const projected = chronological(mixed);
    check(
      "a pushed newest message lands last, wherever it sat in the array",
      projected.map((m) => m.content).join(",") === "u1,a1,u2",
      () => `order=${projected.map((m) => m.content).join(",")}`
    );
  }

  {
    // Stability, and the missing-timestamp default the stored messages never
    // rely on but a caller could hand over.
    const tied = [
      { id: "first", timestamp: 5 },
      { id: "second", timestamp: 5 },
      { id: "none" },
    ];
    const projected = chronological(tied)
      .map((m) => m.id)
      .join(",");
    check(
      "equal timestamps keep their stored order, and a missing one sorts oldest",
      projected === "none,first,second",
      () => `order=${projected}`
    );
  }
}

// ---- report ----------------------------------------------------------------

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log(
    "PASS - one AI turn at a time and a Stop that stops: the in-flight request is\n" +
      "       aborted, no further chunk arrives, the partial answer is refused, and\n" +
      "       the live history is projected chronologically like a reload."
  );
  process.exit(0);
}
console.log(`FAIL - ${failures.length} check(s) failed:`);
for (const f of failures) console.log(`  ${f.name}\n    ${f.problem}`);
process.exit(1);
