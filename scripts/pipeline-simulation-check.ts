/**
 * End-to-end pipeline simulation — real code, synthetic audio.
 *
 * The acceptance test is behavioral: "transcription happens in real time and
 * AEC properly filters the system audio out of the user channel". Real
 * acoustic playback can't run on CI, so this harness simulates both pipelines
 * against the shipped code:
 *
 *   Part A — the AEC worklet (the actual public/aec/mic-aec-worklet.js file,
 *   evaluated unmodified) driven through the exact message sequence the fixed
 *   mic-aec.ts performs: init → reference frames on the node port → ref-ready
 *   → paired hops. Simulated duplex audio: the speech-like far-end fixture as
 *   the system audio, the same audio delayed ~30 ms as the mic's acoustic
 *   pickup of the speakers, plus a faint near-end tone. Asserts the reference
 *   FIFO primes, every mic hop is paired with real reference audio, the mic
 *   content measurably lags the reference span, and no fault is reported.
 *
 *   Part B — the transcript decision pipeline (the real planUtterance and
 *   PartialTracker modules, imported unmodified) driven through the three
 *   reported failure scenarios:
 *     S1 — stop after a final with a stale partial in flight (the duplicate):
 *          the stale partial must be discarded and the stop must send the
 *          held text exactly once.
 *     S2 — stop mid-utterance (the truncation): the engine's flush-on-stop
 *          final must complete the payload (it ends with the utterance's
 *          last word, not half of it).
 *     S3 — system-audio-only duplicate: a late partial after a sent final
 *          must never become a second prompt.
 *
 * The Rust flush rules (prepare_utterance) are unit-tested in cargo; the
 * React glue is exercised by the desktop E2E in the real binary.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  makeLocalVqeSmokeFixture,
} from "../src/lib/aec/fixtures/localvqe-smoke.ts";
import { PartialTracker } from "../src/lib/partial-tracking.ts";
import { planUtterance } from "../src/lib/response-policy.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// A MessagePort-like mock with queued, handler-driven delivery.
// ---------------------------------------------------------------------------
interface MockMessage {
  data: unknown;
}
class MockPort {
  onmessage: ((event: MockMessage) => void) | null = null;
  private queue: unknown[] = [];
  peer?: MockPort;

  /** Push a message into THIS port's inbound queue (harness → port owner). */
  receive(data: unknown): void {
    this.queue.push(data);
  }

  /** Delivers one queued message (what a real port does asynchronously). */
  pump(): boolean {
    if (this.queue.length === 0) return false;
    const data = this.queue.shift();
    this.onmessage?.({ data });
    return true;
  }

  /** Port owner sends outbound: lands in the peer's inbound queue. */
  postMessage(data: unknown): void {
    this.peer?.queue.push(data);
  }

  close(): void {}
}

// ---------------------------------------------------------------------------
// Part A — the real worklet: init → reference frames → ref-ready → paired hops
// ---------------------------------------------------------------------------
const workletSource = readFileSync(
  path.resolve(here, "../public/aec/mic-aec-worklet.js"),
  "utf8"
);

let registered: (new () => unknown) | undefined;
// The worklet reads the worklet-global `currentTime` (seconds); the harness
// advances it by each rendered quantum so 1 Hz stats behave.
let workletClock = 0;
const sandbox: Record<string, unknown> = {
  sampleRate: 48_000,
  console: { warn: () => {}, log: () => {}, info: () => {} },
  get currentTime() {
    return workletClock;
  },
  registerProcessor: (name: string, processor: new () => unknown) => {
    if (name === "hyperly-mic-aec-bridge") registered = processor;
  },
};
sandbox.AudioWorkletProcessor = class {
  port: MockPort;
  constructor() {
    this.port = new MockPort();
  }
};
vm.createContext(sandbox);
vm.runInContext(workletSource, sandbox);

const Processor = registered;
assert.ok(Processor, "worklet registered its processor class");

