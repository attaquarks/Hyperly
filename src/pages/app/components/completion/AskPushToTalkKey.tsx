import { useEffect } from "react";

const TEXT_FIELD_TAGS = ["INPUT", "TEXTAREA", "SELECT"];

// The composer is a text field, so Space has to keep typing there. The mic
// toggle therefore only takes the key when focus is somewhere else in the
// panel — clicking the panel, a button, or the body. That is the product rule:
// focus in the input bar → Space types; focus anywhere else → Space is the mic.
const isTextTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (TEXT_FIELD_TAGS.includes(target.tagName)) return true;
  const role = target.getAttribute("role");
  return (
    target.isContentEditable || role === "textbox" || role === "searchbox"
  );
};

// Space toggles the Ask mic — exactly one function per press — but only while
// the Ask panel is visible, and never while a text field has focus.
//
// WHY NOT ALT+SPACE (D2's binding, removed on request): Alt+Space never
// reached this handler AT ALL. It was a pure DOM listener — D2 changed only
// this file, and no Rust code registers Alt+Space (the accelerator list in
// src-tauri contains no such binding) — but on Windows Alt+Space is the
// window system-menu accelerator: the host window consumes it
// (WM_SYSCOMMAND / SC_KEYMENU) before Chromium can dispatch a keydown to the
// page. This overlay is created with `decorations: false`, so there is not
// even a system menu to show — the combo was swallowed silently, with zero
// visible effect, on every press. Mouse clicks and the global Voice Input
// shortcut never traverse that path, which is exactly why they worked while
// the panel shortcut did nothing. Live confirmation: the
// `[D4][ask-press space]` line below never appeared for an Alt+Space press,
// and does for a bare Space.
//
// Why plain Space is right despite D2's composer-focus complaint: the rule is
// focus-based, so the "focus sits in the composer after a send" case has an
// explicit answer — one click anywhere on the panel moves focus, then Space
// is the mic again. While a text field HAS focus, Space types (untouched
// default). Everywhere else this capture-phase listener swallows the key
// before anything else sees it, so a single press does one thing only: no
// page scroll, no focused-button activation, no Listen-side capture.
//
// Listen binds the same physical key to start/stop system-audio capture, and
// both panels stay mounted with CSS hiding the inactive one, so an unscoped
// Space started a Listen capture from the Ask tab. The two scopes are kept
// apart from both ends: this handler is inert unless Ask is visible (`active`
// arrives as `!isHidden && mode === "ask"` from app/index), and the Listen
// handler returns before preventDefault when Listen is not active
// (`panelActiveRef` in useSystemAudio) — so exactly one of them ever consumes
// the key.
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
      // The composer keeps Space for typing; everywhere else it is the mic.
      if (isTextTarget(e.target)) return;

      // Swallow the key for whatever has focus, then toggle. `e.repeat` is
      // ignored so holding Space does not flicker the mic on and off.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;

      // [D4] INSTRUMENTATION (temporary, kept deliberately — see PR): point
      // (b) a Space that reached the toggle. Deliberately no owner/token
      // here: mic-ownership-check asserts this file stays free of the
      // ownership registry (the key handler must not become an ownership
      // decision point). The snapshot for this press is the
      // [D4][ask-attempt] line the reconcile effect prints in the same tick.
      console.log(`[D4][ask-press space] panel-visible=${active}`);
      setEnableVAD((prev) => !prev);
    };

    window.addEventListener("keydown", handleSpace, true);
    return () => window.removeEventListener("keydown", handleSpace, true);
  }, [active, setEnableVAD]);

  return null;
};
