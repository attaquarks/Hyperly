import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect } from "react";

// Helper function to check if any popover is open in the DOM
const isAnyPopoverOpen = (): boolean => {
  const popoverContents = document.querySelectorAll(
    "[data-radix-popper-content-wrapper]"
  );
  return popoverContents.length > 0;
};

// The overlay is a compact, undecorated window pinned to the top of the screen.
// The collapsed height MUST be tall enough to render the header (~42px) plus the
// composer row (~54px). At the old 54px value the body was clipped by
// `overflow: hidden`, so only the top bar was visible.
export const OVERLAY_COLLAPSED_HEIGHT = 96;
export const OVERLAY_EXPANDED_HEIGHT = 540;

// Module-level pin flag. When the user explicitly expands the overlay with the
// maximize control, auto-collapse (drag mouseup + DOM observer) must not snap it
// back to the bar. Shared across every useWindowResize instance on purpose.
let overlayPinnedOpen = false;

export const setOverlayPinnedOpen = (pinned: boolean) => {
  overlayPinnedOpen = pinned;
};

export const isOverlayPinnedOpen = () => overlayPinnedOpen;

export const useWindowResize = () => {
  const resizeWindow = useCallback(async (expanded: boolean) => {
    try {
      const window = getCurrentWebviewWindow();

      if (!expanded && (isAnyPopoverOpen() || isOverlayPinnedOpen())) {
        return;
      }

      // Keep the overlay well above the Windows taskbar (~40-48px tall)
      // 540px = ~90% of a 1080p screen, leaves room for the taskbar
      const newHeight = expanded
        ? OVERLAY_EXPANDED_HEIGHT
        : OVERLAY_COLLAPSED_HEIGHT;

      await invoke("set_window_height", {
        window,
        height: newHeight,
      });
    } catch (error) {
      console.error("Failed to resize window:", error);
    }
  }, []);

  // Setup drag handling and popover monitoring
  useEffect(() => {
    let isDragging = false;

    const handleMouseDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // Tauri drag regions are marked with data-tauri-drag-region="true"
    // (sometimes also "false" — both treated as non-drag here).
    const dragRegion = target.closest('[data-tauri-drag-region="true"]');
    if (dragRegion) {
      isDragging = true;
    }
  };

  const handleMouseUp = async () => {
    if (isDragging) {
      isDragging = false;
      // Give the OS time to finish the drag before resizing.
      setTimeout(() => {
        if (!isAnyPopoverOpen()) {
          resizeWindow(false);
        }
      }, 100);
    }
  };

    const observer = new MutationObserver(() => {
      if (!isAnyPopoverOpen()) {
        resizeWindow(false);
      }
    });

    // Observe the body for changes to detect popover open/close
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mouseup", handleMouseUp);
      observer.disconnect();
    };
  }, [resizeWindow]);

  return { resizeWindow };
};

interface UseWindowFocusOptions {
  onFocusLost?: () => void;
  onFocusGained?: () => void;
}

export const useWindowFocus = ({
  onFocusLost,
  onFocusGained,
}: UseWindowFocusOptions = {}) => {
  const handleFocusChange = useCallback(
    async (focused: boolean) => {
      if (focused && onFocusGained) {
        onFocusGained();
      } else if (!focused && onFocusLost) {
        onFocusLost();
      }
    },
    [onFocusLost, onFocusGained]
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupFocusListener = async () => {
      try {
        const window = getCurrentWebviewWindow();

        // Listen to focus change events
        unlisten = await window.onFocusChanged(({ payload: focused }) => {
          handleFocusChange(focused);
        });
      } catch (error) {
        console.error("Failed to setup focus listener:", error);
      }
    };

    setupFocusListener();

    // Cleanup
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [handleFocusChange]);
};
