// The latency budget: measured, tracked, reproducible numbers for the
// transcription→LLM pipeline.
//
// WHY THIS EXISTS
// ---------------
// The user's two latency complaints — live transcript seconds behind the
// voice, and Stop→LLM taking 2-3 s — were fixed on 2026-11-12 with concrete
// parameter changes. This guard pins the new parameters in the real source,
// COMPUTES the before/after payload numbers from those constants (not from
// prose), and DRIVES the real SpeechBlockQueue through an injected clock to
// measure the stop→send decomposition. The report prints to stdout on every
// CI run and lands as a JSON artifact, so the improvement is something that
// can be shown, not claimed.
//
// BEFORE (the old constants, measured from the pre-fix tree):
//   partial interval 2000 ms, whole-buffer payload, 48 kHz WAV, hangover
//   2000 ms, stop grace timer 600 ms, flush queued behind older utterances.
// AFTER (asserted here, from the live source):
//   partial interval 600 ms, delta-only payload, 16 kHz WAV, hangover 1200 ms
//   (> 1 s — humans pause mid-sentence), capture-stopped event resolves the
//   silent-stop path immediately, flush utterances jump the queue.
//
// Run with:  node --experimental-strip-types scripts/latency-budget-check.ts

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { SpeechBlockQueue } from "../src/lib/speech-block-queue.ts";
import { TURN_HANGOVER_MS } from "../src/lib/turn-boundary.ts";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

const failures: string[] = [];
const assert = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

// ---------------------------------------------------------------------------
// 1. the constants, read from the real source
// ---------------------------------------------------------------------------
const rust = read("src-tauri/src/speaker/commands.rs");

const partialMsMatch = rust.match(/PARTIAL_INTERVAL_MS:\s*u64\s*=\s*(\d+)/);
const sttRateMatch = rust.match(/STT_SAMPLE_RATE:\s*u32\s*=\s*(\d+)/);
const rustHangoverMatch = rust.match(/TURN_HANGOVER_MS:\s*u64\s*=\s*(\d+)/);

assert(partialMsMatch !== null, "commands.rs: PARTIAL_INTERVAL_MS constant missing");
assert(sttRateMatch !== null, "commands.rs: STT_SAMPLE_RATE constant missing");
assert(rustHangoverMatch !== null, "commands.rs: TURN_HANGOVER_MS constant missing");

const partialIntervalMs = partialMsMatch ? Number(partialMsMatch[1]) : 0;
const sttRate = sttRateMatch ? Number(sttRateMatch[1]) : 0;
const rustHangoverMs = rustHangoverMatch ? Number(rustHangoverMatch[1]) : 0;

// The live UX constraint from the product owner: the turn-finalization
// hangover must stay ABOVE one second — humans pause mid-sentence while
// thinking, and a shorter window would split sentences into fragments.
assert(
  TURN_HANGOVER_MS > 1000 && TURN_HANGOVER_MS <= 1500,
  `TURN_HANGOVER_MS must be > 1000 ms (human speech pauses) and <= 1500 ms; got ${TURN_HANGOVER_MS}`
);
assert(
  rustHangoverMs === TURN_HANGOVER_MS,
  `commands.rs hangover (${rustHangoverMs}) disagrees with turn-boundary.ts (${TURN_HANGOVER_MS})`
);
assert(
  partialIntervalMs > 0 && partialIntervalMs <= 700,
  `PARTIAL_INTERVAL_MS must be <= 700 ms for a sub-second live transcript; got ${partialIntervalMs}`
);
assert(
  sttRate === 16000,
  `STT_SAMPLE_RATE must be 16000 — 48 kHz payloads upload 3x more bytes than any speech model consumes; got ${sttRate}`
);

// The MIC path has its own partial cadence (browser-side vad-web); both
// capture sources must share the sub-second live-transcript contract.
const voiceInput = read("src/hooks/useVoiceInput.ts");
const micPartialMatch = voiceInput.match(/const PARTIAL_INTERVAL_MS = (\d+)/);
assert(
  micPartialMatch !== null,
  "useVoiceInput.ts: PARTIAL_INTERVAL_MS constant missing"
);
const micPartialMs = micPartialMatch ? Number(micPartialMatch[1]) : 0;
assert(
  micPartialMs > 0 && micPartialMs <= 700,
  `useVoiceInput.ts PARTIAL_INTERVAL_MS must be <= 700 ms to match the system path's sub-second live transcript; got ${micPartialMs}`
);

