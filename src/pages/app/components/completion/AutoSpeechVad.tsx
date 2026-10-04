import { UseCompletionReturn } from "@/types";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { useEffect, useRef } from "react";

type Props = Pick<
  UseCompletionReturn,
  "submit" | "setState" | "enableVAD" | "setMicTranscript"
> & {
  /**
   * Voice sensitivity, 0.0-1.0. `useVoiceInput` reads it when it builds the VAD
   * and applies later changes to the live detector with `setOptions`, so a slider
   * step no longer remounts this component (Phase 4 R11).
   */
  sensitivity?: number;
};

/**
 * Headless mic for the Ask room: renders nothing, and everything said while the
 * spacebar is held is transcribed and sent to the completion flow in one go.
 *
 * All the VAD/STT work lives in `useVoiceInput` — the same hook Listen uses —
 * so there is one microphone implementation in the app. This module is behind
 * React.lazy (see MicDriver) to keep the VAD runtime off the overlay's
 * first-paint graph.
 *
 * Spacebar is the only control: first press starts, second press stops and
 * sends. Silence between sentences is deliberately NOT a stop signal. The VAD
 * fires its own speech-end on every detected pause, so each utterance is only
 * buffered here and the whole buffer is flushed when the key is released —
 * otherwise a mid-sentence breath would ship a fragment on its own.
 */
export const AutoSpeechVAD = ({
  submit,
  setState,
  enableVAD,
  setMicTranscript,
  sensitivity,
}: Props) => {
  // Everything said during one hold, joined in order on release.
  const bufferRef = useRef<string[]>([]);

  useVoiceInput({
    active: enableVAD,
    sensitivity,
    onPartial: setMicTranscript,
    onUtterance: (text) => {
      // Accumulate only. The live strip still shows the newest utterance so the
      // user can see the mic is hearing them.
      setMicTranscript(text);
      bufferRef.current.push(text);
    },
    onError: (message) => setState((prev: any) => ({ ...prev, error: message })),
  });

  // Key released: join everything captured during the hold and send it once.
  // A pause mid-hold never reaches this, so nothing goes out early.
  useEffect(() => {
    if (enableVAD) return;

    const said = bufferRef.current.join(" ").trim();
    bufferRef.current = [];
    if (!said) return;

    submit(said);
  }, [enableVAD, submit]);

  return null;
};
