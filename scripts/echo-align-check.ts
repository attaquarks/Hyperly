// Round transcript + sub-segment echo cancellation guard.
//
// WHY THIS EXISTS
// ---------------
// The user's Listen contract (2026-11-18): ONE capture round = Start → Stop.
// Its transcript displays as ONE System block (every room utterance stacked
// under the same label, pauses included) and ONE User block; the Stop trip
// carries exactly one labelled System block and one labelled User block —
// never one turn per utterance, never a mixed blob under a single label.
// The mic's words are echoed room audio more often than not (the neural AEC
// leaves residue), so they are validated by the SUB-SEGMENT echo strip
// BEFORE display: matching spans dropped, novel words kept with their
// original casing, fully-echoed utterances dropped entirely. A regression
// here shows room audio under the User label or splits the round into a
// dozen turns — neither has a build-time failure signal without this guard.
//
// THIS SCRIPT ENFORCES
//   1. the strip algorithm's fixtures: full echo → dropped; partial echo →
//      only the novel words (original casing); disjoint → everything; echo
//      interleaved across multiple system utterances; reordered room words;
//      empty input;
//   2. the mic path runs stripEcho and displays ONLY its kept text — never
//      the raw transcript, never the raw token join;
//   3. the round trip is composite: stopAndSend folds the triggering
//      utterance into its channel's accumulator, clears BOTH, and dispatches
//      a System-block + User-block composite as both modelInput and the
//      stored content;
//   4. per-channel accumulators exist and the mixed single pending blob is
//      gone;
//   5. the thread renders the two-block round (one System block, one User
//      block) and never renders the raw mic partial.
//
// Run with:  node scripts/echo-align-check.ts

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Failure = { where: string; problem: string };
const failures: Failure[] = [];

const read = (relPath: string): string => {
  try {
    return readFileSync(join(ROOT, relPath), "utf8");
  } catch {
    return "";
  }
};

const fail = (where: string, problem: string): void => {
  failures.push({ where, problem });
};

const expect = (cond: boolean, where: string, what: string): void => {
  if (!cond) fail(where, what);
};

// ---------------------------------------------------------------------------
// 1. The strip algorithm, against real fixtures.
// ---------------------------------------------------------------------------
const { stripEcho } = await import(
  "file://" + join(ROOT, "src/lib/echo-align.ts")
);

{
  const r = stripEcho("The team agreed to ship on Friday.", [
    "the team agreed to ship on friday",
  ]);
  expect(
    r.fullyEchoed && r.keptText === "",
    "echo-align full echo",
    "a mic transcript identical to the room's words must be dropped entirely"
  );
}
{
  const r = stripEcho(
    "The team agreed to ship on Friday, but I disagree with the timeline.",
    ["the team agreed to ship on friday"]
  );
  expect(
    !r.fullyEchoed && /disagree with the timeline/i.test(r.keptText) &&
      !/ship on friday/i.test(r.keptText),
    "echo-align partial echo",
    `the echoed span must be dropped and the novel words kept with their ` +
      `casing (got kept=${JSON.stringify(r.keptText)})`
  );
}
{
  const r = stripEcho("My action item is the deploy script.", [
    "the team agreed to ship on friday",
  ]);
  expect(
    !r.fullyEchoed && /deploy script/i.test(r.keptText),
    "echo-align disjoint",
    "a mic transcript with nothing in common must be kept whole"
  );
}
{
  const r = stripEcho(
    "Sure, the budget is frozen, and please email me the deck.",
    ["the budget is frozen for q3", "can everyone see my screen"]
  );
  expect(
    !r.fullyEchoed && /email me the deck/i.test(r.keptText) &&
      !/budget is frozen/i.test(r.keptText),
    "echo-align multi-source",
    "echo interleaved across several system utterances must strip all spans"
  );
}
{
  const r = stripEcho("ship on friday the team agreed", [
    "the team agreed to ship on friday",
  ]);
  expect(
    r.fullyEchoed,
    "echo-align reordered words",
    "the room's words in a different order are still echo and must drop"
  );
}
{
  const r = stripEcho("   ", ["anything"]);
  expect(r.fullyEchoed, "echo-align empty", "empty mic text must drop");
}
{
  const r = stripEcho("short", ["a completely different and much longer sentence"]);
  expect(
    !r.fullyEchoed && r.keptText === "short",
    "echo-align short utterance",
    "a short genuine utterance must survive against a long room text"
  );
}