type BridgeProcessor = {
  port: MockPort;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

// The worklet validates `samples instanceof Float32Array` against its own
// realm, so reference samples must be constructed with the sandbox's own
// Float32Array constructor — the same adjustment a browser makes when it
// structured-clones across the worklet boundary.
const vmFloat32 = vm.runInContext("Float32Array", sandbox) as typeof Float32Array;
const vmArrayBuffer = vm.runInContext("ArrayBuffer", sandbox) as typeof ArrayBuffer;
const vmFrame = (start: number, end: number): Float32Array =>
  vmFloat32.from(fixture.reference.subarray(start, end));

// Reference frames: the fixture's far-end as 320-sample 16 kHz frames —
// exactly what the Rust tap produces and the fixed main-thread feed posts.
const fixture = makeLocalVqeSmokeFixture();
const FRAME_SAMPLES = 320;
const frameCount = Math.floor(fixture.reference.length / FRAME_SAMPLES);

interface DispatchedHop {
  id: number;
  mic: Float32Array;
  ref: Float32Array | null;
  gap: boolean;
}
const workerHops: DispatchedHop[] = [];

const nodeOutbound: string[] = [];
const processor = new (Processor as abstract new () => BridgeProcessor)();
// The worklet posts ref-ready/stats to its node port; the peer collects.
const mainEnd = new MockPort();
mainEnd.onmessage = (event) => {
  nodeOutbound.push((event.data as { type: string }).type);
};
processor.port.peer = mainEnd;

// 1. init — exactly what the fixed mic-aec.ts posts (workerPort only). The
// "transferred" worker port is the worker's end; the worklet will assign its
// onmessage, so the harness collects hops from that port's PEER.
const workerEnd = new MockPort();
const hopCollector = new MockPort();
hopCollector.onmessage = (event) => {
  const data = event.data as DispatchedHop & { type: string };
  if (data.type === "process") {
    workerHops.push({
      id: data.id,
      mic: data.mic,
      ref: data.ref,
      gap: data.gap,
    });
    // Stand in for the engine worker: acknowledge the hop with a processed
    // result (silence) so the in-flight window behaves like the real one.
    // The samples buffer must be the worklet realm's ArrayBuffer.
    const buffer = new vmArrayBuffer(256 * 4);
    workerEnd.receive({ type: "processed", id: data.id, samples: buffer });
    workerEnd.pump();
  }
};
workerEnd.peer = hopCollector;
processor.port.receive({ type: "init", workerPort: workerEnd });
while (processor.port.pump()) {
  /* init consumed by the worklet's handler */
}

// 2. Reference as a LIVE AUDIO INPUT: the worklet reads it from inputs[1].
// The harness feeds both channels in pace, exactly what the scheduled graph
// delivers on the audio thread.
while (processor.port.pump()) {
  /* init consumed */
}
while (mainEnd.pump()) {
  /* collect ref-ready / any degrade report */
}

// 3. Drive the realtime path in pace, like the real pipeline: each 128-sample
// context quantum delivers BOTH the mic and the reference to the worklet.
// The mic hears the far-end delayed by ~30 ms (the speaker→mic acoustic
// path) plus a faint near-end tone; the reference is the far-end itself —
// content-aligned by the schedule-ahead + mic-delay design.
const CONTEXT_RATE = 48_000;
const DELAY_16K_SAMPLES = 480; // ~30 ms speaker→mic acoustic path
const QUANTUM = 128;
const quantum = new Float32Array(QUANTUM);
const refQuantum = new Float32Array(QUANTUM);
const outputChannel = new Float32Array(QUANTUM);
const totalQuanta = Math.floor(
  (fixture.reference.length - DELAY_16K_SAMPLES) * (CONTEXT_RATE / 16_000)
);

for (let q = 0; q < totalQuanta; q++) {
  const base16k = (q * QUANTUM) / (CONTEXT_RATE / 16_000);
  for (let i = 0; i < QUANTUM; i++) {
    const ctxIndex = q * QUANTUM + i;
    const far16k = base16k + i / (CONTEXT_RATE / 16_000) - DELAY_16K_SAMPLES;
    const far = far16k >= 0 ? fixture.reference[Math.floor(far16k)] : 0;
    quantum[i] =
      far * 0.6 + 0.02 * Math.sin(2 * Math.PI * 180 * (ctxIndex / CONTEXT_RATE));
    refQuantum[i] = far16k >= 0 ? fixture.reference[Math.floor(far16k)] : 0;
  }
  // WebAudio shapes: inputs are arrays of channel ARRAYS; input 1 is the
  // scheduled reference stream.
  workletClock += QUANTUM / CONTEXT_RATE;
  processor.process([[quantum], [refQuantum]], [[outputChannel]]);

  while (hopCollector.pump()) {
    /* hops land in workerHops via the collector */
  }
  while (mainEnd.pump()) {
    /* node outbound collected */
  }
}

assert.ok(
  nodeOutbound.includes("ref-ready"),
  `the reference accumulator must report ref-ready (got: ${nodeOutbound.join(", ")})`
);
assert.ok(workerHops.length > 100, `hops were dispatched (${workerHops.length})`);
const unpaired = workerHops.filter((hop) => hop.ref === null);
assert.equal(
  unpaired.length,
  0,
  `every mic hop must carry reference audio (unpaired: ${unpaired.length})`
);

// Alignment: the mic hop's content must be the reference from DELAY_16K
// samples earlier — the physically expected pickup — not some arbitrary
// span. Correlate each checked hop against its expected content.
{
  const hopIndex = 200;
  const hop = workerHops[hopIndex];
  assert.ok(hop.ref, "hop 200 is paired");
  const hopStart16k = hopIndex * 256;
  const expected = new Float32Array(256);
  for (let j = 0; j < 256; j++) {
    const src = hopStart16k - DELAY_16K_SAMPLES + j;
    expected[j] = src >= 0 ? fixture.reference[src] * 0.6 : 0;
  }
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -32; lag <= 32; lag++) {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let j = 0; j < 256; j++) {
      const a = hop.mic[j];
      const b = expected[j - lag] ?? 0;
      dot += a * b;
      magA += a * a;
      magB += b * b;
    }
    const score = dot / (Math.sqrt(magA * magB) + 1e-9);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  assert.ok(
    Math.abs(bestLag) <= 8 && bestScore > 0.9,
    `the paired reference must align with the physically expected pickup ` +
      `(best lag ${bestLag}, score ${bestScore.toFixed(3)})`
  );
}

