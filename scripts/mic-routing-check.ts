// Checks the routing decisions submitUserUtterance makes, using the app's real
// planUtterance. Run: node --experimental-strip-types scripts/mic-routing-check.ts

import {
  planUtterance,
  looksLikeQuestion,
} from "../src/lib/response-policy.ts";
import { modelSourceTag } from "../src/lib/transcript-label.ts";
import { isMicEchoOfSystem } from "../src/lib/mic-echo-dedup.ts";

type Behavior = "auto" | "manual" | "questions";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok   " : "FAIL "} ${label}${detail ? ` (${detail})` : ""}`);
};

// --- What the mic utterance does in each Listen mode -------------------------
// Mirrors submitUserUtterance: it plans, then only calls processWithAI on
// "send"/"stop-and-send". "hold" must reach the LLM on nothing.
{
  const b: Behavior = "auto";
  const p = planUtterance(b, "summarise the standup", "", false);
  check("auto: statement is sent immediately", p.kind === "send", p.kind);
}
{
  const b: Behavior = "manual";
  const p = planUtterance(b, "first point", "", false);
  check("manual: statement is held, not sent", p.kind === "hold", p.kind);
  // A later, different utterance arrives and the user presses stop: the held
  // line and the new one are flushed together, each appearing exactly once.
  const q = planUtterance(b, "second point", p.pending, true);
  check(
    "manual: stop flushes held + new text, each once",
    q.kind === "stop-and-send" &&
      q.text === "first point second point",
    `${q.kind} "${q.text}"`
  );
}
{
  const b: Behavior = "questions";
  const s = planUtterance(b, "the build is red", "", false);
  check("questions: a statement is held", s.kind === "hold", s.kind);
  const q = planUtterance(b, "how do I fix it", "", false);
  check("questions: a question is sent", q.kind === "send", q.kind);
}
{
  // A held manual stretch must ride along with the next auto utterance, and the
  // mic path shares this buffer, so a held mic line flushes with a speaker line.
  const b: Behavior = "auto";
  const p = planUtterance(b, "and what about staging", "my earlier question", false);
  check(
    "auto: held text rides along with the next send",
    p.kind === "send" &&
      p.text.includes("my earlier question") &&
      p.text.includes("staging"),
    p.kind === "send" ? p.text : p.kind
  );
}

// --- Question detection used by the questions gate ---------------------------
{
  check("question: trailing mark", looksLikeQuestion("is this ready?"));
  check("question: opener without a mark", looksLikeQuestion("how do I deploy"));
  check("statement: not a question", !looksLikeQuestion("we shipped on friday"));
}

// --- Speaker labelling -------------------------------------------------------
// Both channels carry their label into the text handed to the model, and the
// two labels differ — that is what keeps User and System distinguishable.
// The stored record keeps the plain text; the tag is prompt-only (R8).
{
  const mic = modelSourceTag("microphone", "what did they decide about pricing");
  const room = modelSourceTag("system", "the team agreed to ship on friday");
  check(
    "mic text carries the User label",
    mic === "User: what did they decide about pricing"
  );
  check(
    "room text carries the System label, never bare",
    room === "System: the team agreed to ship on friday"
  );
  const both = `Previous: ${room}\nNow: ${mic}`;
  check(
    "a mixed turn keeps both distinguishable",
    both.includes("User:") &&
      both.includes("System:") &&
      !room.startsWith("User:")
  );
}

// --- The questions gate is channel-aware (D1 Gap 2) --------------------------
// Only `source === "system"` utterances may trigger the AI in questions
// mode: a question-shaped MIC utterance is held, never sent.
{
  const b: Behavior = "questions";
  const micQ = planUtterance(b, "can you explain that", "", false, "microphone");
  check("questions: a mic question is held, not answered", micQ.kind === "hold", micQ.kind);
  const roomQ = planUtterance(b, "can you explain that", "", false, "system");
  check("questions: the same words from the room are sent", roomQ.kind === "send", roomQ.kind);
  const roomS = planUtterance(b, "the build is red", "", false, "system");
  check("questions: a room statement is still held", roomS.kind === "hold", roomS.kind);
}

// --- Mic-echo dedup (D1 Gap 3, dedup half) ------------------------------------
// A mic utterance that closely matches a recent system utterance is bleed-
// through (WebView2 denied echoCancellation) and is suppressed; genuinely
// new mic speech and stale matches pass through.
{
  const history = [{ atSeconds: 100, text: "the team agreed to ship on friday" }];
  check(
    "an echo of the room is suppressed",
    isMicEchoOfSystem("the team agreed to ship on friday", history, 103)
  );
  check(
    "genuinely new mic speech passes through",
    !isMicEchoOfSystem("my action item is the deploy script", history, 103)
  );
  check(
    "a stale match outside the window passes through",
    !isMicEchoOfSystem("the team agreed to ship on friday", history, 200)
  );
  check(
    "an empty mic utterance is not an echo",
    !isMicEchoOfSystem("   ", history, 103)
  );
}

console.log("");
console.log(failures === 0 ? "PASS" : `FAIL - ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
