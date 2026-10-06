import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { getShortcutsConfig } from "@/lib";

// Global singleton to prevent multiple event listeners in StrictMode
let globalEventListeners: {
  focus?: UnlistenFn;
  audio?: UnlistenFn;
  screenshot?: UnlistenFn;
  systemAudio?: UnlistenFn;
  customShortcut?: UnlistenFn;
  registrationError?: UnlistenFn;
} = {};

// Global debounce for screenshot events to prevent duplicates
let lastScreenshotEventTime = 0;

// Global callback refs. NOTE: `globalInputRef` (and the `registerInputRef`
// plumbing around it) is dead: the focus-text-input handler used to focus it
// after a 100 ms shot, but D5 focuses the real composer element directly via
// the "hyperly:focus-ask-input" DOM event instead. Kept (not deleted) so the
// exported `registerInputRef` API stays intact for any external caller.
let globalInputRef: HTMLInputElement | null = null;
let globalAudioCallback: (() => void) | null = null;
let globalScreenshotCallback: (() => void | Promise<void>) | null = null;
// D10: Listen registers its own screenshot capture here. Ask and Listen both
// stay mounted in every mode, so both screenshot callbacks are live at once —
// the single debounced `trigger-screenshot` listener below picks between them
// using `globalScreenshotPanel`, so the shot lands on the panel that was
// visible instead of always running Ask's pipeline.
let globalListenScreenshotCallback: (() => void | Promise<void>) | null = null;
// D10: which panel the global screenshot shortcut routes to. Fed by
// app/index.tsx, which owns the live `mode`; read at fire time so a room
// switch after mount is honoured. Defaults to Ask (unchanged behaviour) until
// the getter registers.
let globalScreenshotPanel: () => "ask" | "listen" = () => "ask";
let globalSystemAudioCallback: (() => void) | null = null;
let globalCustomShortcutCallbacks: Map<string, () => void> = new Map();

