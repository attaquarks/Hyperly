/**
 * AudioContext lifetime for the microphone VAD (Phase 4 R11, issue #22).
 *
 * THE DEFECT
 * ----------
 * `useVoiceInput` used to build its AudioContext inside the build effect and close
 * it in that effect's cleanup, so:
 *
 *   * a context was constructed whenever the hook mounted, even for a mic that
 *     never turned on;
 *   * every device change AND every voice-sensitivity step rebuilt the whole VAD
 *     (the consumer re-keyed on `deviceId:sensitivity`), creating a new context
 *     per step while the old one closed only in cleanup — two live at the handover;
 *   * Chromium caps live hardware contexts (about six) before force-collecting, so
 *     sustained churn could evict a context from under the other room's mic.
 *
 * THE FIX
 * -------
 * One pool of one context. `acquire()` creates it on first use and hands the SAME
 * context to every later holder; `release()` drops one holder and closes the
 * context only when the LAST holder lets go. A remount therefore reuses the
 * context instead of replacing it, and one room's teardown can never close a
 * context the other room is still using.
 *
 * Sharing is safe because R5 guarantees at most one microphone capture owner runs
 * at a time: the Ask VAD and Listen's mic VAD can both be mounted, but never both
 * processing frames.
 *
 * The context is passed to `MicVAD.new`, which keeps vad-web's `ownsAudioContext`
 * false — the library never closes it, the pool does.
 *
 * TESTABILITY
 * -----------
 * The factory is injected, so `scripts/audio-context-check.ts` counts contexts
 * with no browser at all. No imports.
 */

export type AudioContextFactory = () => AudioContext;

export interface AudioContextStats {
  /** Contexts this pool has constructed. */
  readonly created: number;
  /** Contexts this pool has closed. */
  readonly closed: number;
  /** The live context, 0 or 1. */
  readonly live: number;
  /** How many holders currently hold it. */
  readonly holders: number;
}

export class AudioContextPool {
  private readonly create: AudioContextFactory;
  private context: AudioContext | null = null;
  private holders = 0;
  private createdCount = 0;
  private closedCount = 0;

  constructor(create: AudioContextFactory) {
    this.create = create;
  }

  get stats(): AudioContextStats {
    return {
      created: this.createdCount,
      closed: this.closedCount,
      live: this.context ? 1 : 0,
      holders: this.holders,
    };
  }

  /** The live context, or null when nobody holds one. */
  get current(): AudioContext | null {
    return this.context;
  }

  /**
   * Take a hold on the one context, creating it on first use. Every acquire must
   * be matched by exactly one release.
   */
  acquire(): AudioContext {
    this.holders += 1;
    if (!this.context) {
      this.context = this.create();
      this.createdCount += 1;
    }
    return this.context;
  }

  /**
   * Drop one hold. The context closes only when the last holder lets go, so a
   * remount or another room's unmount cannot close a context still in use.
   * Idempotent: releasing with no holds is a no-op and never underflows.
   */
  release(): void {
    if (this.holders === 0) return;
    this.holders -= 1;
    if (this.holders > 0 || !this.context) return;
    const context = this.context;
    this.context = null;
    this.closedCount += 1;
    try {
      void Promise.resolve(context.close()).catch(() => {});
    } catch {
      // A context that cannot close is already unusable; nothing to release.
    }
  }
}

/** The app's one microphone-context pool. */
export const audioContextPool = new AudioContextPool(
  () => new AudioContext()
);
