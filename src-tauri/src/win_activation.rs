//! Surface a window WITHOUT taking the desktop foreground.
//!
//! Tauri's `show()` maps to `ShowWindow(SW_SHOW)`, which activates the window,
//! and `set_focus()` calls `SetForegroundWindow`. Either one makes Hyperly the
//! foreground window — which is exactly what the overlay must never do when a
//! shortcut fires: the previously active app (a fullscreen browser, a meeting
//! client) loses its presentation and the taskbar pops back over it. The Win32
//! non-activating primitives are the fix at the window-lifecycle level: the
//! window appears above the fullscreen foreground app and stays fully
//! mouse-interactive (a click focuses it through the normal user path), while
//! keyboard focus stays with whatever the user was in.
//!
//! macOS does not need the Win32 path: the overlay is an NSPanel with the
//! `NSWindowStyleMaskNonActivatingPanel` style mask (see lib.rs `init`), so
//! its show/focus path is already non-activating by construction.

use tauri::{Manager, Runtime, WebviewWindow};

/// Show (or restore from minimized) without activating, and re-assert the
/// topmost z-order without activating. Windows implementation; other targets
/// never call it (their show paths are cfg-gated in the callers).
///
/// - `ShowWindow(SW_SHOWNOACTIVATE)`: displays the window in its most recent
///   size and position, restoring a minimized window, without activating it.
///   Replaces both `window.show()` (`SW_SHOW` — activates) and
///   `window.unminimize()` (activates a minimized window).
/// - `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE | SWP_SHOWWINDOW | NOMOVE |
///   NOSIZE)`: surfaces the window in the topmost band above the current
///   foreground app without stealing its foreground.
#[cfg(target_os = "windows")]
pub fn show_window_no_activate<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
    };

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("Failed to get native HWND: {}", e))?;

    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SET_WINDOW_POS_FLAGS(SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOACTIVATE.0 | SWP_SHOWWINDOW.0),
        );
    }

    Ok(())
}

/// Turn the window's capture protection (WDA_EXCLUDEFROMCAPTURE) on or off.
///
/// THE STEALTH RULE: the affinity flag may be active ONLY while the window is
/// actually visible. Tauri's `content_protected(true)` sets the flag once at
/// creation and leaves it on for the window's whole lifetime — including while
/// hidden. On WebView2's composition surfaces that is exactly what screen
/// capture stacks render as a STATIC BLACK BOX: the flag survives hide/show
/// cycles, the ghost persists while the window is hidden, and it vanishes only
/// when the whole app minimizes (the reported failure). Every hide path must
/// clear the flag BEFORE the hide, and every show path must re-apply it AFTER
/// the window surfaces — protection stays on while visible, and a hidden
/// window carries nothing for a capture stack to paint black.
#[cfg(target_os = "windows")]
pub fn set_capture_protection<R: Runtime>(window: &WebviewWindow<R>, protected: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    unsafe {
        // A failed toggle must never break the hide/show flow: the previous
        // state persists (which is safe — worst case is the old behavior).
        let _ = SetWindowDisplayAffinity(
            hwnd,
            if protected { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE },
        );
    }
}

/// Hand the mouse back to the system before a window hides.
///
/// Two properties must be released, or the hidden window keeps eating input
/// in the region it occupied (the reported "cursor stays attached with the
/// overlay; clicks and scroll behind it do nothing"):
///
/// 1. **Mouse capture.** Chromium's renderer holds the Win32 mouse capture
///    during drags and selections inside the web content. A hidden window
///    that still owns the capture keeps receiving (and swallowing) every
///    mouse event. `ReleaseCapture` drops any capture held by this thread's
///    windows — the webview child was created on our thread, so its capture
///    belongs here.
/// 2. **The stale cursor shape** (the stateful WM_SETCURSOR issue — see the
///    cursor fix below).
///
/// Both calls are no-ops when nothing is held/hovering. No input is
/// simulated and no foreground changes hands.
#[cfg(target_os = "windows")]
pub fn release_input_before_hide() {
    use windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
    use windows::Win32::UI::WindowsAndMessaging::{IDC_ARROW, LoadCursorW, SetCursor};

    unsafe {
        // Drop any mouse capture held by this thread's windows FIRST, so the
        // hidden window cannot keep swallowing clicks and scroll.
        let _ = ReleaseCapture();
        // Re-assert a visible cursor as the last shape the system saw.
        if let Ok(arrow) = LoadCursorW(None, IDC_ARROW) {
            let _ = SetCursor(Some(arrow));
        }
    }
}

/// Hide a window and GUARANTEE the foreground gets its mouse back.
///
/// `window.hide()` (SW_HIDE) normally suffices — a hidden window cannot be
/// hit-tested. As the belt-and-suspenders for the input-retention failure
/// mode, the visibility is verified after the hide: if the window is somehow
/// still visible, it is MINIMIZED instead — a minimized window provably
/// returns the mouse to the foreground app (the user-verified reference
/// behavior). Either way the region the window occupied becomes inert.
#[cfg(target_os = "windows")]
pub fn hide_and_release_input<R: Runtime>(window: &WebviewWindow<R>) {
    release_input_before_hide();
    if let Err(e) = window.hide() {
        eprintln!("Failed to hide window: {}", e);
    }
    // Verify: a still-visible window would keep eating the region's input.
    if window.is_visible().unwrap_or(false) {
        eprintln!("Window still visible after hide — minimizing as fallback");
        let _ = window.minimize();
    }
}

/// The overlay's OS-level surface facts, read by the focus regression test:
/// after a toggle-show that must NOT have stolen focus, `visible` is true
/// (the no-activate show returns the overlay to view) while `focused` is
/// false (the user's app keeps the keyboard).
#[derive(serde::Serialize)]
pub struct OverlaySurfaceState {
    pub visible: bool,
    pub focused: bool,
}

#[tauri::command]
pub fn overlay_surface_state<R: Runtime>(app: tauri::AppHandle<R>) -> Result<OverlaySurfaceState, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("Main window not found".to_string());
    };

    let visible = window
        .is_visible()
        .map_err(|e| format!("Failed to read window visibility: {}", e))?;

    #[cfg(target_os = "windows")]
    let focused = {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

        let hwnd = window
            .hwnd()
            .map_err(|e| format!("Failed to get native HWND: {}", e))?;
        let foreground = unsafe { GetForegroundWindow() };
        foreground == hwnd
    };

    #[cfg(not(target_os = "windows"))]
    let focused = window
        .is_focused()
        .map_err(|e| format!("Failed to read window focus: {}", e))?;

    Ok(OverlaySurfaceState { visible, focused })
}
