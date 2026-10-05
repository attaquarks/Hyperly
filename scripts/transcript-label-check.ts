// Honest transcript labelling (Phase 4 R8, issue #20).
//
// WHY THIS EXISTS
// ---------------
// A transcript row carried `speaker: string`, filled with "User" or "Speaker"
// purely from the capture source — and the orphan-restore path derived the label
// from `event.source` the same way (P1-6, P2A ISSUE-6, P3 §9.5). The field name and
// the value both claimed an identity the app never establishes: there is no
// diarization, no embedding, no clustering, and by design there will not be (Glass
// stops at Me/Them too). Room audio from several people was labelled as one known
// person, and the microphone path was labelled as if the wearer were "User".
//
// A second honesty defect belongs to this item: the utterance the microphone path
// sent to the model carried the tag `User (microphone): ...`, and the SAME string
// was stored as the conversation's user message — so a prompt-only tag ended up in
// the persisted record.
//
// WHAT R8 CHANGES
// ---------------
//   * the row records `source` (the channel) plus an optional `speakerLabel` that
//     is only set when identity is genuinely known (never, today);
//   * the UI labels the channel through `@/lib/transcript-label` and never invents
//     a person from the channel;
//   * the model still gets its source tag, but only as the request input; the
//     stored message stays the plain transcript;
//   * echo cancellation is MEASURED from the track's own settings instead of being
//     requested and assumed.
//
// THIS SCRIPT asserts:
//   A. the labels name the channel, a real speaker label wins only when present,
//      and no channel maps to a person-like name; the model tag exists but is the
//      model's alone;
//   B. the AEC report tells the truth: a denied or absent setting stays false /
//      undefined rather than being presented as working;
//   C. structurally: the old `speaker` field is gone from the type and the
//      builders, the UI renders through the helper, the restore path infers no
//      identity, the tag cannot reach the persisted record, R3's `source` /
//      `speaker_label` independence stands, and no diarization crept in.
//
// Run with:  node --experimental-strip-types scripts/transcript-label-check.ts

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
console.log("honest transcript labelling - channel, not identity (Phase 4 R8)");
console.log("=".repeat(72));

const segmentTypeSource = code(read("src/types/system-audio.ts"));
const systemAudioSource = code(read("src/hooks/useSystemAudio.ts"));
const threadSource = code(
  read("src/pages/app/components/speech/TranscriptThread.tsx")
);
const microphoneSource = code(read("src/lib/microphone.ts"));
const storeSource = code(read("src/lib/transcript-store.ts"));
const labelSource = read("src/lib/transcript-label.ts");

type LabelFn = (segment: {
  source: "microphone" | "system";
  speakerLabel?: string | null;
}) => string;

let transcriptLabel: LabelFn | null = null;
let sourceLabel: ((source: "microphone" | "system") => string) | null = null;
let modelTag: ((source: "microphone" | "system", text: string) => string) | null =
  null;
let appliedProcessing:
  | ((settings: unknown) => {
      echoCancellation?: boolean;
      autoGainControl?: boolean;
      noiseSuppression?: boolean;
      channelCount?: number;
    })
  | null = null;

try {
  const mod: any = await import("../src/lib/transcript-label.ts");
  if (
    typeof mod.transcriptLabel !== "function" ||
    typeof mod.transcriptSourceLabel !== "function" ||
    typeof mod.modelSourceTag !== "function"
  ) {
    throw new Error(
      "transcript-label.ts must export transcriptLabel, transcriptSourceLabel and modelSourceTag"
    );
  }
  transcriptLabel = mod.transcriptLabel;
  sourceLabel = mod.transcriptSourceLabel;
  modelTag = mod.modelSourceTag;
} catch (error) {
  fail(
    "the label helpers run",
    error instanceof Error ? error.message : String(error)
  );
}
try {
  const mod: any = await import("../src/lib/microphone.ts");
  if (typeof mod.appliedProcessing !== "function") {
    throw new Error("microphone.ts must export appliedProcessing");
  }
  appliedProcessing = mod.appliedProcessing;
} catch (error) {
  fail(
    "the processing report runs",
    error instanceof Error ? error.message : String(error)
  );
}