// ---------------------------------------------------------------------------
// 2. The mic path: strip BEFORE display, kept text only.
// ---------------------------------------------------------------------------
const hook = read("src/hooks/useSystemAudio.ts");
expect(
  /import \{ stripEcho \} from "@\/lib\/echo-align"/.test(hook),
  "useSystemAudio",
  "the hook must import the sub-segment echo strip"
);
expect(
  /const strip = stripEcho\(transcript, systemTexts\)/.test(hook) &&
    /if \(strip\.fullyEchoed\)/.test(hook) &&
    /const kept = strip\.keptText/.test(hook),
  "useSystemAudio submitUserUtterance",
  "the mic transcript must be stripped and only its kept text may proceed"
);
expect(
  !/pushUserSegment\(transcript\)/.test(hook),
  "useSystemAudio submitUserUtterance",
  "the RAW mic transcript must never reach the transcript display"
);
expect(
  /micConfirmedRef\.current = \{ atSeconds: echo\.atSeconds, text: transcript \}/.test(
    hook
  ),
  "useSystemAudio submitUserUtterance",
  "a fully-echoed utterance whose match was the room's live partial must " +
    "still record the mic confirmation (the retag path)"
);

// ---------------------------------------------------------------------------
// 3. The composite round trip.
// ---------------------------------------------------------------------------
expect(
  /pendingSystemRef\.current = pendingSystemRef\.current/.test(hook) &&
    /pendingUserRef\.current = pendingUserRef\.current/.test(hook),
  "useSystemAudio stopAndSend",
  "the triggering utterance must fold into ITS channel's accumulator"
);
expect(
  /pendingSystemRef\.current = "";\s*\n\s*pendingUserRef\.current = "";/.test(
    hook
  ),
  "useSystemAudio stopAndSend",
  "both accumulators must clear once the composite is built"
);
expect(
  /const composite = \[\s*\n\s*systemText \? `System: \$\{systemText\}` : "",\s*\n\s*userText \? `User: \$\{userText\}` : "",/.test(
    hook
  ),
  "useSystemAudio stopAndSend",
  "the round trip must compose labelled System and User blocks"
);
expect(
  /modelSourceTag\("microphone", plan\.text\),\s*\n\s*"microphone"/.test(hook) &&
    /modelSourceTag\(modelSource, plan\.text\),\s*\n\s*modelSource/.test(hook) &&
    /composite,\s*\n\s*source,\s*\n\s*composite/.test(hook),
  "useSystemAudio dispatch points",
  "every dispatch must pass its label (modelInput) AND the stored content " +
    "(composite for the round trip: modelInput, source, storedContent)"
);

// ---------------------------------------------------------------------------
// 4. Per-channel accumulators; the mixed blob is gone.
// ---------------------------------------------------------------------------
expect(
  /const pendingSystemRef = useRef<string>\(""\)/.test(hook) &&
    /const pendingUserRef = useRef<string>\(""\)/.test(hook),
  "useSystemAudio refs",
  "the round model needs per-channel accumulators"
);
expect(
  !/pendingTranscriptRef/.test(hook),
  "useSystemAudio refs",
  "the old mixed pending blob must not survive (it sent one label for " +
    "two speakers)"
);

// ---------------------------------------------------------------------------
// 5. The thread renders the two-block round; the raw mic partial is gone.
// ---------------------------------------------------------------------------
const thread = read("src/pages/app/components/speech/TranscriptThread.tsx");
expect(
  /hyperly-transcript-block-user/.test(thread) &&
    /segment\.source === "microphone"/.test(thread),
  "TranscriptThread",
  "the thread must render a dedicated User block for mic words"
);
expect(
  /hyperly-transcript-block/.test(thread) &&
    /systemSegments\.map/.test(thread),
  "TranscriptThread",
  "the thread must render ONE System block stacking the round's utterances"
);
expect(
  !/\{userPartial\}/.test(thread),
  "TranscriptThread",
  "the raw mic partial must never render (echo strip runs before display)"
);

// ---------------------------------------------------------------------------
// 6. TURN-SCOPED ROUNDS: a dispatch or a fresh Start closes the round, so
//    Stop → Start visibly begins new blocks instead of appending into the old
//    ones forever.
// ---------------------------------------------------------------------------
expect(
  /roundId: number/.test(read("src/types/system-audio.ts")),
  "TranscriptSegment",
  "segments must carry the round they belong to"
);
expect(
  /roundId: roundRef\.current/.test(hook) &&
    /roundRef\.current \+= 1/.test(hook) &&
    /roundRef\.current = 1;/.test(hook),
  "useSystemAudio rounds",
  "every append must stamp the round, and dispatches + a fresh Start must " +
    "close/open rounds"
);
expect(
  /rounds\.map\(\(round\) =>/.test(thread),
  "TranscriptThread",
  "the thread must render one block pair PER round"
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`echo-align-check: ${failures.length} failure(s):`);
  for (const f of failures) {
    console.error(`  ✗ [${f.where}] ${f.problem}`);
  }
  process.exit(1);
}
console.log("echo-align-check: round transcript + sub-segment echo invariants hold");
