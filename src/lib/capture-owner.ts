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

/**
 * D3+D8: the token answers *which* system capture holds it, because the
 * Ctrl+Shift+A decision depends on it: mic+system must refuse visibly, while
 * system-only leaves the mic genuinely free. `request("microphone")` is only
 * called when no system capture is running (see the token contract on the
 * class), so the answer is exact, not inferred.
 */
export interface SystemCaptureDetail {
  /** Whether the Listen engine is running. */
  capturing: boolean;
  /** Whether its browser mic is on alongside system audio. */
  micWithSystem: boolean;
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

  /**
   * Detail about the current SYSTEM capture, for the Ctrl+Shift+A decision
   * (D3+D8): the mic may start when no Listen capture is running at all, and
   * must be refused visibly when the running capture also holds the mic.
   * Defaults to idle; `useSystemAudio` reports its live state so this stays
   * exact (a capture that never reported counts as not running).
   */
  private systemDetail: SystemCaptureDetail = {
    capturing: false,
    micWithSystem: false,
  };

  /** The hook calls this whenever its capture or mic-toggle state changes. */
  reportSystemCapture(detail: SystemCaptureDetail): void {
    this.systemDetail = { ...detail };
  }

  /** Snapshot of the last reported system-capture state. */
  get systemCapture(): SystemCaptureDetail {
    return { ...this.systemDetail };
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
   * D4: observers of HOLDER changes. The registry stays plain state on
   * purpose — no imports, no browser APIs, no React (`mic-ownership-check.ts`
   * drives it directly as a pure state machine), but the app's Ask flag is
   * DERIVED from it during React render (`mayMicrophoneRun`), and a bare field
   * write never tells React to redraw. The grant therefore lands after the
   * render that needed it and no render follows — the mic sits visibly OFF
   * while it already holds the token, until an unrelated update redrew the
   * screen. These listeners are the propagation path: `useCompletion`
   * subscribes with `useSyncExternalStore`, so a grant or release re-renders
   * the hook immediately. Listeners fire ONLY when the holder actually
   * changes; with none registered (the guard's world) `notify` is a no-op.
   */
  private listeners: Array<() => void> = [];

  /**
   * Subscribe to holder changes; returns the unsubscribe function (safe to
   * call twice). An arrow-function field so `captureOwnership.subscribe` can
   * be handed to `useSyncExternalStore` directly without losing its receiver.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  };

  /** Notify observers. Iterated over a copy: a listener may unsubscribe. */
  private notify(): void {
    for (const listener of [...this.listeners]) listener();
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
    this.notify();
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
    this.notify();
    return this.holder;
  }

  /**
   * Release `token` if it is still the current holder. Identity-checked and
   * idempotent: a stale token — or a repeated call — does nothing.
   */
  release(token: CaptureToken | null | undefined): void {
    if (!token) return;
    if (this.holder === token) {
      this.holder = null;
      this.notify();
    }
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

/**
 * D3+D8 decision for the Ctrl+Shift+A press, computed from the REPORTED
 * system-capture state (exact — the hook reports on every change):
 *
 * - "start"  — nothing capturing, or a system-only capture whose mic is
 *   genuinely free: switch to Ask and start the mic normally. A running
 *   system-only capture keeps running (switching rooms never stops it).
 * - "refuse" — the running capture also holds the browser mic: starting Ask
 *   would need a second getUserMedia pipeline, so refuse VISIBLY with
 *   "microphone already in use" instead of silently no-op'ing.
 */
export type AskMicDecision = "start" | "refuse";

export const decideAskMic = (
  ownership: CaptureOwnership = captureOwnership
): AskMicDecision => {
  const detail = ownership.systemCapture;
  if (detail.capturing && detail.micWithSystem) return "refuse";
  return "start";
};
