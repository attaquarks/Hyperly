import { useEffect, useState } from "react";
import { readStoredVadConfig } from "@/lib/vad-config";

/**
 * The stored voice sensitivity, kept current across webviews.
 *
 * This module deliberately imports nothing heavier than the VAD config: the
 * Audio Settings page, the Ask panel and the Listen panel all read it, and
 * `@ricky0123/vad-web` must stay behind the lazy boundary that
 * `useVoiceInput` sits behind.
 *
 * The Audio Settings page runs in the dashboard window, so a change made there
 * arrives here as a `storage` event rather than as shared React state.
 *
 * Consumers pass the returned value to `useVoiceInput` as `sensitivity` (Phase 4
 * R11). It is read when the VAD is built and applied to the LIVE detector with
 * `MicVAD.setOptions` when it changes. Do NOT re-key a mic on it: re-keying
 * remounts the VAD, which cycles an AudioContext and rebuilds the device stream
 * for what is only a threshold change.
 */
export const useVoiceSensitivity = (): number => {
  const [sensitivity, setSensitivity] = useState(
    () => readStoredVadConfig().voice_sensitivity
  );

  useEffect(() => {
    const onStorage = () =>
      setSensitivity(readStoredVadConfig().voice_sensitivity);

    // The write that matters happens in the other window, which is exactly the
    // case the storage event covers. A same-window write is already handled by
    // the page that performed it holding its own state.
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return sensitivity;
};