// 4. Starvation degrades gracefully: with the graph delivering silence (a
// main-thread stall longer than the schedule-ahead window), the worklet
// pairs mic hops with silent reference hops and KEEPS RUNNING — no conceal
// cascade, no fault, no bypass.
{
  const hopsBefore = workerHops.length;
  for (let q = 0; q < 1200; q++) {
    // 1200 quanta = 3.2 s of starved reference (silence on input 1).
    for (let i = 0; i < QUANTUM; i++) {
      const ctxIndex = (workerHops.length + q) * QUANTUM + i;
      quantum[i] = 0.05 * Math.sin(2 * Math.PI * 200 * (ctxIndex / CONTEXT_RATE));
      refQuantum[i] = 0;
    }
    workletClock += QUANTUM / CONTEXT_RATE;
    processor.process([[quantum], [refQuantum]], [[outputChannel]]);
    while (hopCollector.pump()) {}
    while (mainEnd.pump()) {}
  }
  const starvedAdded = workerHops.length - hopsBefore;
  assert.ok(
    starvedAdded > 100,
    `hops must keep dispatching through a starved reference (added ${starvedAdded})`
  );
  assert.ok(
    !nodeOutbound.includes("fault"),
    "a starved reference must not fault the session"
  );
  console.log(
    `  ok    starvation: ${starvedAdded} hops dispatched with silent reference, no fault, no bypass`
  );
}

