/**
 * Durable speech-block queue (Phase 4 R2, issue #15).
 *
 * THE INVARIANT
 * -------------
 * Audio is never destroyed before its transcription outcome is durable. A block
 * is enqueued, transcribed, and on failure **retained** and retried with capped
 * exponential backoff; after `maxAttempts` it is dead-lettered - the audio is
 * kept and the failure is surfaced. Nothing is dropped in silence.
 *
 * WHY A SHARED QUEUE
 * ------------------
 * Both capture paths had the same defect in different clothes: the mic cleared
 * `framesRef` then awaited `transcribe()`, and the room's `speech-detected`
 * handler awaited `fetchSTT()` inside a try/catch that dropped the blob. One
 * queue now owns "what happens when transcription fails" for both sources, so
 * they cannot drift. Processing is sequential, so delivery order is enqueue
 * order even when a retry intervenes.
 *
 * TESTABILITY
 * -----------
 * The scheduler and clock are injectable, so `scripts/speech-queue-check.ts`
 * runs the retry/backoff/dead-letter paths with no real timers. This module
 * deliberately has no imports.
 */

export type SpeechSource = "microphone" | "system";

export interface SpeechBlock<T = unknown> {
  /** Monotonic, local to the queue - not a database id. */
  id: number;
  source: SpeechSource;
  audio: T;
  /** Completed transcription attempts; also the retry counter. */
  attempts: number;
  enqueuedAt: number;
}

export interface SpeechBlockQueueOptions<T> {
  /** Attempt one transcription. Throw to signal a retryable failure. */
  transcribe: (block: SpeechBlock<T>) => Promise<string>;
  /** Called with the transcription (possibly empty) once a block succeeds. */
  onText: (text: string, block: SpeechBlock<T>) => void | Promise<void>;
  /** Called after every failed attempt, before any retry is scheduled. */
  onError?: (error: unknown, block: SpeechBlock<T>) => void;
  /** Called once a block exhausts `maxAttempts`. The audio is retained here. */
  onDeadLetter?: (block: SpeechBlock<T>, error: unknown) => void;
  /** Called when a block is refused because the queue is at capacity. */
  onOverflow?: (source: SpeechSource) => void;
  /** Called when the queue drains. */
  onIdle?: () => void;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxQueueDepth?: number;
  schedule?: (fn: () => void, delayMs: number) => void;
  now?: () => number;
}

export class SpeechBlockQueue<T = unknown> {
  private readonly blocks: SpeechBlock<T>[] = [];
  private readonly dead: SpeechBlock<T>[] = [];
  private nextId = 1;
  private draining = false;
  private disposed = false;
  private idleWaiters: Array<() => void> = [];

  private readonly transcribe: SpeechBlockQueueOptions<T>["transcribe"];
  private readonly onText: SpeechBlockQueueOptions<T>["onText"];
  private readonly onError?: SpeechBlockQueueOptions<T>["onError"];
  private readonly onDeadLetter?: SpeechBlockQueueOptions<T>["onDeadLetter"];
  private readonly onOverflow?: SpeechBlockQueueOptions<T>["onOverflow"];
  private readonly onIdle?: SpeechBlockQueueOptions<T>["onIdle"];
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxQueueDepth: number;
  private readonly schedule: (fn: () => void, delayMs: number) => void;
  private readonly now: () => number;

  constructor(options: SpeechBlockQueueOptions<T>) {
    this.transcribe = options.transcribe;
    this.onText = options.onText;
    this.onError = options.onError;
    this.onDeadLetter = options.onDeadLetter;
    this.onOverflow = options.onOverflow;
    this.onIdle = options.onIdle;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 4000;
    this.maxQueueDepth = options.maxQueueDepth ?? 32;
    this.schedule = options.schedule ?? ((fn, delayMs) => void setTimeout(fn, delayMs));
    this.now = options.now ?? (() => Date.now());
  }

  /** Blocks still held by the queue, including the one being transcribed. */
  get size(): number {
    return this.blocks.length;
  }

  /** Blocks that exhausted their attempts. Their audio is still here. */
  get deadLetters(): readonly SpeechBlock<T>[] {
    return this.dead;
  }

  /** How long the next retry will wait. Grows per attempt, then caps. */
  private backoffMs(attempts: number): number {
    const grown = this.baseDelayMs * 2 ** Math.max(0, attempts - 1);
    return Math.min(grown, this.maxDelayMs);
  }

  /**
   * Accept a speech block. Returns its id, or `null` when the queue is at
   * capacity (reported through `onOverflow`) or already disposed.
   */
  enqueue(source: SpeechSource, audio: T): number | null {
    if (this.disposed) return null;
    if (this.blocks.length >= this.maxQueueDepth) {
      this.onOverflow?.(source);
      return null;
    }
    const block: SpeechBlock<T> = {
      id: this.nextId++,
      source,
      audio,
      attempts: 0,
      enqueuedAt: this.now(),
    };
    this.blocks.push(block);
    void this.drain();
    return block.id;
  }

  /** Resolves once the queue is empty and no retry is pending. */
  idle(): Promise<void> {
    if (!this.draining && this.blocks.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stops accepting blocks and releases idle waiters. */
  dispose(): void {
    this.disposed = true;
    this.releaseIdle();
  }

  private releaseIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private waitForRetry(delayMs: number): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.schedule(() => resolve(), delayMs);
    });
  }

  /**
   * Sequential processor. The block at the head is retried in place, so a
   * failure delays the rest of the queue instead of reordering it.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.disposed && this.blocks.length > 0) {
        const block = this.blocks[0];
        try {
          const text = await this.transcribe(block);
          this.blocks.shift();
          await this.onText(text, block);
        } catch (error) {
          block.attempts += 1;
          this.onError?.(error, block);
          if (block.attempts < this.maxAttempts) {
            await this.waitForRetry(this.backoffMs(block.attempts));
          } else {
            this.blocks.shift();
            this.dead.push(block);
            this.onDeadLetter?.(block, error);
          }
        }
      }
    } finally {
      this.draining = false;
      if (!this.disposed && this.blocks.length === 0) {
        this.onIdle?.();
        this.releaseIdle();
      }
    }
  }
}