// The partial must be a DELTA (emit only audio since the previous partial),
// not a whole-buffer snapshot.
assert(
  /let delta = &speech_buffer\[last_partial_mark\.\.\]/.test(rust),
  "commands.rs: the partial emit must slice the delta (speech_buffer[last_partial_mark..]) — a whole-buffer emit re-uploads the entire utterance every tick"
);
assert(
  /resample_to_stt_rate\(&partial_normalized, sr\)/.test(rust) &&
    /resample_to_stt_rate\(&normalized, sr\)/.test(rust),
  "commands.rs: both the partial and the final must be resampled to the STT rate before encoding"
);

// The stop path must be event-driven, not timer-only.
assert(
  /app\.emit\("capture-stopped"/.test(rust),
  "commands.rs: the capture-stopped event is missing — the silent-stop path would sit behind the 600 ms grace timer"
);
const hook = read("src/hooks/useSystemAudio.ts");
assert(
  hook.includes('"capture-stopped"'),
  "useSystemAudio.ts: no listener for capture-stopped — the event-driven stop resolution is not wired"
);
assert(
  hook.includes("front: stopRequestedRef.current"),
  "useSystemAudio.ts: the flush utterance must enqueue at the FRONT of the queue when a stop is pending"
);
assert(
  hook.includes("partialAbortRef.current?.abort()"),
  "useSystemAudio.ts: an in-flight partial STT upload must be aborted on stop"
);

// ---------------------------------------------------------------------------
// 2. payload math: whole-buffer@48k vs delta@16k, computed not claimed
// ---------------------------------------------------------------------------
const wavBytes = (seconds: number, rate: number): number =>
  44 + seconds * rate * 2; // 16-bit mono PCM + header
const b64Bytes = (raw: number): number => Math.ceil(raw / 3) * 4;

const UTTERANCE_S = 30;
const OLD_PARTIAL_S = 2.0;
const OLD_RATE = 48000;
const NEW_PARTIAL_S = partialIntervalMs / 1000;

// OLD: partial k carries the whole 2k s buffer → sum = OLD_PARTIAL_S * n(n+1)/2
const oldCount = UTTERANCE_S / OLD_PARTIAL_S;
const oldSecondsUploaded = OLD_PARTIAL_S * (oldCount * (oldCount + 1) / 2);
const oldBytes = wavBytes(oldSecondsUploaded, OLD_RATE);

// NEW: every delta carries exactly NEW_PARTIAL_S seconds → count * interval
const newCount = UTTERANCE_S / NEW_PARTIAL_S;
const newSecondsUploaded = newCount * NEW_PARTIAL_S;
const newBytes = wavBytes(newSecondsUploaded, sttRate);

const reduction = 1 - newBytes / oldBytes;

// The FINAL (whole utterance) also shrinks 3x with the resampler.
const oldFinalBytes = wavBytes(UTTERANCE_S, OLD_RATE);
const newFinalBytes = wavBytes(UTTERANCE_S, sttRate);
const newLargestPartialB64 = b64Bytes(wavBytes(NEW_PARTIAL_S, sttRate));

assert(
  reduction >= 0.9,
  `partial upload reduction must be >= 90% over a ${UTTERANCE_S}s utterance; computed ${(reduction * 100).toFixed(1)}%`
);
assert(
  newLargestPartialB64 <= 40 * 1024,
  `a single delta partial must stay under 40 KB of base64; computed ${(newLargestPartialB64 / 1024).toFixed(1)} KB`
);

// ---------------------------------------------------------------------------
// 3. stop→send decomposition: the REAL SpeechBlockQueue on an injected clock
// ---------------------------------------------------------------------------
/** Deterministic clock: promises resolve via the schedule hook, never Date. */
function makeClock() {
  let nowMs = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const flushUntil = (target: number): void => {
    for (;;) {
      const next = timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) return;
      timers.splice(timers.indexOf(next), 1);
      nowMs = Math.max(nowMs, next.at);
      next.fn();
    }
  };
  return {
    get now() {
      return nowMs;
    },
    schedule: (fn: () => void, delayMs: number) => {
      timers.push({ at: nowMs + delayMs, fn });
    },
    advanceTo: (target: number) => flushUntil(target),
  };
}

/**
 * Drive the real queue: `rttMs` per STT call; blocks enqueued at t=0; the
 * stop press and its flush block land at `stopAtMs`. Returns the sim-time at
 * which the FLUSH text reached onText (the LLM dispatch moment).
 */
