import { lazy, Suspense } from "react";
import { UseCompletionReturn } from "@/types";
import { useApp } from "@/contexts";
import { useVoiceSensitivity } from "@/hooks";

// Keep onnxruntime / vad-web off the overlay's first-paint graph. A failed VAD
// module used to take the entire React tree down and leave a transparent
// skip-taskbar window with no UI.
const AutoSpeechVAD = lazy(() =>
  import("./AutoSpeechVad").then((mod) => ({ default: mod.AutoSpeechVAD }))
);

type Props = Pick<
  UseCompletionReturn,
  "submit" | "setState" | "enableVAD" | "setMicTranscript"
>;

/**
 * Mounts the headless Ask mic. This replaced the old mic button that sat inside
 * the composer: the mic is now driven by the Push to talk button in the action
 * row, and the composer holds the send arrow instead.
 *
 * The `key` on the microphone id is required, not decorative: `useVoiceInput`
 * reads the capture constraints when it builds its VAD and rebuilds only when
 * the device changes, so without a remount a device switch would keep recording
 * from the old one.
 *
 * The sensitivity is NOT in the key (Phase 4 R11). It is passed as a prop and
 * applied to the live VAD with `MicVAD.setOptions`, so a slider step re-tunes the
 * running detector instead of remounting it. Keeping it in the key meant one
 * remount per slider step, and each remount cycled an AudioContext and rebuilt the
 * physical device stream — Chromium caps live contexts, so sustained churn could
 * evict a context from under the other room's mic.
 */
export const MicDriver = (props: Props) => {
  const { selectedAudioDevices } = useApp();
  const deviceId = selectedAudioDevices.input?.id;
  const sensitivity = useVoiceSensitivity();

  return (
    <Suspense fallback={null}>
      <AutoSpeechVAD
        key={deviceId ?? "default"}
        sensitivity={sensitivity}
        {...props}
      />
    </Suspense>
  );
};
