/**
 * One in-flight AI turn per session (Phase 4 R6, issue #19).
 *
 * THE DEFECT
 * ----------
 * `useSystemAudio` created an AbortController but never handed its signal to
 * `fetchAIResponse` — which accepts one — so Stop was a no-op for a request that
 * was already streaming. Nothing serialised turns either, so two answers' chunks
 * interleaved into the same `lastAIResponse`, and an aborted turn could still
 * record its partial answer as if it were complete.
 *
 * THE CONTRACT
 * ------------
 *   * `begin()` starts a turn and SUPERSEDES whatever was in flight: the old
 *     signal is aborted and the old turn stops being current, so its answer is
 *     discarded. Two turns therefore cannot interleave.
 *   * `cancel()` is Stop: it aborts the in-flight request AND retires the turn,
 *     so the partial answer is not publishable.
 *   * `mayPublish(turn)` is the single rule that decides whether an answer may be
 *     recorded — true only while that turn is still the current one.
 *   * `finish(id)` is identity-checked: a superseded turn cannot retire a newer
 *     one, and stopping after a turn has finished does nothing.
 *
 * The gate owns the AbortController, so the signal handed to the request is
 * exactly the one Stop aborts. No imports, so `scripts/ai-turn-check.ts` drives
 * the real gate and the real request path directly.
 */

export interface AiTurn {
  readonly id: number;
  readonly signal: AbortSignal;
  /** True while this is still the turn the session is waiting on. */
  isCurrent(): boolean;
}

export class AiTurnGate {
  private nextId = 1;
  private currentId = 0;
  private controller: AbortController | null = null;

  /** Whether a turn is currently streaming. */
  get inFlight(): boolean {
    return this.currentId !== 0;
  }

  /** The id of the turn in flight, or 0. */
  get activeId(): number {
    return this.currentId;
  }

  /** Start a turn, superseding (and aborting) whatever was in flight. */
  begin(): AiTurn {
    this.cancel();
    const id = this.nextId++;
    const controller = new AbortController();
    this.currentId = id;
    this.controller = controller;
    return {
      id,
      signal: controller.signal,
      isCurrent: () => this.currentId === id,
    };
  }

  /**
   * Stop the in-flight turn: abort the request and make its partial answer
   * unpublishable. Returns whether something was actually cancelled.
   */
  cancel(): boolean {
    this.currentId = 0;
    const controller = this.controller;
    this.controller = null;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  }

  /** A turn ended by itself. Only the current turn may retire the gate. */
  finish(id: number): void {
    if (this.currentId !== id) return;
    this.currentId = 0;
    this.controller = null;
  }

  /** The publish rule: an answer may be recorded only while its turn is current. */
  mayPublish(turn: AiTurn): boolean {
    return turn.isCurrent();
  }
}
