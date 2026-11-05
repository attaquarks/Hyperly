/**
 * Epoch tracking for live partial transcripts (the duplicate-prompt fix).
 *
 * The Rust VAD emits a `speech-partial` snapshot roughly every 2 s of speech,
 * and each snapshot is transcribed by an async STT call. A final utterance can
 * therefore land while one or more partial STT calls are still in flight. The
 * old code cleared `livePartial` when the final arrived, but an in-flight
 * partial response that landed *afterwards* repopulated it with an older
 * snapshot of the same audio — and the manual stop then appended that stale
 * snapshot to the finalized text (or, in Auto, sent it as a whole new prompt).
 * The user saw the same words reach the model twice.
 *
 * The fix is an epoch: every finalization (and every stop) bumps the epoch,
 * and a partial response may only become the live partial if its epoch is
 * still current. A partial that was requested before the final is discarded
 * no matter when its STT answer arrives — the final's text supersedes it by
 * construction, because the Rust partial is a strict prefix of the utterance
 * audio the final was produced from.
 */
export class PartialTracker {
  private epoch = 0;
  private live = "";

  /**
   * Stamp a partial event the moment it arrives (before its STT round-trip).
   * The returned epoch is what `apply` must see to accept the result.
   */
  request(): number {
    return this.epoch;
  }

  /**
   * Apply a completed partial STT result. Returns false (and changes nothing)
   * when a final or a stop superseded the utterance this partial belongs to.
   */
  apply(epoch: number, text: string): boolean {
    if (epoch !== this.epoch) return false;
    this.live = text;
    return true;
  }

  /** A finalized utterance landed: everything older is superseded. */
  finalize(): void {
    this.epoch += 1;
    this.live = "";
  }

  /** Capture is stopping: nothing in flight may repopulate afterwards. */
  stop(): void {
    this.epoch += 1;
    this.live = "";
  }

  /** The live partial text, or "" when none is current. */
  current(): string {
    return this.live;
  }
}
