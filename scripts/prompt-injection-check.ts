// Personal context + system prompt must reach the model on EVERY LLM turn.
//
// WHY THIS EXISTS
// ---------------
// The two per-turn injections — the user's personal context (the interview
// context configured in the dashboard) and the system prompt — are composed
// at exactly one point: `fetchAIResponse` → `buildEnhancedSystemPrompt`.
// Every request path (Ask chat, Ask quick action, Ask screenshot, and all
// three Listen paths — room final, microphone, stop-and-send — plus Listen
// quick actions) funnels through it. Because the guarantee lives at the
// single choke point, a refactor that adds a request path bypassing it — or
// that reorders the composition so personal context stops being FIRST —
// would be invisible to the user and to every other guard. This script pins
// the chain.
//
// THE COMPOSITION ORDER (what the model actually receives):
//   1. personal context (getPersonalContext, when isInterviewContextEnabled
//      and non-empty) — prepended FIRST, highest priority;
//   2. the path's base system prompt (Ask: SYSTEM_PROMPT setting; Listen:
//      system prompt or the panel's context content, DEFAULT fallback);
//   3. Listen only: the channel legend + mode preset (composeListenPrompt)
//      and the knowledge file;
//   4. response length + language + markdown instructions.
//
// Run with:  node --experimental-strip-types scripts/prompt-injection-check.ts

import { readFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};
/** Compare code, not prose: comments legitimately quote identifiers. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const failures: string[] = [];
const assert = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

// --- A. the single composition point -----------------------------------------
{
  const ai = code(read("src/lib/functions/ai-response.function.ts"));
  // Extract buildEnhancedSystemPrompt's full body by brace counting (a naive
  // first-} slice ends at the first inner statement).
  const fnAnchor = ai.indexOf("function buildEnhancedSystemPrompt");
  assert(fnAnchor !== -1, "ai-response.function.ts: buildEnhancedSystemPrompt missing");
  let fnBody = "";
  if (fnAnchor !== -1) {
    const open = ai.indexOf("{", fnAnchor);
    let depth = 0;
    for (let i = open; i < ai.length; i += 1) {
      if (ai[i] === "{") depth += 1;
      else if (ai[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          fnBody = ai.slice(fnAnchor, i + 1);
          break;
        }
      }
    }
  }
  const contextFirst = fnBody.indexOf("composeSystemPromptWithContext");
  const lengthSecond = fnBody.indexOf("RESPONSE_LENGTHS");
  const languageThird = fnBody.indexOf("LANGUAGES");
  const markdownLast = fnBody.indexOf("MARKDOWN_FORMATTING_INSTRUCTIONS");
  assert(
    contextFirst !== -1,
    "ai-response.function.ts: the personal context composer is not called in buildEnhancedSystemPrompt"
  );
  assert(
    lengthSecond !== -1 && languageThird !== -1 && markdownLast !== -1,
    "ai-response.function.ts: response length / language / markdown instructions missing from buildEnhancedSystemPrompt"
  );
  assert(
    contextFirst !== -1 &&
      contextFirst < lengthSecond &&
      lengthSecond < languageThird &&
      languageThird < markdownLast,
    "ai-response.function.ts: composition order changed — personal context must be prepended FIRST (highest priority), then length, language, markdown"
  );
  // buildEnhancedSystemPrompt is actually invoked on the request path.
  assert(
    /buildEnhancedSystemPrompt\(/.test(ai.slice(ai.indexOf("export async function* fetchAIResponse"))),
    "ai-response.function.ts: fetchAIResponse no longer applies buildEnhancedSystemPrompt to the outgoing system prompt"
  );

  // The composer itself: gated by the enable flag, sourced from storage,
  // prepended (context first, then the base prompt).
  const storage = code(read("src/lib/storage/personal-context.storage.ts"));
  const composerAnchor = storage.indexOf("composeSystemPromptWithContext");
  const composerBody =
    composerAnchor === -1 ? "" : storage.slice(composerAnchor, storage.indexOf("};", composerAnchor) + 2);
  assert(
    /isInterviewContextEnabled\(\)/.test(composerBody),
    "personal-context.storage.ts: composeSystemPromptWithContext lost its isInterviewContextEnabled gate"
  );
  assert(
    /getPersonalContext\(\)/.test(composerBody),
    "personal-context.storage.ts: composeSystemPromptWithContext no longer reads getPersonalContext"
  );
  assert(
    /\`\$\{context\}\s*\n\s*\n\s*\$\{basePrompt\}\`/.test(composerBody),
    "personal-context.storage.ts: the context must be PREPENDED before the base prompt, not appended"
  );
}

// --- B. every request path passes a system prompt -----------------------------
{
  const chat = code(read("src/hooks/useChatCompletion.ts"));
  assert(
    /systemPrompt: systemPrompt \|\| undefined/.test(chat),
    "useChatCompletion.ts: the Ask chat request no longer passes systemPrompt to fetchAIResponse"
  );

  const completion = code(read("src/hooks/useCompletion.ts"));
  assert(
    (completion.match(/systemPrompt: promptWithKnowledge/g) ?? []).length >= 2,
    "useCompletion.ts: the Ask text and screenshot request paths must both pass promptWithKnowledge (system prompt + knowledge file)"
  );

  const listen = code(read("src/hooks/useSystemAudio.ts"));
  assert(
    /systemPrompt: promptWithKnowledge/.test(listen),
    "useSystemAudio.ts: the Listen request path no longer passes promptWithKnowledge to fetchAIResponse"
  );
}

// --- C. the Listen base prompt always has a fallback ---------------------------
{
  const listen = code(read("src/hooks/useSystemAudio.ts"));
  // All three Listen prompt builders share the same selection rule; it must
  // never produce an empty base (DEFAULT_SYSTEM_PROMPT fallback) and must
  // always route through composeListenPrompt (the channel legend).
  const selections = listen.match(
    /useSystemPrompt\s*\?\s*systemPrompt \|\| DEFAULT_SYSTEM_PROMPT\s*:\s*contextContent \|\| DEFAULT_SYSTEM_PROMPT/g
  );
  assert(
    selections !== null && selections.length >= 3,
    `useSystemAudio.ts: expected >= 3 Listen base-prompt selections with the DEFAULT fallback (room, quick action, stop-and-send/mic), found ${selections ? selections.length : 0}`
  );
  assert(
    (listen.match(/composeListenPrompt\(/g) ?? []).length >= 4,
    "useSystemAudio.ts: every Listen path must compose through composeListenPrompt (channel legend + mode preset)"
  );
  const hook = code(read("src/hooks/useSystemAudio.ts")).slice(
    listen.indexOf("const composeListenPrompt"),
    listen.indexOf("const composeListenPrompt") + 1400
  );
  assert(
    hook.includes("User:") && hook.includes("System:"),
    "useSystemAudio.ts: composeListenPrompt lost the channel legend (D1 Gap 1) — the model can no longer tell the user's words from the room's"
  );
}

if (failures.length > 0) {
  console.error(`FAIL - prompt injection invariants broken (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  "PASS - every LLM turn receives: personal context FIRST (gated by\n" +
    "       isInterviewContextEnabled), then the path's base system prompt,\n" +
    "       then Listen's channel legend/mode preset/knowledge, then the\n" +
    "       response length, language and markdown instructions. All six\n" +
    "       request sites route through the single composition point."
);
