/**
 * Epoch tracking for live partial transcripts (the duplicate-prompt fix).
 *
 * The Rust VAD emits a `speech-partial` delta roughly every 600 ms of NEW
 * speech — only the audio since the previous partial, not the whole buffer
 * (the old 2 s whole-buffer snapshots made every partial heavier as the
 * utterance grew, which is what pushed the live transcript seconds behind the
 * voice). Each delta is transcribed by an async STT call, and the live text is
 * the ACCUMULATION of the accepted delta texts. A final utterance can
 * therefore land while one or more partial STT calls are still in flight.
 *
 * The epoch is the correctness core: every finalization (and every stop) bumps
 * the epoch, and a partial response may only contribute to the live text if
 * its epoch is still current. A partial that was requested before the final is
 * discarded no matter when its STT answer arrives — the final's text
 * supersedes it by construction, because the flushed/finalized utterance
 * carries the whole buffer the deltas came from.
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
   * Apply a completed DELTA partial STT result: the text is appended to the
   * accumulated live transcript. Returns false (and changes nothing) when a
   * final or a stop superseded the utterance this partial belongs to.
   */
  apply(epoch: number, text: string): boolean {
    if (epoch !== this.epoch) return false;
    const trimmed = text.trim();
    if (trimmed) {
      this.live = this.live ? `${this.live} ${trimmed}` : trimmed;
    }
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
