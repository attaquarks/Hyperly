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
 * The sensitivity is in the key for the same reason: it sets the VAD's
 * detection thresholds at build time, so a slider change only takes effect
 * through a remount.
 */
export const MicDriver = (props: Props) => {
  const { selectedAudioDevices } = useApp();
  const deviceId = selectedAudioDevices.input?.id;
  const sensitivity = useVoiceSensitivity();

  return (
    <Suspense fallback={null}>
      <AutoSpeechVAD key={`${deviceId ?? "default"}:${sensitivity}`} {...props} />
    </Suspense>
  );
};