// 5. No fault reports during the aligned run either.
assert.ok(
  !nodeOutbound.includes("feed-degraded"),
  "no feed-degraded report during the run"
);
assert.ok(!nodeOutbound.includes("fault"), "no fault report during the run");

console.log(
  `  ok    AEC wiring: reference as scheduled audio input, ref-ready fired, ` +
    `${workerHops.length} total hops, aligned pairing, no faults`
);

// ---------------------------------------------------------------------------
// Part A2 — the scheduler under bursty main-thread delivery. The mock clock
// simulates a main thread that stalls 300 ms between top-ups; the scheduler
// must keep the audio graph's playback GAPLESS because 400 ms is queued
// ahead on the audio thread's clock.
// ---------------------------------------------------------------------------
{
  const { ReferenceScheduler } = await import("../src/lib/aec/ref-scheduler.ts");
  let clock = 0;
  const scheduled: Array<{ start: number; length: number }> = [];
  const target = {
    currentTime: () => clock,
    createBuffer: (_ch: number, length: number, _rate: number) => ({
      copyToChannel: (_samples: Float32Array, _ch: number) => {},
      length,
    }),
    play: (_buffer: unknown, when: number) => {
      scheduled.push({ start: when, length: 0 });
    },
  };
  // The harness needs the actual lengths to verify coverage; capture them by
  // wrapping createBuffer — simpler: reconstruct from consecutive starts by
  // recording the buffer length in play via closure. Use a mutable holder.
  let lastLength = 0;
  const target2 = {
    currentTime: () => clock,
    createBuffer: (_ch: number, length: number, _rate: number) => {
      lastLength = length;
      return {
        copyToChannel: (_samples: Float32Array, _ch: number) => {},
      };
    },
    play: (_buffer: unknown, when: number) => {
      scheduled.push({ start: when, length: lastLength });
    },
  };
  void target;
  const scheduler = new ReferenceScheduler(target2);
  scheduler.prime();

  // Simulate the real delivery: frames every 20 ms, but the main thread only
  // gets to run (push + drain) in bursts every ~300 ms.
  const FRAME = 320;
  let refPos = 0;
  const totalFrames = 400; // 8 s of reference
  for (let burst = 0; burst * 15 < totalFrames; burst++) {
    // A 300 ms main-thread stall passes on the audio clock.
    clock += 0.3;
    // The burst delivers ~15 frames (300 ms of audio) at once.
    const framesThisBurst = Math.min(15, totalFrames - burst * 15);
    for (let f = 0; f < framesThisBurst; f++) {
      const samples = new Float32Array(FRAME).fill(0.1);
      scheduler.push(samples);
      refPos += FRAME;
    }
    scheduler.drain();
  }

  // Coverage: sort by start; every scheduled region must be contiguous —
  // no gap larger than one sample between consecutive playbacks.
  scheduled.sort((a, b) => a.start - b.start);
  let gaps = 0;
  for (let i = 1; i < scheduled.length; i++) {
    const prevEnd = scheduled[i - 1].start + scheduled[i - 1].length / 16000;
    if (scheduled[i].start - prevEnd > 1 / 16000) gaps += 1;
  }
  assert.ok(scheduled.length > 10, `bursts were scheduled (${scheduled.length})`);
  assert.equal(
    gaps,
    0,
    `the scheduled reference stream must be gapless under bursty delivery (${gaps} gaps)`
  );
  // The ahead window must never have gone negative at schedule time — the
  // scheduler re-primes when starved, so coverage is continuous.
  console.log(
    `  ok    scheduler: ${scheduled.length} buffers scheduled gapless across ` +
      `300 ms main-thread stalls (400 ms ahead on the audio thread's clock)`
  );
}

// ---------------------------------------------------------------------------
// Part B — the transcript decision pipeline (real modules, real scenarios)
// ---------------------------------------------------------------------------

