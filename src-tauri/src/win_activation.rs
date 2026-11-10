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

/// The overlay's OS-level surface facts, read by the focus regression test:
/// after a toggle-show that must NOT have stolen focus, `visible` is true
/// (the no-activate show really surfaced it) while `focused` is false (the
/// user's app keeps the keyboard).
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
