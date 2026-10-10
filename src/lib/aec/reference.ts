import {
  startAecReference,
  type AecReferenceFrame,
} from "./reference-channel";

const REFERENCE_SAMPLE_RATE = 16_000;
const FIFO_CAPACITY = 10;
const TRANSIT_HISTORY_CAPACITY = 128;

interface QueuedFrame {
  seq: number;
  samples: Float32Array;
  offset: number;
}

export interface AecReferenceStatus {
  state: "waiting" | "ready" | "degraded" | "closed";
  reason?: "channel-unavailable" | "invalid-frame" | "sequence-gap" | "overflow" | "internal-error";
  sampleRate: 16_000;
  depth: number;
  sequenceGaps: number;
  overflows: number;
  underruns: number;
  /** Histogram of arrival/capture deltas relative to the first received frame. */
  relativeTransitHistogramMs: Record<string, number>;
  relativeTransitSamples: number;
  relativeTransitJitterMs: number | null;
  /** Rust tsNs and performance.now() have no shared origin in this protocol. */
  absoluteTransitMs: null;
}

/**
 * Receives the Step 1 reference Channel and buffers 16 kHz frames for a later
 * AEC consumer. Timestamp diagnostics are relative only: Rust tsNs is rooted
 * at tap start while performance.now() is rooted at the WebView time origin.
 */
export class AecReferenceFeed {
  status: AecReferenceStatus = {
    state: "waiting",
    sampleRate: REFERENCE_SAMPLE_RATE,
    depth: 0,
    sequenceGaps: 0,
    overflows: 0,
    underruns: 0,
    relativeTransitHistogramMs: {},
    relativeTransitSamples: 0,
    relativeTransitJitterMs: null,
    absoluteTransitMs: null,
  };

  private readonly frames = new Map<number, QueuedFrame>();
  private readonly transitHistory: number[] = [];
  private stopChannel: (() => Promise<void>) | null = null;
  private lastReceivedSeq: number | null = null;
  private firstCaptureTsNs: number | null = null;
  private firstArrivalMs: number | null = null;
  private connected = false;
  private closed = false;
  private lastReadoutMs = 0;

  /** Opens the Channel. Failure is recorded in status and never rethrown. */
  async connect(): Promise<void> {
    if (this.connected || this.closed) return;
    this.connected = true;

    try {
      const stop = await startAecReference((frame) => this.receive(frame));
      if (this.closed) {
        try {
          await stop();
        } catch {
          this.degrade("internal-error");
        }
        return;
      }
      this.stopChannel = stop;
    } catch {
      this.degrade("channel-unavailable");
    }
  }

  /**
   * Returns exactly hopSamples in FIFO order, or null until enough reference
   * audio has arrived. This method is safe to call from an audio callback.
   */
  takeRef(hopSamples: number): Float32Array | null {
    try {
      if (this.closed || !Number.isSafeInteger(hopSamples) || hopSamples <= 0) {
        return null;
      }

      let available = 0;
      for (const frame of this.frames.values()) {
        available += frame.samples.length - frame.offset;
        if (available >= hopSamples) break;
      }
      if (available < hopSamples) {
        this.status.underruns += 1;
        this.refreshDepth();
        return null;
      }

      const output = new Float32Array(hopSamples);
      let written = 0;
      while (written < hopSamples) {
        const first = this.frames.entries().next().value as
          | [number, QueuedFrame]
          | undefined;
        if (!first) break;

        const [seq, frame] = first;
        const count = Math.min(
          hopSamples - written,
          frame.samples.length - frame.offset
        );
        output.set(frame.samples.subarray(frame.offset, frame.offset + count), written);
        frame.offset += count;
        written += count;
        if (frame.offset >= frame.samples.length) this.frames.delete(seq);
      }

      this.refreshDepth();
      return written === hopSamples ? output : null;
    } catch {
      this.degrade("internal-error");
      return null;
    }
  }