export const useGlobalShortcuts = () => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const audioCallbackRef = useRef<(() => void) | null>(null);
  const screenshotCallbackRef = useRef<(() => void) | null>(null);
  const systemAudioCallbackRef = useRef<(() => void) | null>(null);
  const customShortcutCallbacksRef = useRef<Map<string, () => void>>(new Map());

  const checkShortcutsRegistered = useCallback(async (): Promise<boolean> => {
    try {
      const registered = await invoke<boolean>("check_shortcuts_registered");
      return registered;
    } catch (error) {
      console.error("Failed to check shortcuts:", error);
      return false;
    }
  }, []);

  const getShortcuts = useCallback(async (): Promise<Record<
    string,
    string
  > | null> => {
    try {
      const shortcuts = await invoke<Record<string, string>>(
        "get_registered_shortcuts"
      );
      return shortcuts;
    } catch (error) {
      console.error("Failed to get shortcuts:", error);
      return null;
    }
  }, []);

  const updateShortcuts = useCallback(async (): Promise<boolean> => {
    try {
      const config = getShortcutsConfig();
      await invoke("update_shortcuts", { config });
      return true;
    } catch (error) {
      console.error("Failed to update shortcuts:", error);
      return false;
    }
  }, []);

  // Register input element for auto-focus. D5: retained for API shape —
  // `useCompletion` still calls it — but the focus-text-input path no longer
  // reads this ref; it focuses the real composer via the DOM event instead.
  // `void` keeps the intentionally-unused ref from tripping noUnusedLocals.
  const registerInputRef = useCallback((input: HTMLInputElement | null) => {
    inputRef.current = input;
    globalInputRef = input;
    void globalInputRef;
  }, []);

  // Register audio callback
  const registerAudioCallback = useCallback((callback: () => void) => {
    audioCallbackRef.current = callback;
    globalAudioCallback = callback;
  }, []);

  // Register screenshot callback
  const registerScreenshotCallback = useCallback(
    (callback: () => void | Promise<void>) => {
      screenshotCallbackRef.current = callback;
      globalScreenshotCallback = callback;
    },
    []
  );

  // D10: register Listen's screenshot callback. Separate from Ask's
  // `registerScreenshotCallback` because both rooms stay mounted; the debounced
  // listener routes between the two via `registerScreenshotPanel`.
  const registerListenScreenshotCallback = useCallback(
    (callback: (() => void | Promise<void>) | null) => {
      globalListenScreenshotCallback = callback;
    },
    []
  );

  // D10: register the panel getter the screenshot listener routes by. Owned by
  // app/index.tsx (it holds the live `mode`); defaults to Ask when unset.
  const registerScreenshotPanel = useCallback(
    (getPanel: () => "ask" | "listen") => {
      globalScreenshotPanel = getPanel;
    },
    []
  );

  // Register system audio callback
  const registerSystemAudioCallback = useCallback((callback: () => void) => {
    systemAudioCallbackRef.current = callback;
    globalSystemAudioCallback = callback;
  }, []);

  // Register custom shortcut callback
  const registerCustomShortcutCallback = useCallback(
    (actionId: string, callback: () => void) => {
      customShortcutCallbacksRef.current.set(actionId, callback);
      globalCustomShortcutCallbacks.set(actionId, callback);
    },
    []
  );

  // Unregister custom shortcut callback
  const unregisterCustomShortcutCallback = useCallback((actionId: string) => {
    customShortcutCallbacksRef.current.delete(actionId);
    globalCustomShortcutCallbacks.delete(actionId);
  }, []);

  // Setup event listeners using global singleton
  useEffect(() => {
    const setupEventListeners = async () => {
      try {
        // Clean up any existing global listeners first
        if (globalEventListeners.focus) {
          try {
            globalEventListeners.focus();
          } catch (error) {
            console.warn("Error cleaning up focus listener:", error);
          }
        }
        if (globalEventListeners.audio) {
          try {
            globalEventListeners.audio();
          } catch (error) {
            console.warn("Error cleaning up audio listener:", error);
          }
        }
        if (globalEventListeners.screenshot) {
          try {
            globalEventListeners.screenshot();
          } catch (error) {
            console.warn("Error cleaning up screenshot listener:", error);
          }
        }
        if (globalEventListeners.systemAudio) {
          try {
            globalEventListeners.systemAudio();
          } catch (error) {
            console.warn("Error cleaning up system audio listener:", error);
          }
        }
        if (globalEventListeners.customShortcut) {
          try {
            globalEventListeners.customShortcut();
          } catch (error) {
            console.warn("Error cleaning up custom shortcut listener:", error);
          }
        }
        if (globalEventListeners.registrationError) {
          try {
            globalEventListeners.registrationError();
          } catch (error) {
            console.warn(
              "Error cleaning up shortcut registration error listener:",
              error
            );
          }
        }

        // D5: focus-text-input is owned entirely by app/index.tsx now (room
        // switch + retried "hyperly:focus-ask-input" dispatch + mid-capture
        // guard). No second listener here: two dispatchers would double-focus,
        // and an unguarded one would steal keyboard focus off a live
        // transcript mid-capture.
        globalEventListeners.focus = undefined;

        // Listen for audio recording event
        const unlistenAudio = await listen("start-audio-recording", () => {
          if (globalAudioCallback) {
            globalAudioCallback();
          }
        });
        globalEventListeners.audio = unlistenAudio;

        // Listen for screenshot trigger event with debouncing
        const unlistenScreenshot = await listen("trigger-screenshot", () => {
          const now = Date.now();
          const timeSinceLastEvent = now - lastScreenshotEventTime;

          // Debounce screenshot events (300ms minimum interval)
          if (timeSinceLastEvent < 300) {
            return;
          }

          lastScreenshotEventTime = now;

          // D10: route the shot to the panel that was visible at fire time.
          // Ask and Listen each register their own capture; the panel getter
          // (fed by app/index, which owns `mode`) decides which runs. Exactly
          // one debounce — this block — covers both paths, so a double-fire
          // cannot return. This single `trigger-screenshot` listener is the
          // only one that captures; app/index no longer runs a second,
          // no-op listener for the same event.
          const panel = globalScreenshotPanel();
          const screenshotCallback =
            panel === "listen"
              ? globalListenScreenshotCallback
              : globalScreenshotCallback;

          if (screenshotCallback) {
            try {
              Promise.resolve(screenshotCallback())
                .catch((error) => {
                  console.error("Screenshot shortcut callback failed:", error);
                })
                .then(() => {
                  // no-op
                });
            } catch (error) {
              console.error(
                "Failed to run screenshot shortcut callback:",
                error
              );
            }
          } else {
            console.warn(
              "Screenshot shortcut triggered but no callback registered."
            );
          }
        });
        globalEventListeners.screenshot = unlistenScreenshot;

        // Listen for system audio toggle event
        const unlistenSystemAudio = await listen("toggle-system-audio", () => {
          if (globalSystemAudioCallback) {
            globalSystemAudioCallback();
          }
        });
        globalEventListeners.systemAudio = unlistenSystemAudio;

        // Listen for custom shortcut events
        const unlistenCustomShortcut = await listen<{ action: string }>(
          "custom-shortcut-triggered",
          (event) => {
            const actionId = event.payload.action;
            const callback = globalCustomShortcutCallbacks.get(actionId);
            if (callback) {
              callback();
            } else {
              console.warn(
                `No callback registered for custom shortcut: ${actionId}`
              );
            }
          }
        );
        globalEventListeners.customShortcut = unlistenCustomShortcut;

        const unlistenRegistrationError = await listen<
          Array<[string, string, string]>
        >("shortcut-registration-error", (event) => {
          window.dispatchEvent(
            new CustomEvent("shortcutRegistrationError", {
              detail: event.payload,
            })
          );
        });
        globalEventListeners.registrationError = unlistenRegistrationError;
      } catch (error) {
        console.error("Failed to setup event listeners:", error);
      }
    };

    setupEventListeners();
  }, []);

  return {
    checkShortcutsRegistered,
    getShortcuts,
    updateShortcuts,
    registerInputRef,
    registerAudioCallback,
    registerScreenshotCallback,
    registerListenScreenshotCallback,
    registerScreenshotPanel,
    registerSystemAudioCallback,
    registerCustomShortcutCallback,
    unregisterCustomShortcutCallback,
  };
};
