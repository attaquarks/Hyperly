#[cfg(target_os = "macos")]
use tauri::LogicalPosition;
use tauri::{App, AppHandle, Emitter, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

// The offset from the top of the screen to the window
const TOP_OFFSET: i32 = 54;

/// Sets up the main window with custom positioning
pub fn setup_main_window(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // Try different possible window labels
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window("hyperly"))
        .or_else(|| {
            // Get the first window if specific labels don't work
            app.webview_windows().values().next().cloned()
        })
        .ok_or("No window found")?;

    position_window_top_center(&window, TOP_OFFSET)?;

    // A transparent, skip-taskbar overlay looks like "nothing launched" if it
    // stays unfocused or off-screen. Force show and log geometry so a boot
    // failure is visible in the same terminal as Cargo/Vite.
    if let Err(e) = window.show() {
        eprintln!("Failed to show main window: {}", e);
    }
    if let Err(e) = window.unminimize() {
        eprintln!("Failed to unminimize main window (non-fatal): {}", e);
    }
    if let Err(e) = window.set_focus() {
        eprintln!("Failed to focus main window (non-fatal): {}", e);
    }

    let visible = window.is_visible().ok();
    let size = window.outer_size().ok();
    let pos = window.outer_position().ok();
    eprintln!(
        "Main overlay window label={} visible={:?} size={:?} pos={:?}",
        window.label(),
        visible,
        size,
        pos
    );

    // Windows: WebView2 denies getUserMedia unless a PermissionRequested
    // handler approves it, and Tauri only brokers mic access on macOS. Without
    // this the voice input in both Ask and Listen captures nothing.
    crate::mic_permission::allow_microphone(&window);

    Ok(())
}

/// Bridge webview console / boot failures into the same terminal as Cargo.
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    eprintln!("[webview {}] {}", level, message);
}

/// Positions a window at the top center of the screen with a specified Y offset
pub fn position_window_top_center(
    window: &WebviewWindow,
    y_offset: i32,
) -> Result<(), Box<dyn std::error::Error>> {
    // Get the primary monitor
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        // Calculate center X position
        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;

        // Set the window position
        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: y_offset,
        }))?;
    }

    Ok(())
}

/// Future function for centering window completely (both X and Y)
#[allow(dead_code)]
pub fn center_window_completely(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let window_size = window.outer_size()?;

        let center_x = (monitor_size.width as i32 - window_size.width as i32) / 2;
        let center_y = (monitor_size.height as i32 - window_size.height as i32) / 2;

        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: center_y,
        }))?;
    }

    Ok(())
}

/// Centers the window horizontally on the primary monitor at `TOP_OFFSET`.
///
/// Takes the target logical width rather than reading `outer_size()`: the OS
/// reports the old geometry immediately after `set_size`, so measuring the
/// window would center the *previous* size and leave a wide preset off-center.
fn center_window_at_top(
    window: &WebviewWindow,
    logical_width: f64,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(monitor) = window.primary_monitor()? {
        let monitor_size = monitor.size();
        let monitor_pos = monitor.position();
        let scale = window.scale_factor()?;

        let width_px = (logical_width * scale).round() as i32;
        let center_x = monitor_pos.x + (monitor_size.width as i32 - width_px) / 2;

        window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: center_x,
            y: monitor_pos.y + TOP_OFFSET,
        }))?;
    }

    Ok(())
}

#[tauri::command]
pub fn set_window_size(
    window: tauri::WebviewWindow,
    width: u32,
    height: u32,
) -> Result<(), String> {
    use tauri::{LogicalSize, Size};

    // The overlay's only resize path: the footer's size presets. The window is
    // pinned to the top center of the screen, so every preset re-centers after
    // resizing — otherwise a wider preset would grow to the right only.
    let new_size = LogicalSize::new(width as f64, height as f64);
    window
        .set_size(Size::Logical(new_size))
        .map_err(|e| format!("Failed to resize window: {}", e))?;

    center_window_at_top(&window, width as f64)
        .map_err(|e| format!("Failed to recenter window: {}", e))?;

    Ok(())
}

// Async commands: on Windows, `WebviewWindowBuilder::build()` deadlocks when
// called from a *synchronous* command (window creation has to pump the
// main-thread event loop, and a sync command runs on that thread). These were
// sync once — clicking "history" in the Listen room locked the whole overlay
// until restart, in dev AND production builds. Async commands run on the
// runtime's thread pool instead, so creation dispatches to a live main loop.
#[tauri::command]
pub async fn open_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    show_dashboard_window(&app)
}

