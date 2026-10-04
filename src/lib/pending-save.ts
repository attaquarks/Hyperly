/**
 * Debounced, coalescing save (Phase 4 R9, issue #21).
 *
 * THE DEFECT
 * ----------
 * The Listen conversation save was a bare `setTimeout` whose callback did this:
 *
 *     if (isSavingRef.current) return;     // ← the newest state was dropped
 *     ...
 *     return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
 *
 * Two silent loss windows followed. If a save was still in flight when the timer
 * fired, the callback returned WITHOUT rescheduling, so the change that armed it
 * was never written. And a pending timer was merely cleared on unmount, so the
 * last change before teardown was lost too. Both are Listen-only (Ask saves
 * immediately).
 *
 * THE CONTRACT
 * ------------
 *   * `schedule(state)` records the NEWEST state and (re)arms one timer, so rapid
 *     changes coalesce into a single write of the latest state;
 *   * the timer NEVER drops work: if a save is already in flight it re-arms and
 *     writes the newer state once the running save completes;
 *   * `flush()` writes whatever is pending immediately — that is what unmount
 *     calls, instead of clearing the timer;
 *   * a failed save is reported through `onError` and never blocks the next one.
 *
 * The scheduler is injectable, so `scripts/persistence-integrity-check.ts` drives
 * the real state machine with no real timers - the same pattern as
 * `SpeechBlockQueue`. No imports.
 */

export interface PendingSaveOptions<T> {
  /** Write the state. Rejections are reported through `onError`. */
  save: (state: T) => void | Promise<void>;
  /** Debounce delay. */
  delayMs?: number;
  /** Injectable timer; defaults to `setTimeout`. */
  schedule?: (fn: () => void, delayMs: number) => unknown;
  /** Injectable canceller for the timer returned by `schedule`. */
  cancel?: (timer: unknown) => void;
  onError?: (error: unknown) => void;
}

export class PendingSave<T> {
  private readonly save: (state: T) => void | Promise<void>;
  private readonly delayMs: number;
  private readonly scheduleFn: (fn: () => void, delayMs: number) => unknown;
  private readonly cancelFn: (timer: unknown) => void;
  private readonly onError?: (error: unknown) => void;

  private timer: unknown = null;
  private pending: T | null = null;
  private hasPending = false;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  private writes = 0;

  constructor(options: PendingSaveOptions<T>) {
    this.save = options.save;
    this.delayMs = options.delayMs ?? 500;
    this.scheduleFn =
      options.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.cancelFn = options.cancel ?? ((timer) => clearTimeout(timer as never));
    this.onError = options.onError;
  }

  /** How many successful writes have happened. */
  get saveCount(): number {
    return this.writes;
  }

  /** True when there is nothing waiting and nothing running. */
  get isIdle(): boolean {
    return this.timer === null && this.inFlight === null && !this.hasPending;
  }

  /**
   * Record the newest state. Coalesces: several calls in one debounce window
   * produce a single write of the latest state.
   */
  schedule(state: T): void {
    if (this.disposed) return;
    this.pending = state;
    this.hasPending = true;
    this.arm();
  }

  /**
   * Write the pending state now. Used on unmount, where the old implementation
   * cleared the timer and lost the change.
   */
  async flush(): Promise<void> {
    this.disarm();
    if (this.inFlight) await this.inFlight;
    if (this.hasPending) await this.saveNow();
  }

  /** Flush and stop accepting new state. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.flush();
  }

  private arm(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = this.scheduleFn(() => {
      void this.run();
    }, this.delayMs);
  }

  private disarm(): void {
    if (this.timer !== null) {
      this.cancelFn(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    this.timer = null;
    if (this.inFlight) {
      // A save is already running. Come back for whatever is pending rather than
      // returning and losing it.
      this.arm();
      return;
    }
    await this.saveNow();
    // A change that arrived while the save ran is still pending.
    if (this.hasPending && !this.disposed) this.arm();
  }

  private async saveNow(): Promise<void> {
    if (!this.hasPending) return;
    const state = this.pending as T;
    this.pending = null;
    this.hasPending = false;

    const run = (async () => {
      try {
        await this.save(state);
        this.writes += 1;
      } catch (error) {
        this.onError?.(error);
      }
    })();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }
}
