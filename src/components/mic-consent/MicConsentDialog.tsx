import { useSyncExternalStore } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  answerMicConsent,
  isMicConsentPromptOpen,
  subscribeMicConsent,
} from "@/lib/mic-consent";

/**
 * The microphone consent prompt (Phase 4 R7, issue #12).
 *
 * Mounted once at the app root (src/main.tsx) and driven entirely by
 * `src/lib/mic-consent.ts`: `requestMicConsent()` opens it the first time a
 * capture path needs the mic and waits here for the user's answer. Closing the
 * dialog by any means other than "Allow microphone" counts as a decline for
 * that request; consent is only ever stored on an explicit Allow.
 */
export const MicConsentDialog = () => {
  const open = useSyncExternalStore(
    subscribeMicConsent,
    isMicConsentPromptOpen
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Only user-initiated closes land here; `answerMicConsent` already
        // flipped promptOpen when the buttons were pressed.
        if (!next && isMicConsentPromptOpen()) void answerMicConsent(false);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Use your microphone?</DialogTitle>
          <DialogDescription>
            Voice input and push-to-talk need your microphone. Audio is sent
            only to the speech-to-text provider you configured, and Hyperly
            never starts listening on its own.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <button
            type="button"
            onClick={() => void answerMicConsent(false)}
            className="rounded-lg border border-border/60 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={() => void answerMicConsent(true)}
            className="rounded-lg border border-primary/60 bg-primary/10 px-3 py-2 text-sm font-medium transition-colors hover:bg-primary/20"
          >
            Allow microphone
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
