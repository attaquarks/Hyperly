import { useVoiceInput } from "@/hooks/useVoiceInput";

type ListenUserMicProps = {
  capturing: boolean;
  onPartial: (text: string) => void;
  onUtterance: (text: string) => void;
  onError: (message: string) => void;
};

/**
 * Browser-side "User" mic for Listen — headless; a finished utterance joins the
 * shared transcript instead of starting an AI turn. All the VAD and STT
 * plumbing lives in `useVoiceInput`, the same hook the Ask room uses.
 *
 * Loaded with React.lazy by speech/index.tsx so the VAD runtime is not
 * evaluated during overlay boot. The caller must key this on the selected
 * microphone id — `useVoiceInput` builds its VAD once per device and will not
 * rebuild it when only the device changes without a remount.
 */
export const ListenUserMic = ({
  capturing,
  onPartial,
  onUtterance,
  onError,
}: ListenUserMicProps) => {
  useVoiceInput({ active: capturing, onPartial, onUtterance, onError });
  return null;
};
