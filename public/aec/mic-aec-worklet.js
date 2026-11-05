const AEC_SAMPLE_RATE = 16000;
const AEC_HOP_SAMPLES = 256;
const OUTPUT_PREROLL_SAMPLES = AEC_SAMPLE_RATE * 0.064;
/**
 * The reference hop queue's drift bound, in hops. The queue pairs one-to-one
 * with mic hops; its depth only changes with the tiny loopback-vs-mic clock
 * skew, so a couple of hops of headroom absorbs it. Beyond the bound the
 * OLDEST hops are shed (positive drift) — a ~1-per-minute correction, not a
 * fault. This replaces the old main-thread-fed FIFO: its depth used to swing
 * with every UI stall, which starved the engine into the bypass.
 */
const REF_QUEUE_LIMIT = 8;
/** In-flight process hops before a new hop is concealed. The queue is the
 * stall absorber: 64 hops ≈ 1 s of worker lag rides here while the engine
 * catches up (it runs ~5× realtime when not CPU-starved); the main thread's
 * output shed resyncs latency after the catch-up. The old cap of 16 let a
 * single 300 ms machine hiccup convert into concealed hops — and with the
 * old reference FIFO that cascaded into the bypass. Sustained inability past
 * this absorber still surfaces through the concealment budget (96/5 s). */
const WORKER_INFLIGHT_LIMIT = 64;
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

    // Reference hop accumulation: the reference arrives as a SECOND audio
    // input (scheduled into the graph by the main thread, consumed on the
    // audio thread's clock — immune to main-thread jank), averaged down to
    // 16 kHz with the same math as the mic path. Completed 16 kHz ref hops
    // queue here and pair one-to-one with mic hops. The queue only drifts by
    // the tiny skew between the loopback and mic clocks; a deep FIFO fed by
    // main-thread messages used to swing full↔empty with every UI stall and
    // starve the engine into 60+ underruns per 5 s and the bypass.
    this.refPhase = 0;
    this.refSum = 0;
    this.refCount = 0;
    this.refQueue = [];
    this.refReadySent = false;
    this.refHopsProduced = 0;
    this.refDriftSheds = 0;
    this.refStarvedPairs = 0;

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

  /**
   * Context-rate reference samples → 16 kHz hops. Same averaging as the mic
   * path, driven by the scheduled audio stream on input 1 — steady by
   * construction, because the WebAudio graph consumes scheduled buffers on
   * the audio thread's clock no matter what the main thread is doing.
   */
  collectRefHops(input) {
    for (const sample of input) {
      this.refSum += sample;
      this.refCount += 1;
      this.refPhase += AEC_SAMPLE_RATE;
      if (this.refPhase < sampleRate) continue;

      this.refPhase -= sampleRate;
      this.refQueue.push(this.refSum / this.refCount);
      this.refSum = 0;
      this.refCount = 0;
      this.refHopsProduced += 1;

      if (this.refQueue.length > REF_QUEUE_LIMIT) {
        // Positive clock drift: the ref produces slightly more hops than the
        // mic consumes. Shed the OLDEST to keep the pairing delay bounded —
        // a ~1-per-minute event, not a fault.
        this.refQueue.splice(0, this.refQueue.length - REF_QUEUE_LIMIT);
        this.refDriftSheds += 1;
      }

      // Ready = two ref hops have FLOWED, not that they are queued: the
      // pairing queue runs 1:1 with mic hops and hovers near empty by
      // design. (A depth-based gate here would never fire and would fail
      // every activation with "did not prime".)
      if (!this.refReadySent && this.refHopsProduced >= 2) {
        this.refReadySent = true;
        this.port.postMessage?.({ type: "ref-ready" });
      }
    }
  }

  /**
   * One ref hop per mic hop, in lockstep. If the queue is dry (sustained
   * negative drift), pair with silence so the engine keeps running — the
   * audio graph delivering silence means uncanceled span, not a cascade.
   */
  takeRefHop() {
    if (this.refQueue.length >= AEC_HOP_SAMPLES) {
      const hop = this.refQueue.splice(0, AEC_HOP_SAMPLES);
      return Float32Array.from(hop);
    }
    this.refStarvedPairs += 1;
    return new Float32Array(AEC_HOP_SAMPLES);
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
    const reference = this.takeRefHop();
    const gap = this.pendingMicGap;
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
      bufferedSamples: this.refQueue.length,
      inFlight: this.inFlight,
      rttAvgMs: avg,
      rttMaxMs: worst,
      overflows: this.refDriftSheds,
      underruns: this.refStarvedPairs,
      gaps: 0,
    });
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const refInput = inputs[1]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (this.bypass) {
      output.fill(0);
      if (input) output.set(input.subarray(0, output.length));
      return true;
    }

    // The reference is a live audio input now: scheduled into the graph by
    // the main thread, consumed here on the audio thread's clock — the
    // consumption rate cannot be touched by UI work.
    if (refInput) this.collectRefHops(refInput);
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