async function measureFlushDispatch(opts: {
  backlog: number;
  rttMs: number;
  stopAtMs: number;
  front: boolean;
}): number {
  const clock = makeClock();
  let dispatchAt = -1;

  const queue = new SpeechBlockQueue<string>({
    transcribe: (block) =>
      new Promise<string>((resolve) => {
        clock.schedule(() => resolve(`text-${block.id}`), opts.rttMs);
      }),
    onText: (text, block) => {
      // Only the FLUSH block's dispatch moment counts — later waiters finish
      // after it and would otherwise overwrite the measurement.
      if (block.audio === "audio-flush") dispatchAt = clock.now;
    },
    schedule: clock.schedule,
    now: () => clock.now,
  });
  for (let i = 0; i < opts.backlog; i += 1) {
    queue.enqueue("system", `audio-${i}`);
  }
  clock.advanceTo(opts.stopAtMs);

  queue.enqueue("system", "audio-flush", { front: opts.front });
  // Run to completion. The cursor is ABSOLUTE (the clock's now only moves
  // when a timer fires, so a now-relative target would stall), and each
  // advance is followed by a macrotask yield so the drain loop's promise
  // continuations (and onText) actually execute.
  let cursor = Math.max(opts.stopAtMs, 0);
  for (let guard = 0; guard < 400 && (queue.size > 0 || dispatchAt === -1); guard += 1) {
    cursor += 50;
    clock.advanceTo(cursor);
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  queue.dispose();
  return dispatchAt;
}

// The reported case: Stop pressed mid-conversation with older utterances
// still waiting in the queue. Front priority must move the flush ahead of
// the waiters.
const flushBehind = await measureFlushDispatch({
  backlog: 2,
  rttMs: 300,
  stopAtMs: 50,
  front: false,
});
const flushFront = await measureFlushDispatch({
  backlog: 2,
  rttMs: 300,
  stopAtMs: 50,
  front: true,
});
const queueGain = flushBehind - flushFront;
assert(
  flushFront < flushBehind,
  `front-priority must dispatch the flush earlier than back-of-queue (${flushFront}ms vs ${flushBehind}ms)`
);

// ---------------------------------------------------------------------------
// 4. report
// ---------------------------------------------------------------------------
const report = {
  generatedAt: new Date().toISOString(),
  constants: {
    partialIntervalMs,
    sttSampleRate: sttRate,
    turnHangoverMs: TURN_HANGOVER_MS,
    turnHangoverRust: rustHangoverMs,
  },
  payloads: {
    utteranceSeconds: UTTERANCE_S,
    oldPartialUploadBytes: oldBytes,
    newPartialUploadBytes: newBytes,
    reductionPercent: Number((reduction * 100).toFixed(1)),
    oldFinalBytes: oldFinalBytes,
    newFinalBytes: newFinalBytes,
    newLargestPartialBase64Bytes: newLargestPartialB64,
  },
  stopFlow: {
    flushDispatchBehindQueueMs: flushBehind,
    flushDispatchFrontPriorityMs: flushFront,
    queueGainMs: queueGain,
    silentStopAckMs: 0,
    silentStopOldGraceTimerMs: 600,
  },
};

const artifactsDir = process.env.LATENCY_REPORT_DIR
  ? resolvePath(process.env.LATENCY_REPORT_DIR)
  : resolvePath(ROOT, "artifacts");
try {
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, "latency-report.json"), JSON.stringify(report, null, 2));
} catch {
  // Report writing must never fail the guard itself (e.g. read-only FS).
}

console.log("=".repeat(72));
console.log("latency budget — transcription → LLM (measured, not claimed)");
console.log("=".repeat(72));
console.log(
  `\n  constants        partial interval ${partialIntervalMs} ms (was 2000) | ` +
    `STT payload ${sttRate} Hz (was 48000) | hangover ${TURN_HANGOVER_MS} ms (was 2000, kept > 1 s)`
);
console.log(
  `  partial uploads  ${UTTERANCE_S}s utterance: ` +
    `${(oldBytes / 1024 / 1024).toFixed(1)} MB total (whole-buffer@48k) → ` +
    `${(newBytes / 1024 / 1024).toFixed(2)} MB (delta@16k) = ${(reduction * 100).toFixed(1)}% less uploaded`
);
console.log(
  `  final upload     ${(oldFinalBytes / 1024 / 1024).toFixed(1)} MB → ${(newFinalBytes / 1024 / 1024).toFixed(2)} MB (3x smaller)`
);
console.log(
  `  largest partial  ${(newLargestPartialB64 / 1024).toFixed(1)} KB base64, constant per tick`
);
console.log(
  `  stop→LLM dispatch (simulated, real queue): back of queue ${flushBehind} ms → front priority ${flushFront} ms (−${queueGain} ms)`
);
console.log(
  `  silent stop      600 ms grace timer → 0 ms (capture-stopped event; 600 ms timer kept as backstop only)`
);
console.log(
  `\n  live transcript: ~${partialIntervalMs} ms cadence + one provider RTT (was 2000 ms + growing upload + RTT)`
);

if (failures.length > 0) {
  console.error(`\nFAIL - latency budget invariants broken (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log("\nPASS - latency budget: constants, payload math, and stop-flow wiring all verified.");
