// Turn-boundary fixture: both capture sources must finalize on the same rule.
//
// WHY THIS EXISTS
// ---------------
// Phase 4 R1 (issue #14). Two segmenters used to decide "the user stopped
// talking" on different clocks: the mic ran vad-web's default 1400 ms
// hangover, system audio ran 45 x 21.33 ms (~0.96 s). The same sentence
// therefore split at different pauses depending on where it was heard.
//
// The fix is one number with one meaning:
//   * `src/lib/turn-boundary.ts` is the TS source of truth (TURN_HANGOVER_MS);
//   * `src-tauri/src/speaker/commands.rs` carries the same constant for the
//     Rust VAD loop and derives its chunk threshold from the live sample rate;
//   * both segmenters reset the countdown when speech resumes (vad-web's
//     frame-processor zeroes `redemptionCounter`; the loop zeroes
//     `silence_chunks`).
//
// THIS SCRIPT ENFORCES
//   1. the two constants are equal and both sit above the UX contract
//      (TURN_SPLIT_UX_MS = 1500 ms - "a pause up to ~1.5 s must not split");
//   2. the mic option actually derives from the constant (no literal 1400);
//   3. the Rust loop compares against the derived threshold, not the legacy
//      `config.silence_chunks` field;
//   4. FIXTURES, two per source: a 1.2 s pause yields exactly ONE block, a
//      2.5 s pause yields exactly TWO, and a pause that is interrupted by
//      speech does not finalize early. System and mic must agree on all of
//      them - that equality is the pass condition.
//
// Run with:  node scripts/turn-boundary-check.ts

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

// ---- 1. the shared constant, mirrored across the language boundary ---------

type BoundaryModule = {
  TURN_SPLIT_UX_MS: number;
  TURN_HANGOVER_MS: number;
  MIC_FRAME_MS: number;
  micRedemptionMs: () => number;
  micRedemptionFrames: () => number;
};

let boundary: BoundaryModule | null = null;
try {
  boundary = (await import("../src/lib/turn-boundary.ts")) as BoundaryModule;
} catch {
  boundary = null;
}

const rustSource = read("src-tauri/src/speaker/commands.rs");
const rustConstant = rustSource.match(/TURN_HANGOVER_MS\s*:\s*u64\s*=\s*(\d+)/);

if (!boundary) {
  console.log("=".repeat(72));
  console.log("turn boundary - one hangover for both capture sources");
  console.log("=".repeat(72));
  console.log("\n  FAIL  1 finding(s):");
  console.log("        src/lib/turn-boundary.ts - missing: the shared boundary module does not exist");
  process.exit(1);
}

const {
  TURN_SPLIT_UX_MS,
  TURN_HANGOVER_MS,
  MIC_FRAME_MS,
  micRedemptionMs,
  micRedemptionFrames,
} = boundary;

// Reference the derived millisecond value so a broken derivation is not
// silently ignored by the report below.
const micRedemptionMsValue = micRedemptionMs();

if (!(TURN_HANGOVER_MS > TURN_SPLIT_UX_MS)) {
  fail(
    "src/lib/turn-boundary.ts",
    `TURN_HANGOVER_MS (${TURN_HANGOVER_MS}) must exceed the UX contract (${TURN_SPLIT_UX_MS} ms)`
  );
}

if (!rustConstant) {
  fail(
    "src-tauri/src/speaker/commands.rs",
    "missing: TURN_HANGOVER_MS constant for the Rust segmenter"
  );
} else if (Number(rustConstant[1]) !== TURN_HANGOVER_MS) {
  fail(
    "src-tauri/src/speaker/commands.rs",
    `TURN_HANGOVER_MS is ${rustConstant[1]}, TS says ${TURN_HANGOVER_MS} - the sources would split turns at different pauses`
  );
}

// ---- 2. the sources actually use the constant ------------------------------

const voiceInput = read("src/hooks/useVoiceInput.ts");
if (!/redemptionMs\s*:\s*micRedemptionMs\(\)/.test(voiceInput)) {
  fail(
    "src/hooks/useVoiceInput.ts",
    "missing: redemptionMs: micRedemptionMs() on the MicVAD options"
  );
}
if (/redemptionMs\s*:\s*\d+/.test(voiceInput)) {
  fail("src/hooks/useVoiceInput.ts", "a literal redemptionMs sits next to the derived one");
}

if (!/silence_chunks\s*>=\s*silence_needed/.test(rustSource)) {
  fail(
    "src-tauri/src/speaker/commands.rs",
    "the loop must compare against the derived `silence_needed`, not config.silence_chunks"
  );
}
if (!/fn\s+silence_chunks_for/.test(rustSource) || !/fn\s+next_silence_count/.test(rustSource)) {
  fail(
    "src-tauri/src/speaker/commands.rs",
    "missing the derived-threshold helper (silence_chunks_for) or the resettable counter (next_silence_count)"
  );
}