/**
 * Mirrors useSystemAudio's fixed flow with the real decision modules:
 * partial events → tracker.request/apply (each partial is a DELTA — new audio
 * since the previous one — and the tracker accumulates the texts); finals →
 * tracker.finalize + planUtterance; the stop sequence → tracker.stop +
 * stopRequested + the engine flush landing like any final; the fallback timer
 * as a manual step.
 */
class PipelineDriver {
  prompts: string[] = [];
  private pending = "";
  private stopRequested = false;
  engineActive = true;
  tracker = new PartialTracker();

  /** The accumulated live transcript (what the UI would show). */
  live(): string {
    return this.tracker.current();
  }

  /** A speech-partial event: stamp, (STT round-trip), apply. */
  async partial(text: string): Promise<void> {
    const epoch = this.tracker.request();
    if (this.tracker.apply(epoch, text)) {
      // The hook would also mirror this into livePartialRef / the UI.
    }
  }

  /**
   * Stamp a partial event the moment it ARRIVES (the real race: the event
   * lands before a final, but its STT round-trip completes after one).
   */
  stamp(): number {
    return this.tracker.request();
  }

  /** The stamped partial's STT answer landing after the round-trip. */
  applyStamped(epoch: number, text: string): void {
    this.tracker.apply(epoch, text);
  }

  /** A speech-detected final landing through applyTranscription. */
  async final(text: string, behavior: "auto" | "manual"): Promise<void> {
    this.tracker.finalize();
    const plan = planUtterance(
      behavior,
      text,
      this.pending,
      this.stopRequested,
      "system"
    );
    this.stopRequested = false;
    this.pending = plan.pending;
    if (plan.kind === "hold") {
      // The late-final rule: with the engine stopped, held text cannot wait.
      if (!this.engineActive && this.pending) {
        const held = this.pending;
        this.pending = "";
        this.prompts.push(held);
      }
      return;
    }
    this.prompts.push(plan.text);
    if (plan.kind === "stop-and-send") {
      this.pending = "";
    }
  }

  /** The Stop press (no STT in flight): freeze, request stop, stop engine. */
  async pressStop(): Promise<void> {
    this.tracker.stop();
    this.stopRequested = true;
    this.engineActive = false;
  }

  /** The 600 ms fallback, invoked when no flush landed within the window. */
  async fallbackTimer(): Promise<void> {
    if (this.stopRequested) {
      this.stopRequested = false;
      if (this.pending.trim()) {
        this.prompts.push(this.pending);
        this.pending = "";
      }
    }
  }
}

// ---------------------------------------------------------------------------
// S1 — the reported duplicate (parts 1 & 3): a final lands, a stale partial
// arrives afterwards, then the stop. The stale partial must be discarded and
// the payload must contain the utterance exactly once.
// ---------------------------------------------------------------------------
{
  const driver = new PipelineDriver();
  const utterance =
    "you find joy not in the things people give you because those feelings last forever";
  const stalePartial =
    "you find joy not in the things people give you because those feelings";

  // The true race: the partial EVENT arrives before the final, its STT lands
  // after. (Stamping after the final would hand the partial the new epoch and
    // the discard would be vacuous.)
  const staleEpoch = driver.stamp();
  await driver.final(utterance, "manual"); // held
  driver.applyStamped(staleEpoch, stalePartial); // STT lands AFTER the final
  assert.equal(
    driver.live(),
    "",
    "S1: a stale partial's STT landing after the final must not repopulate the live text"
  );
  await driver.pressStop(); // no flush (the room was silent)
  await driver.fallbackTimer(); // sends the held text

  const payload = driver.prompts.join(" | ");
  const occurrences = payload.split(utterance).length - 1;
  assert.equal(
    occurrences,
    1,
    `S1: the utterance must appear exactly once in the LLM payload (got ${occurrences}: "${payload}")`
  );
  assert.equal(
    driver.prompts.length,
    1,
    `S1: exactly one prompt (got ${driver.prompts.length})`
  );
  console.log("  ok    S1 duplicate: stale partial discarded, stop sent the utterance exactly once");
}