// ---- A. the labels ---------------------------------------------------------

console.log("\nA. the labels");

if (transcriptLabel && sourceLabel && modelTag) {
  const label = transcriptLabel;
  const source = sourceLabel;
  const tag = modelTag;

  check(
    "the channels are labelled as channels",
    source("microphone") === "User" && source("system") === "System",
    () => `mic=${source("microphone")} system=${source("system")}`
  );

  check(
    "no channel is labelled with anything but the two product labels",
    ["User", "System"].includes(source("microphone")) &&
      ["User", "System"].includes(source("system")) &&
      source("microphone") !== source("system"),
    () => `mic=${source("microphone")} system=${source("system")}`
  );

  check(
    "a row with no known speaker shows the channel",
    label({ source: "microphone" }) === "User" &&
      label({ source: "system" }) === "System",
    () =>
      JSON.stringify([
        label({ source: "microphone" }),
        label({ source: "system" }),
      ])
  );

  check(
    "a real speaker label is used ONLY when it is actually known",
    label({ source: "system", speakerLabel: "Dana" }) === "Dana" &&
      label({ source: "system", speakerLabel: "   " }) === "System" &&
      label({ source: "system", speakerLabel: null }) === "System" &&
      label({ source: "system", speakerLabel: "" }) === "System",
    () =>
      JSON.stringify([
        label({ source: "system", speakerLabel: "Dana" }),
        label({ source: "system", speakerLabel: "   " }),
        label({ source: "system", speakerLabel: null }),
      ])
  );

  check(
    "the model gets both channels labelled, never a bare room line",
    tag("microphone", "hello") === "User: hello" &&
      tag("system", "hello") === "System: hello",
    () =>
      JSON.stringify([tag("microphone", "hello"), tag("system", "hello")])
  );
}

// ---- B. what the microphone actually got -----------------------------------

console.log("\nB. what the microphone actually got");

if (appliedProcessing) {
  const report = appliedProcessing;
  const denied = report({
    echoCancellation: false,
    autoGainControl: true,
    noiseSuppression: false,
    channelCount: 1,
  });
  check(
    "a DENIED setting stays denied (nothing claims echo cancellation worked)",
    denied.echoCancellation === false &&
      denied.autoGainControl === true &&
      denied.noiseSuppression === false &&
      denied.channelCount === 1,
    () => JSON.stringify(denied)
  );

  const absent = report({});
  check(
    "an absent setting stays unknown rather than being assumed on",
    absent.echoCancellation === undefined &&
      absent.autoGainControl === undefined &&
      absent.noiseSuppression === undefined,
    () => JSON.stringify(absent)
  );

  const noSettings = report(undefined);
  check(
    "no settings at all reports nothing, not a default",
    Object.values(noSettings).every((value) => value === undefined),
    () => JSON.stringify(noSettings)
  );
}

// ---- C. structural ---------------------------------------------------------

console.log("\nC. structural");

check(
  "the segment type names the channel and a nullable speaker label",
  /source: TranscriptSource/.test(segmentTypeSource) &&
    /speakerLabel\?: string \| null/.test(segmentTypeSource) &&
    !/\bspeaker: string/.test(segmentTypeSource),
  () => "TranscriptSegment still carries a source-derived `speaker` string"
);