// ---- 3. fixtures: two per source, and the sources must agree ----------------

/**
 * The shared rule, expressed once for both sources: a block ends when the
 * trailing-silence counter reaches the threshold; any speech resets it.
 * Timelines are (speechMs, silenceMs) pairs, applied in order; the last pair's
 * silence is the long trailing silence that closes the recording.
 */
const simulate = (
  chunkMs: number,
  hangoverMs: number,
  timeline: Array<[number, number]>
): number => {
  const needed = Math.ceil(hangoverMs / chunkMs);
  let blocks = 0;
  let inSpeech = false;
  let silence = 0;
  for (const [speechMs, silenceMs] of timeline) {
    if (Math.round(speechMs / chunkMs) >= 1) {
      // Speech resumes: the hangover restarts, and the segmenter is live again.
      inSpeech = true;
      silence = 0;
    }
    const silenceChunks = Math.round(silenceMs / chunkMs);
    for (let i = 0; i < silenceChunks && inSpeech; i++) {
      silence += 1;
      if (silence >= needed) {
        blocks += 1;
        // Mirrors the loop: a finalized turn is no longer in speech.
        inSpeech = false;
        silence = 0;
      }
    }
  }
  return blocks;
};

const systemChunkMs = (1024 / 48000) * 1000; // hop 1024 @ 48 kHz, the common WASAPI rate
const micChunkMs = MIC_FRAME_MS;
const micHangoverMs = micRedemptionFrames() * micChunkMs;

if (micHangoverMs < TURN_HANGOVER_MS) {
  fail(
    "src/lib/turn-boundary.ts",
    `the mic resolves to ${micHangoverMs} ms of hangover, below TURN_HANGOVER_MS (${TURN_HANGOVER_MS})`
  );
}

const FIXTURES: Array<{ name: string; timeline: Array<[number, number]>; expected: number }> = [
  {
    name: "a 1.2 s pause does not split (ONE block)",
    timeline: [[2000, 1200], [2000, 30000]],
    expected: 1,
  },
  {
    name: "a 2.5 s pause splits (TWO blocks)",
    timeline: [[2000, 2500], [2000, 30000]],
    expected: 2,
  },
  {
    name: "speech inside the window cancels the finalize (ONE block)",
    timeline: [[2000, 1900], [400, 30000]],
    expected: 1,
  },
  {
    name: "after the cancel, a full pause still splits (TWO blocks)",
    timeline: [[2000, 1900], [400, 2100], [2000, 30000]],
    expected: 2,
  },
];

const systemResults: number[] = [];
const micResults: number[] = [];

for (const f of FIXTURES) {
  const system = simulate(systemChunkMs, TURN_HANGOVER_MS, f.timeline);
  const mic = simulate(micChunkMs, micHangoverMs, f.timeline);
  systemResults.push(system);
  micResults.push(mic);
  if (system !== f.expected) {
    fail("system segmenter (Rust rule)", `${f.name}: got ${system} block(s), expected ${f.expected}`);
  }
  if (mic !== f.expected) {
    fail("mic segmenter (vad-web rule)", `${f.name}: got ${mic} block(s), expected ${f.expected}`);
  }
}

const agree = systemResults.every((n, i) => n === micResults[i]);

// ---- report ----------------------------------------------------------------

console.log("=".repeat(72));
console.log("turn boundary - one hangover for both capture sources");
console.log("=".repeat(72));
console.log(
  `\n  UX contract: pauses up to ${TURN_SPLIT_UX_MS} ms must not split a turn` +
    `\n  hangover:    TS/Rust ${TURN_HANGOVER_MS} ms | mic ${micRedemptionFrames()} frames` +
    ` (${micRedemptionMsValue} ms requested, ${micHangoverMs} ms effective)` +
    `\n               system ${Math.ceil(TURN_HANGOVER_MS / systemChunkMs)} chunks` +
    ` (~${(Math.ceil(TURN_HANGOVER_MS / systemChunkMs) * systemChunkMs).toFixed(0)} ms @48k)\n`
);

for (let i = 0; i < FIXTURES.length; i++) {
  const ok = systemResults[i] === FIXTURES[i].expected && micResults[i] === FIXTURES[i].expected;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  system=${systemResults[i]} mic=${micResults[i]}  ${FIXTURES[i].name}`
  );
}

console.log("\n" + "=".repeat(72));
if (failures.length === 0 && agree) {
  console.log("PASS - both sources finalize identically on every fixture.");
  process.exit(0);
}
if (!agree) {
  console.log("FAIL - the two sources disagree on at least one fixture.");
}
console.log(`FAIL - ${failures.length} finding(s):`);
for (const f of failures) console.log(`  ${f.where}  ${f.problem}`);
process.exit(1);

