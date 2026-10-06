import { MicIcon } from "lucide-react";
import { UseCompletionReturn } from "@/types";
import { cn } from "@/lib/utils";
import { captureOwnership } from "@/lib/capture-owner";

type Props = Pick<UseCompletionReturn, "enableVAD" | "setEnableVAD">;

/**
 * The Ask room's voice control: a labelled button in the action row, driving the
 * same `enableVAD` flag the spacebar does, so the button, the key, and the
 * headless mic in MicDriver all agree on one state.
 *
 * It shows **Space**, not the global Voice Input shortcut, because Space is the
 * control that actually governs this mic: press once to record, press again to
 * stop and send. The global shortcut still activates the mic from anywhere, but
 * Space is what the user drives on this screen — Space is contextual, and in
 * Listen the same key starts and stops system-audio capture instead.
 */
export const PushToTalk = ({ enableVAD, setEnableVAD }: Props) => {
  return (
    <button
      type="button"
      className={cn("hyperly-action", enableVAD && "hyperly-action-active")}
      onClick={() => {
        // [D4] INSTRUMENTATION (temporary, kept deliberately — see PR): point
        // (b) the mouse activation. `shown` is the GATED flag the user sees.
        console.log(
          `[D4][ask-press button] shown=${enableVAD}; owner=${
            captureOwnership.owner ?? "null"
          }; token=${captureOwnership.token?.id ?? "null"}`
        );
        setEnableVAD((prev) => !prev);
      }}
      title={
        enableVAD
          ? "Stop voice input and send the transcription"
          : "Start voice input, then press again to send"
      }
    >
      <MicIcon className={cn("h-3 w-3", enableVAD && "animate-pulse")} />
      <span>{enableVAD ? "Stop" : "Voice"}</span>
      <kbd className="hyperly-action-key">Space</kbd>
    </button>
  );
};