#[tauri::command]
pub async fn toggle_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        match dashboard_window.is_visible() {
            Ok(true) => {
                // Window is visible, hide it
                dashboard_window
                    .hide()
                    .map_err(|e| format!("Failed to hide dashboard window: {}", e))?;
            }
            Ok(false) => {
                // Window is hidden, show and focus it. `unminimize` is what
                // actually raises a minimized window: `show()` alone leaves a
                // minimized dashboard behind the overlay, unfocused, so the
                // user has to click it (D6).
                dashboard_window
                    .show()
                    .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
                dashboard_window.unminimize().map_err(|e| {
                    format!("Failed to unminimize dashboard window: {}", e)
                })?;
                dashboard_window
                    .set_focus()
                    .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
            }
            Err(e) => {
                return Err(format!("Failed to check dashboard visibility: {}", e));
            }
        }
    } else {
        // Window doesn't exist, create and show it
        show_dashboard_window(&app)?;
    }

    Ok(())
}

#[tauri::command]
pub fn move_window(app: tauri::AppHandle, direction: String, step: i32) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let current_pos = window
            .outer_position()
            .map_err(|e| format!("Failed to get window position: {}", e))?;

        let (new_x, new_y) = match direction.as_str() {
            "up" => (current_pos.x, current_pos.y - step),
            "down" => (current_pos.x, current_pos.y + step),
            "left" => (current_pos.x - step, current_pos.y),
            "right" => (current_pos.x + step, current_pos.y),
            _ => return Err(format!("Invalid direction: {}", direction)),
        };

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
                x: new_x,
                y: new_y,
            }))
            .map_err(|e| format!("Failed to set window position: {}", e))?;
    } else {
        return Err("Main window not found".to_string());
    }

    Ok(())
}

pub fn create_dashboard_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, tauri::Error> {
    let base_builder =
        WebviewWindowBuilder::new(app, "dashboard", tauri::WebviewUrl::App("/chats".into()));

    // macOS: overlay title bar with hidden title and inset traffic lights,
    // shown immediately.
    #[cfg(target_os = "macos")]
    let base_builder = base_builder
        .title("Hyperly - Dashboard")
        .center()
        .decorations(true)
        .inner_size(1200.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .content_protected(true)
        .visible(true)
        .traffic_light_position(LogicalPosition::new(14.0, 18.0));

    #[cfg(not(target_os = "macos"))]
    let base_builder = base_builder
        .title("Hyperly - Dashboard")
        .center()
        .decorations(true)
        .inner_size(1200.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .content_protected(true)
        .visible(false);

    let window = base_builder.build()?;

    // Windows: the dashboard can open the mic too (the Audio Settings page has
    // a voice-sensitivity control, and the Listen panel lives here as well), so
    // it needs the same grant as the overlay.
    crate::mic_permission::allow_microphone(&window);

    // Set up close event handler - hide window instead of destroying it
    setup_dashboard_close_handler(&window);

    Ok(window)
}

/// Sets up the close event handler for the dashboard window
fn setup_dashboard_close_handler<R: Runtime>(window: &WebviewWindow<R>) {
    let window_clone = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Prevent the window from being destroyed
            api.prevent_close();
            // Hide the window instead
            if let Err(e) = window_clone.hide() {
                eprintln!("Failed to hide dashboard window on close: {}", e);
            }
        }
    });
}

/// Shows the dashboard window and brings it to focus
pub fn show_dashboard_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(dashboard_window) = app.get_webview_window("dashboard") {
        // Window exists, show and focus it
        dashboard_window
            .show()
            .map_err(|e| format!("Failed to show dashboard window: {}", e))?;
        dashboard_window
            .set_focus()
            .map_err(|e| format!("Failed to focus dashboard window: {}", e))?;
    } else {
        // Window doesn't exist, create it and then show it
        let window = create_dashboard_window(app)
            .map_err(|e| format!("Failed to create dashboard window: {}", e))?;
        window
            .show()
            .map_err(|e| format!("Failed to show new dashboard window: {}", e))?;
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus new dashboard window: {}", e))?;
    }
    Ok(())
}

// ---- History wing ----------------------------------------------------------
//
// The Listen room's conversation history opens as its own small "wing" bubble
// instead of an in-overlay sheet: a separate transparent window docked to the
// main overlay's top-right with a hairline gap, so it reads as a separate
// bubble that still moves with the main block.

