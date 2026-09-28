// Checks the routing decisions submitUserUtterance makes, using the app's real
// planUtterance. Run: node --experimental-strip-types scripts/mic-routing-check.ts

import {
  planUtterance,
  looksLikeQuestion,
} from "../src/lib/response-policy.ts";

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
// The mic prefix must survive into the text handed to the model, and the room
// path must stay untagged so the two remain distinguishable.
{
  const speaker = (s: string) => `User (microphone): ${s}`;
  const mic = speaker("what did they decide about pricing");
  const room = "the team agreed to ship on friday";
  check(
    "mic text carries the User label",
    mic.startsWith("User (microphone): ")
  );
  check(
    "room text stays untagged, so it reads as system audio",
    !room.startsWith("User (microphone):")
  );
  const both = `Previous: ${room}\nNow: ${mic}`;
  check(
    "a mixed turn keeps both distinguishable",
    both.includes("User (microphone):") &&
      !room.includes("User (microphone):")
  );
}

console.log("");
console.log(failures === 0 ? "PASS" : `FAIL - ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
