import { useEffect } from "react";

const TEXT_FIELD_TAGS = ["INPUT", "TEXTAREA", "SELECT"];

// The composer is a text field, so Space has to keep typing here. Push-to-talk
// therefore only takes the key when focus is somewhere else in the panel —
// clicking the panel, a button, or the body.
const isTextTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (TEXT_FIELD_TAGS.includes(target.tagName)) return true;
  const role = target.getAttribute("role");
  return target.isContentEditable || role === "textbox" || role === "searchbox";
};

// Space toggles the Ask mic — but only while the Ask panel is the visible one.
//
// Listen binds the same key to start/stop system-audio capture, and both
// panels stay mounted with CSS hiding the inactive one, so an unscoped Space
// started a Listen capture from the Ask tab. The two scopes are kept apart from
// both ends: this handler is inert unless Ask is visible, and the Listen
// handler returns before preventDefault when Listen is not — so exactly one of
// them ever consumes the key.
export const AskPushToTalkKey = ({
  active,
  setEnableVAD,
}: {
  active: boolean;
  setEnableVAD: (value: boolean | ((prev: boolean) => boolean)) => void;
}) => {
  useEffect(() => {
    if (!active) return;

    const handleSpace = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextTarget(e.target)) return;

      // Swallow the key for whatever has focus, then toggle. `e.repeat` is
      // ignored so holding Space does not flicker the mic on and off.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;

      setEnableVAD((prev) => !prev);
    };

    window.addEventListener("keydown", handleSpace, true);
    return () => window.removeEventListener("keydown", handleSpace, true);
  }, [active, setEnableVAD]);

  return null;
};