const HISTORY_WING_LABEL: &str = "history-wing";
/// Gap between the main overlay's right edge and the wing, in logical px.
const HISTORY_WING_GAP_LOGICAL: f64 = 10.0;
/// Wing size as a fraction of the main overlay (top-right coverage).
const HISTORY_WING_WIDTH_RATIO: f64 = 0.6;
const HISTORY_WING_HEIGHT_RATIO: f64 = 0.62;
/// Whether the user considers the wing open, so it can follow the main
/// overlay's hide/show toggles without the Listen room re-issuing a command.
static HISTORY_WING_OPEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Wing geometry in physical pixels, clamped inside the main overlay's
/// monitor so a right-docked overlay still gets its wing fully on screen.
fn history_wing_geometry<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(i32, i32, i32, i32, f64), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is missing".to_string())?;
    let scale = main
        .scale_factor()
        .map_err(|e| format!("Failed to read scale factor: {}", e))?;
    let position = main
        .outer_position()
        .map_err(|e| format!("Failed to read main position: {}", e))?;
    let size = main
        .outer_size()
        .map_err(|e| format!("Failed to read main size: {}", e))?;

    let gap = (HISTORY_WING_GAP_LOGICAL * scale).round() as i32;
    let width = ((size.width as f64) * HISTORY_WING_WIDTH_RATIO).round() as i32;
    let height = ((size.height as f64) * HISTORY_WING_HEIGHT_RATIO).round() as i32;
    let mut x = position.x + size.width as i32 + gap;
    let y = position.y;

    if let Ok(Some(monitor)) = main.current_monitor() {
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();
        let max_x = monitor_pos.x + monitor_size.width as i32 - width;
        x = x.clamp(monitor_pos.x, max_x.max(monitor_pos.x));
    }

    Ok((x, y, width, height, scale))
}

fn create_history_wing_window<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WebviewWindow<R>, String> {
    let (x, y, width, height, scale) = history_wing_geometry(app)?;
    // Builder geometry is logical; the measurement was physical.
    let window = WebviewWindowBuilder::new(
        app,
        HISTORY_WING_LABEL,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Hyperly History")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .content_protected(true)
    .visible(true)
    .inner_size(width as f64 / scale, height as f64 / scale)
    .position(x as f64 / scale, y as f64 / scale)
    .build()
    .map_err(|e| format!("Failed to create history wing: {}", e))?;

    // The wing shows history only; it never captures audio itself, but it
    // shares the app origin and the same CSP, so no extra grants are needed
    // beyond the capability entry that lets it invoke commands.
    Ok(window)
}

/// Opens (or reveals and re-docks) the history wing next to the main overlay.
#[tauri::command]
pub async fn open_history_wing(app: AppHandle) -> Result<(), String> {
    let (x, y, _, _, _) = history_wing_geometry(&app)?;
    if let Some(wing) = app.get_webview_window(HISTORY_WING_LABEL) {
        wing.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
            .map_err(|e| format!("Failed to position history wing: {}", e))?;
        wing.show()
            .map_err(|e| format!("Failed to show history wing: {}", e))?;
    } else {
        create_history_wing_window(&app)?;
    }
    HISTORY_WING_OPEN.store(true, std::sync::atomic::Ordering::Release);
    Ok(())
}

/// Hides the wing and tells the Listen room so its toolbar button un-lights.
#[tauri::command]
pub fn close_history_wing(app: AppHandle) -> Result<(), String> {
    HISTORY_WING_OPEN.store(false, std::sync::atomic::Ordering::Release);
    #[cfg(target_os = "windows")]
    crate::win_activation::restore_system_cursor_before_hide();
    if let Some(wing) = app.get_webview_window(HISTORY_WING_LABEL) {
        wing.hide()
            .map_err(|e| format!("Failed to hide history wing: {}", e))?;
    }
    let _ = app.emit("history-wing-closed", ());
    Ok(())
}

/// Keeps the wing glued to the main overlay's top-right while it is dragged.
pub fn setup_history_wing_sync<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    main.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Moved(_)) {
            let Some(wing) = handle.get_webview_window(HISTORY_WING_LABEL) else {
                return;
            };
            if !wing.is_visible().unwrap_or(false) {
                return;
            }
            if let Ok((x, y, _, _, _)) = history_wing_geometry(&handle) {
                let _ = wing.set_position(tauri::Position::Physical(
                    tauri::PhysicalPosition { x, y },
                ));
            }
        }
    });
}

/// Hides the wing alongside the main overlay (Ctrl+\ and the Hide button).
pub fn hide_history_wing_with_main<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "windows")]
    crate::win_activation::restore_system_cursor_before_hide();
    if let Some(wing) = app.get_webview_window(HISTORY_WING_LABEL) {
        let _ = wing.hide();
    }
}

/// Re-reveals the wing after the main overlay returns, if the user had it open.
/// Same foreground rule as the overlay: this runs on the Ctrl+\ show path, so
/// the wing must surface WITHOUT activating (it already builds with
/// `focused(false)`; tauri's `show()` would still activate it via SW_SHOW).
pub fn restore_history_wing_with_main<R: Runtime>(app: &AppHandle<R>) {
    if !HISTORY_WING_OPEN.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    if let Some(wing) = app.get_webview_window(HISTORY_WING_LABEL) {
        if let Ok((x, y, _, _, _)) = history_wing_geometry(app) {
            let _ = wing.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition { x, y },
            ));
        }
        #[cfg(target_os = "windows")]
        if let Err(e) = crate::win_activation::show_window_no_activate(&wing) {
            eprintln!("Failed to restore history wing without activation: {}", e);
            let _ = wing.show();
        }
        #[cfg(not(target_os = "windows"))]
        let _ = wing.show();
    }
}
