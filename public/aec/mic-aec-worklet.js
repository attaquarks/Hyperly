const AEC_SAMPLE_RATE = 16000;
const AEC_HOP_SAMPLES = 256;
const OUTPUT_PREROLL_SAMPLES = AEC_SAMPLE_RATE * 0.064;
// Reference FIFO — moved here from the main-thread feed. The audio rendering
// thread owns the entire realtime path: reference buffering, hop pairing, and
// engine transport. The main thread only forwards frames fire-and-forget and
// runs policy (bypass decisions, telemetry), never per-hop work.
const FIFO_CAPACITY = 20;
/** Episode trim target: 10 frames = 200 ms, the top of the declared 100–200 ms refDelayMs band. */
const FIFO_TARGET_DEPTH = 10;
/**
 * Burst headroom above the target. Delivery bursts (a stalled main thread
 * flushing queued IPC frames) briefly exceed the target; shedding the surplus
 * here keeps wake bursts from drawing the FIFO dry before the reference
 * frames catch up. Consumed backlog still returns to 200 ms.
 */
const FIFO_HIGH_WATER = 14;
/** In-flight process hops before a new hop is concealed. The engine drains a
 * full queue between stalls, so the queue must absorb a stall and let the
 * engine catch up; 16 hops = 256 ms matches the output-queue bound. */
const WORKER_INFLIGHT_LIMIT = 16;
/** Conceal-budget window in context seconds; the budgets themselves
 * (engine 16, reference 64) are main-thread policy fed by "concealed". */
const CONCEAL_WINDOW_SECONDS = 5;
const PLAYBACK_LIMIT_SAMPLES = Math.floor(AEC_SAMPLE_RATE * 0.25);
const STATS_INTERVAL_SECONDS = 1;

class MicAecBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bypass = false;
    this.workerPort = null;
    this.degradedReason = null;

    // Mic hop accumulation: context-rate input averaged down to 16 kHz hops.
    this.inputPhase = 0;
    this.inputSum = 0;
    this.inputCount = 0;
    this.micFrame = new Float32Array(AEC_HOP_SAMPLES);
    this.micFrameOffset = 0;
    this.nextMicId = 0;

    // Reference FIFO (same semantics the main-thread feed enforced).
    this.refFrames = new Map();
    this.refLastSeq = null;
    this.refPendingGap = false;
    this.refOverflows = 0;
    this.refUnderruns = 0;
    this.refSequenceGaps = 0;
    this.refReadySent = false;

    // Engine pairing state.
    this.inFlight = 0;
    this.nextExpectedOutputId = 0;
    this.skippedOutputIds = new Set();
    this.pendingMicGap = false;
    this.engineConceals = [];
    this.refConceals = [];
    this.hopPostedAt = new Map();
    this.hopRtts = [];
    this.hops = 0;
    this.lastStatsTime = 0;

    // Processed output playback.
    this.playback = [];
    this.playbackPosition = 0;
    this.playbackStarted = false;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === "init") {
        this.workerPort = data.workerPort;
        this.workerPort.onmessage = (workerEvent) => this.onWorkerMessage(workerEvent.data);
        return;
      }
      if (data.type === "ref") {
        this.onRefFrame(data.frame);
        return;
      }
      if (data.type === "trim") {
        this.trimToTarget();
        return;
      }
      if (data.type === "bypass") {
        this.bypass = true;
        this.playback.length = 0;
        return;
      }
    };
  }

  /** Reports an unusable reference feed to the main thread, which owns bypass. */
  degrade(reason) {
    if (this.degradedReason) return;
    this.degradedReason = reason;
    this.port.postMessage?.({ type: "feed-degraded", reason });
  }

  onRefFrame(frame) {
    if (this.bypass || this.degradedReason) return;
    if (
      !Number.isSafeInteger(frame.seq) ||
      !Number.isFinite(frame.tsNs) ||
      frame.tsNs < 0 ||
      frame.sampleRate !== AEC_SAMPLE_RATE ||
      !(frame.samples instanceof Float32Array) ||
      frame.samples.length === 0
    ) {
      this.degrade("invalid-frame");
      return;
    }

    if (
      (this.refLastSeq !== null && frame.seq <= this.refLastSeq) ||
      this.refFrames.has(frame.seq)
    ) {
      this.refSequenceGaps += 1;
      this.degrade("duplicate-frame");
      return;
    }
    if (this.refLastSeq !== null && frame.seq !== this.refLastSeq + 1) {
      // A sequence gap is a reference discontinuity, not a reason to discard
      // the contiguous backlog in front of it: clearing the FIFO threw away
      // ~200ms of valid audio and the next hop underran into a fatal bypass.
      // Keep the backlog; the gap flag resets the filter on the next
      // consumed hop.
      this.refSequenceGaps += 1;
      this.refPendingGap = true;
    }
    this.refLastSeq = frame.seq;

    // Flow shaping: shed burst surplus above the high-water mark. This is
    // not an overflow — no frame was lost to pressure — so it does not
    // count against the recovery ladder; it marks the discontinuity so the
    // filter resets on the next consumed hop.
    if (this.refFrames.size > FIFO_HIGH_WATER) {
      this.trimToTarget();
      this.refPendingGap = true;
    }
    if (this.refFrames.size >= FIFO_CAPACITY) {
      // One full-FIFO episode = one overflow + one gap: trim to the declared
      // 200 ms band instead of dropping one frame per arriving frame, which
      // counted a single burst as many strikes.
      this.trimToTarget();
      this.refOverflows += 1;
      this.refPendingGap = true;
    }

    this.refFrames.set(frame.seq, { seq: frame.seq, samples: frame.samples, offset: 0 });

    if (!this.refReadySent && this.bufferedRefSamples() >= AEC_HOP_SAMPLES * 2) {
      this.refReadySent = true;
      this.port.postMessage?.({ type: "ref-ready" });
    }
  }

  bufferedRefSamples() {
    let buffered = 0;
    for (const frame of this.refFrames.values()) {
      buffered += frame.samples.length - frame.offset;
    }
    return buffered;
  }

  trimToTarget() {
    while (this.refFrames.size > FIFO_TARGET_DEPTH) {
      const oldestSeq = this.refFrames.keys().next().value;
      if (oldestSeq === undefined) break;
      this.refFrames.delete(oldestSeq);
    }
  }

  takeRef(hopSamples) {
    let available = 0;
    for (const frame of this.refFrames.values()) {
      available += frame.samples.length - frame.offset;
      if (available >= hopSamples) break;
    }
    if (available < hopSamples) {
      this.refUnderruns += 1;
      return null;
    }

    const output = new Float32Array(hopSamples);
    let written = 0;
    while (written < hopSamples) {
      const first = this.refFrames.entries().next().value;
      if (!first) break;
      const [seq, frame] = first;
      const count = Math.min(hopSamples - written, frame.samples.length - frame.offset);
      output.set(frame.samples.subarray(frame.offset, frame.offset + count), written);
      frame.offset += count;
      written += count;
      if (frame.offset >= frame.samples.length) this.refFrames.delete(seq);
    }
    return written === hopSamples ? output : null;
  }

  collectMicHops(input) {
    for (const sample of input) {
      this.inputSum += sample;
      this.inputCount += 1;
      this.inputPhase += AEC_SAMPLE_RATE;
      if (this.inputPhase < sampleRate) continue;

      this.inputPhase -= sampleRate;
      this.micFrame[this.micFrameOffset] = this.inputSum / this.inputCount;
      this.micFrameOffset += 1;
      this.inputSum = 0;
      this.inputCount = 0;

      if (this.micFrameOffset === AEC_HOP_SAMPLES) {
        const frame = this.micFrame;
        this.micFrame = new Float32Array(AEC_HOP_SAMPLES);
        this.micFrameOffset = 0;
        this.dispatchMicHop(frame);
      }
    }
  }

  dispatchMicHop(frame) {
    const id = this.nextMicId;
    this.nextMicId += 1;

    if (this.bypass || this.degradedReason || !this.workerPort) {
      this.conceal(id, "engine", this.degradedReason ?? "engine not wired");
      return;
    }
    if (this.inFlight >= WORKER_INFLIGHT_LIMIT) {
      // Depth beyond the cap is result-pickup delay on the audio thread's
      // port, not engine slowness — conceal and let the queue catch up.
      this.conceal(id, "engine", `in flight ${this.inFlight}`);
      return;
    }
    const reference = this.takeRef(AEC_HOP_SAMPLES);
    if (!reference) {
      // Momentarily empty FIFO (delivery burst drew it dry): the backlog
      // refills in ~20ms — conceal, don't fail.
      this.conceal(id, "ref", "reference underrun");
      return;
    }

    const gap = this.refPendingGap || this.pendingMicGap;
    this.refPendingGap = false;
    this.pendingMicGap = false;
    this.inFlight += 1;
    this.hopPostedAt.set(id, currentTime);
    this.workerPort.postMessage(
      { type: "process", id, mic: frame, ref: reference, gap },
      [frame.buffer, reference.buffer]
    );
  }

  /** Conceal one hop: silence when its output turn comes, filter reset on the
   * next posted hop, one strike on the matching ring. Policy (bypass) and the
   * rings' budgets live on the main thread, fed by these reports. */
  conceal(id, kind, why) {
    this.skippedOutputIds.add(id);
    this.pendingMicGap = true;
    const ring = kind === "engine" ? this.engineConceals : this.refConceals;
    ring.push(currentTime);
    while (ring.length > 0 && currentTime - ring[0] > CONCEAL_WINDOW_SECONDS) {
      ring.shift();
    }
    this.port.postMessage?.({ type: "concealed", kind, why });
  }

  pushSilence(samples) {
    for (let i = 0; i < samples; i += 1) this.playback.push(0);
    this.shedOutputBacklog();
  }

  /** Forward concealment silence in strict id order, exactly when the skipped
   * hop's output turn comes, so the processed stream stays id-ordered. */
  flushSkippedOutputs() {
    while (this.skippedOutputIds.has(this.nextExpectedOutputId)) {
      this.skippedOutputIds.delete(this.nextExpectedOutputId);
      this.pushSilence(AEC_HOP_SAMPLES);
      this.nextExpectedOutputId += 1;
    }
  }

  onWorkerMessage(data) {
    if (data.type === "error") {
      // Engine fault: silence bookkeeping happens here on the audio thread;
      // the recovery ladder and bypass live on the main thread.
      if (data.id === undefined || data.id !== this.nextExpectedOutputId) {
        this.port.postMessage?.({ type: "fault", reason: `engine error: ${data.message}` });
        return;
      }
      this.hopPostedAt.delete(data.id);
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.nextExpectedOutputId += 1;
      this.pushSilence(AEC_HOP_SAMPLES);
      this.flushSkippedOutputs();
      this.port.postMessage?.({ type: "worker-error", message: data.message });
      return;
    }
    if (data.type !== "processed") return;

    const postedAt = this.hopPostedAt.get(data.id);
    this.hopPostedAt.delete(data.id);
    if (postedAt !== undefined) {
      this.hopRtts.push((currentTime - postedAt) * 1000);
      if (this.hopRtts.length > 64) this.hopRtts.shift();
    }
    this.flushSkippedOutputs();
    if (
      data.id !== this.nextExpectedOutputId ||
      !(data.samples instanceof ArrayBuffer) ||
      data.samples.byteLength !== AEC_HOP_SAMPLES * 4
    ) {
      this.port.postMessage?.({ type: "fault", reason: "engine response sequence gap or invalid frame" });
      return;
    }
    this.nextExpectedOutputId += 1;
    this.inFlight = Math.max(0, this.inFlight - 1);
    const samples = new Float32Array(data.samples);
    for (const sample of samples) this.playback.push(sample);
    this.shedOutputBacklog();
    this.hops += 1;
  }

  /**
   * A catch-up burst after a stall can push the output queue past its latency
   * bound. The backlog exists because the pipeline momentarily fell behind,
   * so shed the oldest output to resync latency instead of failing; sustained
   * inability to keep up still surfaces through the concealment budgets.
   */
  shedOutputBacklog() {
    if (this.playback.length <= PLAYBACK_LIMIT_SAMPLES) return;
    const excess = this.playback.length - PLAYBACK_LIMIT_SAMPLES;
    this.playback.splice(0, excess);
    this.playbackPosition = Math.max(0, this.playbackPosition - excess);
    console.warn(`[aec] shed ${excess} stale output samples to resync latency`);
  }

  maybePostStats() {
    if (currentTime - this.lastStatsTime < STATS_INTERVAL_SECONDS) return;
    this.lastStatsTime = currentTime;
    const rtts = this.hopRtts;
    const avg = rtts.length ? rtts.reduce((sum, value) => sum + value, 0) / rtts.length : 0;
    const worst = rtts.length ? Math.max(...rtts) : 0;
    this.port.postMessage?.({
      type: "stats",
      hops: this.hops,
      bufferedSamples: this.bufferedRefSamples(),
      inFlight: this.inFlight,
      rttAvgMs: avg,
      rttMaxMs: worst,
      overflows: this.refOverflows,
      underruns: this.refUnderruns,
      gaps: this.refSequenceGaps,
    });
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (this.bypass) {
      output.fill(0);
      if (input) output.set(input.subarray(0, output.length));
      return true;
    }

    if (input) this.collectMicHops(input);

    this.maybePostStats();

    const samplesNeeded = Math.ceil(output.length * AEC_SAMPLE_RATE / sampleRate) + 1;
    if (!this.playbackStarted && this.playback.length >= OUTPUT_PREROLL_SAMPLES) {
      this.playbackStarted = true;
    }

    if (!this.playbackStarted) {
      output.fill(0);
      if (input) output.set(input.subarray(0, output.length));
      return true;
    }

    if (this.playback.length - Math.floor(this.playbackPosition) < samplesNeeded) {
      // Output starved (worker results arrived late). Pass the raw mic
      // through for this render and let the queue refill instead of killing
      // the session — that is byte-identical to a temporary bypass.
      this.playbackStarted = false;
      output.fill(0);
      if (input) output.set(input.subarray(0, output.length));
      console.warn("[aec] worklet output starved; passing raw mic until the queue refills");
      return true;
    }

    const step = AEC_SAMPLE_RATE / sampleRate;
    for (let i = 0; i < output.length; i += 1) {
      const index = Math.floor(this.playbackPosition);
      const fraction = this.playbackPosition - index;
      const first = this.playback[index] ?? 0;
      const second = this.playback[index + 1] ?? first;
      output[i] = first + (second - first) * fraction;
      this.playbackPosition += step;
    }

    const consumed = Math.floor(this.playbackPosition);
    if (consumed > 0) {
      this.playback.splice(0, consumed);
      this.playbackPosition -= consumed;
    }
    return true;
  }
}

registerProcessor("hyperly-mic-aec-bridge", MicAecBridgeProcessor);
