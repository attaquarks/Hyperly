/**
 * Scheduling core for the AEC reference bus — pure and dependency-free so
 * the simulation harness can run it in Node.
 *
 * The reference must reach the AEC worklet as a SCHEDULED audio stream: the
 * WebAudio graph consumes scheduled buffers on the audio thread's clock at
 * exactly realtime, no matter what the main thread is doing. The old design
 * forwarded every frame across the UI thread, so each UI stall froze
 * delivery, the worklet's FIFO swung full↔empty, and 60+ underruns per 5 s
 * tripped the honest bypass — the AEC never ran long enough on steady audio
 * to cancel anything.
 */
export const SCHEDULE_AHEAD_SECONDS = 0.4;
export const TOP_UP_INTERVAL_MS = 100;
export const MAX_BUFFER_SECONDS = 0.2;

/** The slice of WebAudio the scheduler needs; the host adapts the real
 * AudioContext to this (and the harness provides a mock). */
export interface ScheduleTarget {
  /** The audio clock, in seconds. */
  currentTime(): number;
  createBuffer(channels: number, length: number, sampleRate: number): {
    copyToChannel(samples: Float32Array, channel: number): void;
  };
  /** Starts playback of `buffer` at graph time `when`. */
  play(buffer: unknown, when: number): void;
}

export class ReferenceScheduler {
  private pending: number[] = [];
  private nextStartTime = 0;
  private readonly target: ScheduleTarget;

  constructor(target: ScheduleTarget) {
    this.target = target;
  }

  /** Re-primes the ahead window: content starts playing this far in future. */
  prime(): void {
    this.nextStartTime = this.target.currentTime() + SCHEDULE_AHEAD_SECONDS;
  }

  /** Reference samples arrived (16 kHz, any length). Drains on the spot. */
  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) this.pending.push(samples[i]);
    this.drain();
  }

  /** Schedules pending audio up to the ahead window. */
  drain(): void {
    // Starved (a main-thread stall longer than the window): restart quickly
    // from "now". The content→play-time mapping shifts once; the engine's
    // delay-aware front end re-adapts (measured: it cancels even across
    // 100↔400 ms delay jumps at 15+ dB ERLE).
    if (this.nextStartTime < this.target.currentTime()) {
      this.nextStartTime = this.target.currentTime() + 0.05;
    }
    while (this.pending.length > 0) {
      const ahead = this.nextStartTime - this.target.currentTime();
      if (ahead >= SCHEDULE_AHEAD_SECONDS) break;
      const take = Math.min(
        this.pending.length,
        Math.floor(MAX_BUFFER_SECONDS * 16000)
      );
      const chunk = this.pending.splice(0, take);
      const buffer = this.target.createBuffer(1, chunk.length, 16000);
      buffer.copyToChannel(Float32Array.from(chunk), 0);
      this.target.play(buffer, this.nextStartTime);
      this.nextStartTime += chunk.length / 16000;
    }
  }

  /** How much audio is queued ahead on the audio thread's clock. */
  get aheadSeconds(): number {
    return Math.max(0, this.nextStartTime - this.target.currentTime());
  }

  /** Samples waiting to be scheduled. */
  get pendingSamples(): number {
    return this.pending.length;
  }

  /** Drop everything (session teardown). */
  reset(): void {
    this.pending = [];
    this.nextStartTime = 0;
  }
}