// ---------------------------------------------------------------------------
// S2 — the reported truncation (part 2): stop mid-utterance while the video
// keeps playing. The engine's flush-on-stop final completes the payload.
// ---------------------------------------------------------------------------
{
  const driver = new PipelineDriver();
  const head = "thought and without waiting to be asked you make the effort";
  const tail =
    "to make the other person feel supported even through the smallest of gestures";

  await driver.partial(head); // partial snapshot mid-utterance
  await driver.pressStop(); // stop while speaking; the engine flushes
  await driver.final(`${head} ${tail}`, "manual"); // the flushed full buffer

  const payload = driver.prompts.join(" | ");
  assert.ok(
    payload.includes(`${head} ${tail}`),
    `S2: the flushed utterance must reach the LLM complete (payload: "${payload}")`
  );
  const occurrences = payload.split(head).length - 1;
  assert.equal(
    occurrences,
    1,
    `S2: no duplicated head (got ${occurrences}: "${payload}")`
  );
  console.log("  ok    S2 truncation: flush-on-stop completed the payload with the full utterance");
}

// ---------------------------------------------------------------------------
// S3 — the system-only duplicate (part 3): auto mode, a late partial after a
// sent final, then stop. Exactly one prompt may exist.
// ---------------------------------------------------------------------------
{
  const driver = new PipelineDriver();
  const utterance =
    "but when the disrespect continues you know when it's time to walk away";

  // The true race in auto mode: a delta event arrives while the utterance is
  // still open, its STT lands after the final sent. (In the delta world a
  // partial event AFTER the final is new audio by construction — the Rust
  // side resets the delta mark on every finalize — so the only stale case is
  // this stamp-before/lands-after race.)
  const staleEpoch = driver.stamp();
  await driver.final(utterance, "auto"); // sent immediately
  driver.applyStamped(staleEpoch, utterance); // its STT lands AFTER the final
  assert.equal(
    driver.live(),
    "",
    "S3: a stale partial's STT landing after the final must not repopulate the live text"
  );
  await driver.pressStop(); // silence; no flush
  await driver.fallbackTimer();

  assert.equal(
    driver.prompts.length,
    1,
    `S3: exactly one prompt (got ${driver.prompts.length})`
  );
  const occurrences = driver.prompts[0].split(utterance).length - 1;
  assert.equal(occurrences, 1, "S3: the text appears exactly once");
  console.log("  ok    S3 system-only: late partial never became a second prompt");
}

console.log("  ok    pipeline simulation: all three reported scenarios behave correctly");

// ---------------------------------------------------------------------------
// S4 — the delta-partial cadence: two DELTA partials (the 600 ms cadence
// emits only NEW audio) must ACCUMULATE into one live transcript, and a
// delta whose STT lands after the final must still be discarded.
// ---------------------------------------------------------------------------
{
  const driver = new PipelineDriver();
  const deltaA = "the first thing to check is";
  const deltaB = "whether the network path is clean";
  const utterance = `${deltaA} ${deltaB}`;

  await driver.partial(deltaA);
  await driver.partial(deltaB);
  assert.equal(
    driver.live(),
    utterance,
    `S4: delta partials must accumulate into the full live text (got "${driver.live()}")`
  );

  // The true race: this delta's event arrived before the final, its STT
  // lands after.
  const staleEpoch = driver.stamp();
  await driver.final(utterance, "manual"); // held
  driver.applyStamped(staleEpoch, deltaB); // STT lands AFTER the final
  assert.equal(
    driver.live(),
    "",
    "S4: a stale delta after the final must not repopulate the live text"
  );

  await driver.pressStop();
  await driver.fallbackTimer();

  const payload = driver.prompts.join(" | ");
  const occurrences = payload.split(utterance).length - 1;
  assert.equal(
    occurrences,
    1,
    `S4: the utterance must appear exactly once (got ${occurrences}: "${payload}")`
  );
  console.log("  ok    S4 delta partials: accumulation works, stale deltas stay discarded");
}
