import { STORAGE_KEYS } from "@/config";

export type CursorType = "invisible" | "default" | "auto";

export interface CustomizableState {
  appIcon: {
    isVisible: boolean;
  };
  alwaysOnTop: {
    isEnabled: boolean;
  };
  cursor: {
    type: CursorType;
  };
}

export const DEFAULT_CUSTOMIZABLE_STATE: CustomizableState = {
  appIcon: { isVisible: true },
  alwaysOnTop: { isEnabled: false },
  cursor: { type: "default" },
};

/**
 * One-time migration marker. The cursor default used to be "invisible": the
 * overlay webview set `cursor: none`, and because the Win32 cursor is a
 * stateful shape — the window under the mouse re-sets it only via
 * WM_SETCURSOR — hiding the overlay left a STALE hidden cursor over the
 * region it occupied (the foreground app showed no pointer until it happened
 * to re-set one). The default is now a visible cursor, and any stored
 * "invisible" that came from that old default is migrated once, below.
 * After the marker exists, an explicitly re-chosen "invisible" is honored
 * as-is (the Rust hide path hands the cursor back to the system cleanly).
 */
const CURSOR_VISIBLE_DEFAULT_MIGRATION_KEY = "hyperly.cursor-visible-default-migrated";

/**
 * Get customizable state from localStorage
 */
export const getCustomizableState = (): CustomizableState => {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.CUSTOMIZABLE);
    if (!stored) {
      return DEFAULT_CUSTOMIZABLE_STATE;
    }

    const parsedState = JSON.parse(stored);

    const state: CustomizableState = {
      appIcon: parsedState.appIcon || DEFAULT_CUSTOMIZABLE_STATE.appIcon,
      alwaysOnTop:
        parsedState.alwaysOnTop || DEFAULT_CUSTOMIZABLE_STATE.alwaysOnTop,
      cursor: parsedState.cursor || DEFAULT_CUSTOMIZABLE_STATE.cursor,
    };

    // One-time migration of the old "invisible" default (see the marker doc
    // above). Runs once per browser profile; a later explicit choice from the
    // settings UI is never touched again.
    if (!localStorage.getItem(CURSOR_VISIBLE_DEFAULT_MIGRATION_KEY)) {
      localStorage.setItem(CURSOR_VISIBLE_DEFAULT_MIGRATION_KEY, "1");
      if (state.cursor.type === "invisible") {
        const migrated = { ...state, cursor: { type: "default" as CursorType } };
        setCustomizableState(migrated);
        return migrated;
      }
    }

    return state;
  } catch (error) {
    console.error("Failed to get customizable state:", error);
    return DEFAULT_CUSTOMIZABLE_STATE;
  }
};

/**
 * Save customizable state to localStorage
 */
export const setCustomizableState = (state: CustomizableState): void => {
  try {
    localStorage.setItem(STORAGE_KEYS.CUSTOMIZABLE, JSON.stringify(state));
  } catch (error) {
    console.error("Failed to save customizable state:", error);
  }
};

/**
 * Update app icon visibility
 */
export const updateAppIconVisibility = (
  isVisible: boolean
): CustomizableState => {
  const currentState = getCustomizableState();
  const newState = { ...currentState, appIcon: { isVisible } };
  setCustomizableState(newState);
  return newState;
};

/**
 * Update always on top state
 */
export const updateAlwaysOnTop = (isEnabled: boolean): CustomizableState => {
  const currentState = getCustomizableState();
  const newState = { ...currentState, alwaysOnTop: { isEnabled } };
  setCustomizableState(newState);
  return newState;
};

/**
 * Update cursor type
 */
export const updateCursorType = (type: CursorType): CustomizableState => {
  const currentState = getCustomizableState();
  const newState = { ...currentState, cursor: { type } };
  setCustomizableState(newState);
  return newState;
};
