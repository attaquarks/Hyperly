/**
 * Map 0-1 voice sensitivity onto vad-web's speech thresholds (Phase 4 R11).
 *
 * Higher sensitivity lowers the bar for calling a frame speech. At the 0.5
 * default this gives positive 0.5 / negative 0.35, which is the behaviour this
 * app has always had - the formula is unchanged, it only lives here so the check
 * script can drive the real mapping.
 *
 * These are not vad-web's own defaults: its frame processor ships 0.3 and 0.25,
 * so the middle of the slider is stricter than the library. The clamps only guard
 * the ends: at 0 no normal speech would clear the bar, and at 1 every breath
 * would.
 *
 * Exported for `AudioContext` re-tuning: R11 applies a sensitivity change with
 * `MicVAD.setOptions(speechThresholds(value))` instead of rebuilding the VAD, so
 * this pure function is the single definition of what the slider means.
 */
export interface SpeechThresholds {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
}

export const speechThresholds = (voiceSensitivity: number): SpeechThresholds => {
  const sensitivity = Math.min(1, Math.max(0, voiceSensitivity));
  const positive = Math.min(0.9, Math.max(0.15, 1 - sensitivity));
  return {
    positiveSpeechThreshold: positive,
    negativeSpeechThreshold: Math.max(0.1, positive - 0.15),
  };
};
