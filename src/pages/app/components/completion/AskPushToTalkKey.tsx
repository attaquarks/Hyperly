import { useEffect } from "react";

// Alt+Space toggles the Ask mic — but only while the Ask panel is visible.
//
// The old Space binding bailed out whenever focus was in the composer input
// (`isTextTarget`) — exactly where focus lands after the first interaction —
// so the mic started once and every later Space became a text edit. Alt+Space
// needs no such escape: the Alt modifier suppresses character insertion by
// itself and the combo is inert in text fields, so no text is ever typed and
// no focus check is needed.
//
// Listen binds the same physical key to start/stop system-audio capture, and
// both panels stay mounted with CSS hiding the inactive one, so an unscoped
// Space started a Listen capture from the Ask tab. The two scopes are kept
// apart from both ends: this handler is inert unless Ask is visible, and the
// Listen handler returns before preventDefault when Listen is not — so exactly
// one of them ever consumes the key. Alt+Space never reaches the Listen
// handler anyway (it requires bare Space plus TextTarget checks of its own).
export const AskPushToTalkKey = ({
  active,
  setEnableVAD,
}: {
  active: boolean;
  setEnableVAD: (value: boolean | ((prev: boolean) => boolean)) => void;
}) => {
  useEffect(() => {
    if (!active) return;

    const handleCombo = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      // The binding IS Alt+Space: bare Space keeps typing, Ctrl/Meta stay out.
      if (!e.altKey || e.ctrlKey || e.metaKey) return;

      // Swallow the combo for whatever has focus, then toggle. `e.repeat` is
      // ignored so holding Alt+Space does not flicker the mic on and off.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;

      // [D4] INSTRUMENTATION (temporary, kept deliberately — see PR): point
      // (b) an Alt+Space that reached the toggle. Deliberately no owner/token
      // here: mic-ownership-check asserts this file stays free of the
      // ownership registry (the key handler must not become an ownership
      // decision point). The snapshot for this press is the
      // [D4][ask-attempt] line the reconcile effect prints in the same tick.
      console.log(`[D4][ask-press space] panel-visible=${active}`);
      setEnableVAD((prev) => !prev);
    };

    window.addEventListener("keydown", handleCombo, true);
    return () => window.removeEventListener("keydown", handleCombo, true);
  }, [active, setEnableVAD]);

  return null;
};