  /** Closes the Channel and discards buffered audio without throwing. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.frames.clear();
    this.refreshDepth();

    const stop = this.stopChannel;
    this.stopChannel = null;
    if (stop) {
      try {
        await stop();
      } catch {
        this.degrade("internal-error");
      }
    }
    if (this.status.state !== "degraded") this.status.state = "closed";
  }

  private receive(frame: AecReferenceFrame): void {
    try {
      if (this.closed) return;
      if (
        !Number.isSafeInteger(frame.seq) ||
        !Number.isFinite(frame.tsNs) ||
        frame.tsNs < 0 ||
        frame.sampleRate !== REFERENCE_SAMPLE_RATE ||
        !Array.isArray(frame.samples) ||
        frame.samples.length === 0
      ) {
        this.degrade("invalid-frame");
        return;
      }

      if (
        this.lastReceivedSeq !== null &&
        frame.seq !== this.lastReceivedSeq + 1
      ) {
        this.status.sequenceGaps += 1;
        this.degrade("sequence-gap");
      }
      this.lastReceivedSeq = frame.seq;
      this.recordRelativeTransit(frame);

      if (this.frames.has(frame.seq)) {
        this.status.sequenceGaps += 1;
        this.degrade("sequence-gap");
        return;
      }
      if (this.frames.size >= FIFO_CAPACITY) {
        this.status.overflows += 1;
        this.degrade("overflow");
        return;
      }

      const samples = Float32Array.from(frame.samples);
      this.frames.set(frame.seq, { seq: frame.seq, samples, offset: 0 });
      this.refreshDepth();
      if (this.status.state === "waiting") this.status.state = "ready";
      this.maybeLogReadout();
    } catch {
      this.degrade("internal-error");
    }
  }

  private recordRelativeTransit(frame: AecReferenceFrame): void {
    const arrivalMs = performance.now();
    if (this.firstCaptureTsNs === null || this.firstArrivalMs === null) {
      this.firstCaptureTsNs = frame.tsNs;
      this.firstArrivalMs = arrivalMs;
      return;
    }

    const captureElapsedMs = (frame.tsNs - this.firstCaptureTsNs) / 1_000_000;
    const arrivalElapsedMs = arrivalMs - this.firstArrivalMs;
    const relativeTransitMs = arrivalElapsedMs - captureElapsedMs;
    if (!Number.isFinite(relativeTransitMs)) return;

    this.transitHistory.push(relativeTransitMs);
    if (this.transitHistory.length > TRANSIT_HISTORY_CAPACITY) {
      this.transitHistory.shift();
    }

    const histogram: Record<string, number> = {};
    for (const sample of this.transitHistory) {
      const bucket = String(Math.floor(sample));
      histogram[bucket] = (histogram[bucket] ?? 0) + 1;
    }
    const mean = this.transitHistory.reduce((sum, value) => sum + value, 0) /
      this.transitHistory.length;
    const variance = this.transitHistory.reduce(
      (sum, value) => sum + (value - mean) ** 2,
      0
    ) / this.transitHistory.length;

    this.status.relativeTransitHistogramMs = histogram;
    this.status.relativeTransitSamples = this.transitHistory.length;
    this.status.relativeTransitJitterMs = Math.sqrt(variance);
  }

  private maybeLogReadout(): void {
    if (!import.meta.env.DEV) return;
    const now = performance.now();
    if (now - this.lastReadoutMs < 1_000) return;
    this.lastReadoutMs = now;

    const jitter = this.status.relativeTransitJitterMs;
    const jitterText = jitter === null ? "warming" : `σ=${jitter.toFixed(1)}ms`;
    console.info(
      `[aec] ref 16k, transit relative ${jitterText}, depth ${this.frames.size}`
    );
  }

  private refreshDepth(): void {
    this.status.depth = this.frames.size;
  }

  private degrade(
    reason: NonNullable<AecReferenceStatus["reason"]>
  ): void {
    this.status.state = "degraded";
    this.status.reason = reason;
  }
}
