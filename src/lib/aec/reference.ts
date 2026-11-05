import {
  startAecReference,
  type AecReferenceFrame,
} from "./reference-channel.ts";
import {
  ReferenceScheduler,
  TOP_UP_INTERVAL_MS,
  type ScheduleTarget,
} from "./ref-scheduler.ts";

export interface AecReferenceStatus {
  state: "waiting" | "ready" | "degraded" | "closed";
  reason?: "channel-unavailable" | "internal-error";
  /** 16 kHz samples waiting to be scheduled (320 = one 20 ms frame). */
  bufferedSamples: number;
}

/**
 * Owns the raw-loopback Tauri Channel and delivers the reference to the AEC
 * by SCHEDULING it into the WebAudio graph. The scheduling core lives in
 * ref-scheduler.ts (pure, harness-testable); this adapter binds it to the
 * real AudioContext and a top-up timer.
 */
export class AecReferenceFeed {
  status: AecReferenceStatus = {
    state: "waiting",
    bufferedSamples: 0,
  };

  private scheduler: ReferenceScheduler | null = null;
  private topUpTimer: ReturnType<typeof setInterval> | null = null;
  private stopChannel: (() => Promise<void>) | null = null;
  private connected = false;
  private closed = false;
  private receivedAny = false;

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
   * Wires the reference into the audio graph: pending (and future) samples
   * are scheduled onto `destination` (the AEC worklet's second input),
   * keeping the scheduler's ahead-window queued on the audio thread.
   */
  attach(context: AudioContext, destination: AudioNode): void {
    const target: ScheduleTarget = {
      currentTime: () => context.currentTime,
      createBuffer: (channels, length, sampleRate) =>
        context.createBuffer(channels, length, sampleRate),
      play: (buffer, when) => {
        const source = context.createBufferSource();
        source.buffer = buffer as AudioBuffer;
        source.connect(destination);
        source.start(when);
      },
    };
    this.scheduler = new ReferenceScheduler(target);
    this.scheduler.prime();
    // Anything that buffered while detached schedules immediately.
    this.scheduler.push([]);
    this.topUpTimer = setInterval(() => this.scheduler?.drain(), TOP_UP_INTERVAL_MS);
  }

  /** Stops scheduling (session bypassed or torn down). */
  detach(): void {
    if (this.topUpTimer !== null) {
      clearInterval(this.topUpTimer);
      this.topUpTimer = null;
    }
    this.scheduler = null;
  }

  /** Closes the Channel and discards buffered audio without throwing. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    this.status.bufferedSamples = 0;

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
    if (!this.receivedAny) {
      this.receivedAny = true;
      if (this.status.state === "waiting") this.status.state = "ready";
    }
    this.scheduler?.push(frame.samples);
    this.status.bufferedSamples = this.scheduler?.pendingSamples ?? 0;
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
