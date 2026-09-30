/**
 * The single turn-finalization boundary, shared by both capture sources
 * (Phase 4 R1, issue #14).
 *
 * THE UX CONTRACT
 * ---------------
 * A pause of up to ~1.5 s must not split a turn. Both sources therefore use
 * the same hangover: TURN_HANGOVER_MS (2000 ms, the value Glass uses),
 * comfortably above the contract so scheduling jitter cannot fragment a
 * sentence. The hangover is *resettable*: any detected speech restarts the
 * countdown in both segmenters (vad-web zeroes `redemptionCounter` in
 * frame-processor.js; the Rust loop zeroes `silence_chunks`).
 *
 * WHY TWO IMPLEMENTATIONS, ONE NUMBER
 * -----------------------------------
 * The mic segments inside vad-web; system audio segments inside the Rust VAD
 * loop. The logic cannot literally be shared across the language boundary, so
 * the *number* is: this module is the TS source of truth, `commands.rs`
 * carries `TURN_HANGOVER_MS` for the Rust side, and
 * `scripts/turn-boundary-check.ts` fails if the two ever disagree, if either
 * threshold drops to or below the UX contract, or if a pause below the
 * threshold splits a turn in the fixtures.
 *
 * (This module deliberately has no imports: the check script loads it directly
 * under node.)
 */

/** A pause up to this long must not split a turn (the UX contract). */
export const TURN_SPLIT_UX_MS = 1500;

/** Trailing silence required to finalize a turn - one value, both sources. */
export const TURN_HANGOVER_MS = 2000;

/** vad-web's analysis frame: 1536 samples at 16 kHz. */
export const MIC_FRAME_MS = 96;

/**
 * `redemptionMs` to hand vad-web. It floors to whole frames
 * (`floor(ms / 96)`), so round *up* to the next frame boundary: 2016 ms
 * resolves to 21 frames = 2016 ms of hangover, never below TURN_HANGOVER_MS.
 */
export const micRedemptionMs = (): number =>
  Math.ceil(TURN_HANGOVER_MS / MIC_FRAME_MS) * MIC_FRAME_MS;

/** Whole frames the mic hangover resolves to - what the fixtures reason about. */
export const micRedemptionFrames = (): number =>
  Math.floor(micRedemptionMs() / MIC_FRAME_MS);
