//! OS acrylic behind the overlay — the liquid-glass frost.
//!
//! A transparent webview cannot blur the desktop behind it (backdrop-filter
//! has no desktop pixels to sample), so the frost comes from the OS: Windows
//! acrylic via window-vibrancy. The frontend shell keeps its near-opaque
//! fallback until this module CONFIRMS the effect over the
//! `overlay-glass-status` event, so a failure here can never leave overlay
//! text unreadable over a bright desktop.
//!
//! Capture-stealth note: acrylic is window COMPOSITION — orthogonal to
//! SetWindowDisplayAffinity. The capture-protection discipline in
//! win_activation.rs (flag active only while visible) is untouched, and the
//! excluded-from-capture behaviour applies to the whole composited window
//! (acrylic backdrop included).

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, Runtime, WebviewWindow};

/// Dark tint under the acrylic — matches the shell's --hyperly-surface color.
const GLASS_TINT: (u8, u8, u8, u8) = (16, 16, 18, 142);

/// Whether acrylic is CONFIRMED active. The frontend queries this on mount:
/// the startup apply fires before the React tree exists, so an event alone
/// would be missed and the shell would stay on its opaque fallback forever.
static GLASS_ACTIVE: AtomicBool = AtomicBool::new(false);

/// The confirmed acrylic state, for the frontend's mount-time sync.
pub fn is_active() -> bool {
    GLASS_ACTIVE.load(Ordering::Acquire)
}

/// Apply the acrylic effect and REPORT the confirmed state. A failure is not
/// fatal: the frontend keeps its fallback surface.
pub fn apply<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    match window_vibrancy::apply_acrylic(window, Some(GLASS_TINT)) {
        Ok(()) => {
            GLASS_ACTIVE.store(true, Ordering::Release);
            let _ = window.emit("overlay-glass-status", true);
            println!("[glass] acrylic active behind the overlay");
            Ok(())
        }
        Err(e) => {
            GLASS_ACTIVE.store(false, Ordering::Release);
            let _ = window.emit("overlay-glass-status", false);
            println!(
                "[glass] acrylic unavailable: {} (fallback surface stays)",
                e
            );
            Err(format!("acrylic failed: {}", e))
        }
    }
}

/// Remove the acrylic effect and report the fallback surface.
pub fn clear<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    window_vibrancy::clear_acrylic(window).map_err(|e| format!("clear failed: {}", e))?;
    GLASS_ACTIVE.store(false, Ordering::Release);
    let _ = window.emit("overlay-glass-status", false);
    println!("[glass] acrylic cleared — fallback surface active");
    Ok(())
}

/// Startup hook: apply the effect immediately so the enabled path never shows
/// an unblurred flash. Best-effort — a failure only means the frontend keeps
/// its fallback. The stored preference is synced right after by the frontend
/// (set_overlay_glass), which clears it for users who turned the effect off.
pub fn apply_at_startup<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = apply(&window);
    }
}