const speakerLabelSites = count(systemAudioSource, /speaker:\s*"/);
check(
  "no transcript row is built with a source-derived label",
  speakerLabelSites === 0 &&
    count(systemAudioSource, /source: "system"/) >= 2 &&
    count(systemAudioSource, /source: "microphone"/) >= 1,
  () => `source-derived label sites=${speakerLabelSites}`
);

check(
  "the restore path carries the stored label instead of inferring one",
  /source: event\.source/.test(systemAudioSource) &&
    /speakerLabel: event\.speaker_label/.test(systemAudioSource) &&
    !/speaker: event\.source/.test(systemAudioSource),
  () => "the orphan restore still derives a label from the source"
);

check(
  "the UI renders through the label helper, never the raw field",
  /transcriptLabel\(segment\)/.test(threadSource) &&
    !/segment\.speaker/.test(threadSource) &&
    /transcriptSourceLabel\("microphone"\)/.test(threadSource),
  () => "TranscriptThread still renders segment.speaker"
);

check(
  "the model tag cannot reach the persisted record",
  /modelSourceTag\(/.test(systemAudioSource) &&
    /userMessage: modelInput \?\? transcription/.test(systemAudioSource) &&
    /content: transcription/.test(systemAudioSource) &&
    !/processWithAI\(\s*`User \(microphone\)/.test(systemAudioSource),
  () => "the tagged utterance is still passed as the stored transcription"
);

/**
 * D1 Gap 1, the half that shipped unfixed. Every `processWithAI` call site must
 * pass the 4th argument (`modelInput`), because that argument IS the label: omit
 * it and `userMessage: modelInput ?? transcription` silently falls back to the
 * BARE transcript, and the model can no longer tell the user's own words from
 * the room. PR #41 tagged the two auto-send call sites and left `stopAndSend`
 * and the quick-action path untagged, so the original defect survived in Manual
 * mode — the mode the feature is actually used in.
 *
 * Counted by extracting each call's balanced argument list, not by matching
 * `processWithAI(` alone: the argument text has to be inspected, because a call
 * with the tag in the wrong position is still unlabelled.
 */
const processWithAICalls = (source: string): string[] => {
  const calls: string[] = [];
  const marker = /processWithAI\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source)) !== null) {
    // The declaration `const processWithAI = useCallback(` is not a call site.
    const before = source.slice(Math.max(0, match.index - 60), match.index);
    if (/\bconst\s+$/.test(before)) continue;
    const open = match.index + match[0].length;
    let depth = 1;
    let i = open;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    calls.push(source.slice(open, i - 1));
    marker.lastIndex = i;
  }
  return calls;
};

/** Split an argument list on commas that are not nested in brackets or strings. */
const topLevelArgs = (args: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      current += ch;
      if (ch === quote && args[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
};

const aiCalls = processWithAICalls(systemAudioSource);
const untagged = aiCalls.filter(
  (args) => !/modelSourceTag\s*\(/.test(topLevelArgs(args)[3] ?? "")
);

check(
  `every processWithAI call passes a source tag (${aiCalls.length} call sites)`,
  aiCalls.length >= 4 && untagged.length === 0,
  () =>
    `${untagged.length} call site(s) omit the 4th modelInput argument, so the ` +
    `model receives the BARE transcript and cannot tell User from System:\n` +
    untagged
      .map((a) => `          processWithAI(${a.trim().replace(/\s+/g, " ").slice(0, 88)}...)`)
      .join("\n")
);

check(
  "echo cancellation is measured, not claimed",
  /appliedProcessing\(/.test(microphoneSource) &&
    count(microphoneSource, /reporting\(/) >= 3 &&
    // The doc phrase is a comment, so it must be read from the raw text.
    /They are not guarantees/.test(read("src/lib/microphone.ts")),
  () => "microphone.ts still presents the requested processing as applied"
);

check(
  "R3's source / speaker_label independence stands",
  /source: SpeechSource/.test(storeSource) &&
    /speaker_label: string \| null/.test(storeSource),
  () => "the transcript store no longer keeps source and speaker_label separate"
);

check(
  "no diarization crept in (the explicit non-goal)",
  !/embedding|diariz|cluster/i.test(code(labelSource)) &&
    !/embedding|diariz|cluster/i.test(threadSource),
  () => "a diarization/embedding path appeared"
);

// ---- report ----------------------------------------------------------------

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log(
    "PASS - transcript rows name the capture channel and never invent a speaker,\n" +
      "       the model's source tag stays out of the persisted record, and the\n" +
      "       microphone's echo handling is measured rather than claimed."
  );
  process.exit(0);
}
console.log(`FAIL - ${failures.length} check(s) failed:`);
for (const f of failures) console.log(`  ${f.name}\n    ${f.problem}`);
process.exit(1);
