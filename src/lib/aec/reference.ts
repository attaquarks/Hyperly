import {
  startAecReference,
  type AecReferenceFrame,
} from "./reference-channel.ts";

/**
 * Pre-attach buffer bound, newest frames kept. System capture starts before
 * the mic AEC activates; buffering here (instead of dropping) means the
 * worklet's reference FIFO starts primed. That matters because the FIFO is
 * rate-matched — production equals consumption on average — so a FIFO that
 * starts empty would hover empty forever.
 */
const FORWARD_BUFFER_FRAMES = 20;

export interface AecReferenceStatus {
  state: "waiting" | "ready" | "degraded" | "closed";
  reason?: "channel-unavailable" | "internal-error";
  bufferedFrames: number;
}

/**
 * Owns the raw-loopback Tauri Channel on the main thread and forwards frames
 * to the AudioWorklet, which owns the realtime reference FIFO. Frames are
 * forwarded fire-and-forget with transferred sample buffers — the main thread
 * is never in the per-hop path, only in the per-frame delivery path, where a
 * stall merely delays the next frame instead of stalling the pipeline.
 */
export class AecReferenceFeed {
  status: AecReferenceStatus = {
    state: "waiting",
    bufferedFrames: 0,
  };

  private buffered: AecReferenceFrame[] = [];
  private forwarder: MessagePort | null = null;
  private stopChannel: (() => Promise<void>) | null = null;
  private connected = false;
  private closed = false;

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
   * Attaches the worklet side of the reference MessagePort and flushes any
   * pre-attach backlog first, in sequence order.
   */
  attachForwarder(port: MessagePort): void {
    this.forwarder = port;
    for (const frame of this.buffered.splice(0)) {
      this.forward(frame);
    }
    this.status.bufferedFrames = 0;
  }

  /**
   * Stops forwarding (session bypassed or torn down) and returns to the
   * bounded pre-attach buffer, so frames queue to a dead worklet port can
   * never accumulate without bound.
   */
  detachForwarder(): void {
    this.forwarder = null;
  }

  /** Closes the Channel and discards buffered audio without throwing. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffered = [];
    this.status.bufferedFrames = 0;

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
    if (this.closed) return;
    if (this.forwarder) {
      this.forward(frame);
      return;
    }

    // No consumer wired yet: keep only the newest frames so the worklet
    // starts primed with recent audio, not stale audio.
    this.buffered.push(frame);
    if (this.buffered.length > FORWARD_BUFFER_FRAMES) {
      this.buffered.shift();
    }
    this.status.bufferedFrames = this.buffered.length;
    if (this.status.state === "waiting") this.status.state = "ready";
  }

  private forward(frame: AecReferenceFrame): void {
    const samples = Float32Array.from(frame.samples);
    try {
      this.forwarder?.postMessage(
        {
          type: "ref",
          frame: {
            seq: frame.seq,
            tsNs: frame.tsNs,
            sampleRate: frame.sampleRate,
            samples,
          },
        },
        [samples.buffer]
      );
    } catch {
      this.degrade("internal-error");
    }
  }

  private degrade(
    reason: NonNullable<AecReferenceStatus["reason"]>
  ): void {
    this.status.state = "degraded";
    this.status.reason = reason;
  }
}

let activeAecReferenceFeed: AecReferenceFeed | null = null;

/** Publish the feed owned by Listen so the mic pipeline consumes that same tap. */
export const setActiveAecReferenceFeed = (
  feed: AecReferenceFeed | null
): void => {
  activeAecReferenceFeed = feed;
};

export const getActiveAecReferenceFeed = (): AecReferenceFeed | null =>
  activeAecReferenceFeed;
