/**
 * Capture ownership (Phase 4 R5, issue #18).
 *
 * THE INVARIANT
 * -------------
 * One capture owner at a time. Two sources can capture in Hyperly:
 *
 *   * `microphone` — the Ask room's mic (`AutoSpeechVAD` -> `useVoiceInput`);
 *   * `system`     — the Listen capture, which may include its own mic.
 *
 * Before R5 those two could run together (Phase 2A §C2): both overlay panels stay
 * mounted, the Ask mic is rendered unconditionally, the Ask↔Listen coordination
 * only fires on the RISING edge of a capture, and the global Voice Input
 * shortcut was delivered twice with no panel or capture scoping. Result: two
 * getUserMedia streams, two AudioContexts and two STT pipelines, one of them
 * hidden behind a CSS-hidden panel.
 *
 * The token is deliberately hard to leak:
 *   * `request()` is refused while the OTHER source owns capture, and
 *     re-requesting while already holding returns the SAME token — so a repeated
 *     activation cannot pile up tokens, nor lock the holder out of its own;
 *   * `take()` preempts by minting a NEW token, which invalidates the previous
 *     one. The system capture uses it because the product rule is explicit: a
 *     starting system-audio capture pauses the Ask mic;
 *   * `release()` checks token IDENTITY, so a late release from an old
 *     activation can never free a newer owner's capture, and releasing twice is
 *     a no-op.
 *
 * TESTABILITY
 * -----------
 * No imports and no browser APIs, so `scripts/mic-ownership-check.ts` drives the
 * real state machine and counts active capture owners.
 */

export type CaptureSource = "microphone" | "system";

export interface CaptureToken {
  readonly source: CaptureSource;
  /** Minted per acquisition; identity is what makes a stale release harmless. */
  readonly id: number;
}

export class CaptureOwnership {
  private holder: CaptureToken | null = null;
  private nextId = 1;

  /** The source that currently owns capture, or null. */
  get owner(): CaptureSource | null {
    return this.holder ? this.holder.source : null;
  }

  /** The token currently held, or null. */
  get token(): CaptureToken | null {
    return this.holder;
  }

  /** How many capture owners are active. 0 or 1 by construction. */
  get activeCount(): number {
    return this.holder ? 1 : 0;
  }

  /** The sources that own capture right now — what the guard counts. */
  get activeSources(): CaptureSource[] {
    return this.holder ? [this.holder.source] : [];
  }

  isHeldBy(source: CaptureSource): boolean {
    return this.holder !== null && this.holder.source === source;
  }

  /**
   * Ask for ownership. Refused (`null`) while the other source owns capture.
   * Re-requesting while already holding returns the live token.
   */
  request(source: CaptureSource): CaptureToken | null {
    if (this.holder) {
      return this.holder.source === source ? this.holder : null;
    }
    this.holder = { source, id: this.nextId++ };
    return this.holder;
  }

  /**
   * Take ownership, preempting whatever held it (a new token invalidates the old
   * one). Used by the system capture: a starting system-audio capture pauses the
   * Ask mic, so it must never be refused by a mic that is still holding on.
   */
  take(source: CaptureSource): CaptureToken {
    if (this.holder && this.holder.source === source) return this.holder;
    this.holder = { source, id: this.nextId++ };
    return this.holder;
  }

  /**
   * Release `token` if it is still the current holder. Identity-checked and
   * idempotent: a stale token — or a repeated call — does nothing.
   */
  release(token: CaptureToken | null | undefined): void {
    if (!token) return;
    if (this.holder === token) this.holder = null;
  }
}

/** The app's single capture-ownership registry. */
export const captureOwnership = new CaptureOwnership();

/**
 * The one predicate that decides whether the Ask mic may run: the room wants it
 * AND the mic owns capture. Every drive of the Ask VAD goes through this, so a
 * second pipeline cannot start even if another activation path appears later.
 */
export const mayMicrophoneRun = (
  microphoneIntent: boolean,
  ownership: CaptureOwnership = captureOwnership
): boolean => microphoneIntent && ownership.isHeldBy("microphone");
