// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod capture;
mod db;
mod mic_permission;
mod shortcuts;
mod startup;
mod window;
use std::sync::{Arc, Mutex};
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::{AppHandle, WebviewWindow};
#[cfg(target_os = "macos")]
#[allow(deprecated)]
use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, panel_delegate, WebviewWindowExt};
// PostHog analytics removed for the personal build.
use tokio::task::JoinHandle;
mod speaker;
mod win_activation;
mod byok;
mod stt_stream;
use capture::CaptureState;
use speaker::{ReferenceTap, VadConfig};


#[derive(Default)]
pub struct AudioState {
    stream_task: Arc<Mutex<Option<JoinHandle<()>>>>,
    vad_config: Arc<Mutex<VadConfig>>,
    is_capturing: Arc<Mutex<bool>>,
    reference_tap: Arc<Mutex<Option<ReferenceTap>>>,
    capture_sample_rate: Arc<Mutex<Option<u32>>>,
    /// Cooperative stop for the capture task: set by
    /// `stop_system_audio_capture` so the VAD loop can flush the in-flight
    /// utterance (emit it as a final) instead of being aborted mid-speech,
    /// which is what truncated the transcript the LLM received. Aborting
    /// remains the backstop for a stalled stream.
    stop_requested: Arc<std::sync::atomic::AtomicBool>,
    /// The live streaming-STT session (Tier 2): when Some, the capture loop
    /// feeds hops into it and transcripts arrive as `stt-stream-*` text
    /// events instead of the batch audio round trip.
    stt_streaming: Arc<Mutex<Option<stt_stream::SttStreamSession>>>,
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Turn the streaming-STT session on/off for the next capture. The frontend
/// calls this at session start with the selected provider's BYOK config when
/// streaming was detected for it, and with `None` at stop.
#[tauri::command]
async fn configure_stt_streaming(
    app: tauri::AppHandle,
    config: Option<stt_stream::SttStreamConfig>,
) -> Result<(), String> {
    let state = app.state::<AudioState>();
    let mut session = state.stt_streaming.lock().map_err(|e| e.to_string())?;
    // Tear down any previous session first.
    if let Some(old) = session.take() {
        old.task.abort();
    }
    *session = match config {
        Some(config) => Some(
            stt_stream::spawn_session(app.clone(), config)
                .map_err(|e| format!("Streaming session failed to start: {}", e))?,
        ),
        None => None,
    };
    Ok(())
}

/// Streaming capability detection: a REAL WebSocket handshake against the
/// provider, surfaced as the dashboard's green/red light.
#[tauri::command]
async fn byok_test_streaming(
    base_url: String,
    api_key: String,
    model: String,
) -> Result<stt_stream::StreamingSupport, String> {
    let config = stt_stream::SttStreamConfig {
        base_url,
        api_key,
        model,
    };
    Ok(stt_stream::detect_streaming_support(&config).await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Migrate the legacy pluely database into the Hyperly app-data dir BEFORE
    // the SQL plugin preload opens (and, on Windows, locks) the database file.
    db::migrate_legacy_database();

    // PostHog analytics removed for the personal build.
    // `mut` is only exercised on macOS, where the NSPanel and permissions
    // plugins are registered after this shared chain.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:hyperly.db", db::migrations())
                .build(),
        )
        .manage(AudioState::default())
        .manage(CaptureState::default())
        .manage(shortcuts::WindowVisibility {
            is_hidden: Mutex::new(false),
        })
        .manage(shortcuts::RegisteredShortcuts::default())
        .manage(shortcuts::MoveWindowState::default())
        .plugin(tauri_plugin_opener::init())
        // tauri_plugin_updater removed for the personal build.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init()) // Shell plugin
        // Global shortcut plugin MUST be registered on the builder, BEFORE
        // .setup(): the dashboard webview invokes `update_shortcuts` as soon as
        // it loads, and any earlier global_shortcut() access panics with
        // "state() called before manage()" if the plugin isn't managed yet.
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

                    let action_id = {
                        let state = app.state::<shortcuts::RegisteredShortcuts>();
                        let registered = match state.shortcuts.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => {
                                eprintln!("Mutex poisoned in handler, recovering...");
                                poisoned.into_inner()
                            }
                        };

                        registered.iter().find_map(|(action_id, shortcut_str)| {
                            if let Ok(s) = shortcut_str.parse::<Shortcut>() {
                                if &s == shortcut {
                                    return Some(action_id.clone());
                                }
                            }
                            None
                        })
                    };

                    if let Some(action_id) = action_id {
                        match event.state() {
                            ShortcutState::Pressed => {
                                if let Some(direction) =
                                    action_id.strip_prefix("move_window_")
                                {
                                    shortcuts::start_move_window(app, direction);
                                } else {
                                    eprintln!("Shortcut triggered: {}", action_id);
                                    shortcuts::handle_shortcut_action(app, &action_id);
                                }
                            }
                            ShortcutState::Released => {
                                if let Some(direction) =
                                    action_id.strip_prefix("move_window_")
                                {
                                    shortcuts::stop_move_window(app, direction);
                                }
                            }
                        }
                    }
                })
                .build(),
        );
        // Test-only WDIO bridge, compiled in exclusively via the `wdio` cargo
        // feature (desktop E2E builds). See Cargo.toml [features].
        #[cfg(feature = "wdio")]
        let builder = builder
            .plugin(tauri_plugin_wdio_webdriver::init())
            .plugin(tauri_plugin_wdio::init());
        // `mut` is exercised on macOS below (NSPanel + permissions plugins).
        #[allow(unused_mut)]
        let mut builder = builder
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            configure_stt_streaming,
            byok_test_streaming,
            window::set_window_size,
            window::open_dashboard,
            window::open_history_wing,
            window::close_history_wing,
            window::toggle_dashboard,
            window::move_window,
            window::log_frontend,
            capture::capture_to_base64,
            capture::start_screen_capture,
            capture::capture_selected_area,
            capture::close_overlay_window,
            shortcuts::check_shortcuts_registered,
            shortcuts::get_registered_shortcuts,
            shortcuts::update_shortcuts,
            shortcuts::validate_shortcut_key,
            shortcuts::set_app_icon_visibility,
            shortcuts::set_always_on_top,
            shortcuts::exit_app,
            shortcuts::toggle_main_window,
            win_activation::overlay_surface_state,
            byok::byok_test_connection,
            speaker::start_system_audio_capture,
            speaker::stop_system_audio_capture,
            speaker::start_aec_reference,
            speaker::stop_aec_reference,
            speaker::manual_stop_continuous,
            speaker::check_system_audio_access,
            speaker::request_system_audio_access,
            speaker::get_vad_config,
            speaker::update_vad_config,
            speaker::get_capture_status,
            speaker::get_audio_sample_rate,
            speaker::get_input_devices,
            speaker::get_output_devices,
            mic_permission::set_mic_consent,
        ])
        .setup(|app| {
            // Remove registrations left by releases that supported autostart.
            startup::remove_legacy_autostart();
            // Setup main window positioning
            window::setup_main_window(app).expect("Failed to setup main window");
            // Keep the history wing glued to the overlay while it is dragged.
            window::setup_history_wing_sync(app.handle());
            // Convert the overlay window into a floating NSPanel (macOS only).
            #[cfg(target_os = "macos")]
            init(app.app_handle());
            let app_handle = app.handle();
            if app_handle.get_webview_window("dashboard").is_none() {
                if let Err(e) = window::create_dashboard_window(&app_handle) {
                    eprintln!("Failed to pre-create dashboard window on startup: {}", e);
                }
            }

            // Global shortcut plugin is registered on the builder above (must
            // precede window creation). Only the initial registrations run here.
            if let Err(e) = shortcuts::setup_global_shortcuts(app.handle()) {
                eprintln!("Failed to setup global shortcuts: {}", e);
            }
            Ok(())
        });

    // macOS-only plugins: NSPanel turns the overlay into a floating,
    // non-activating panel; the permissions plugin brokers mic/screen access.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .plugin(tauri_nspanel::init())
            .plugin(tauri_plugin_macos_permissions::init());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Convert the main window into an NSPanel that floats above full-screen apps
/// and joins all Spaces without activating the app (macOS only).
#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn init(app_handle: &AppHandle) {
    let window: WebviewWindow = app_handle.get_webview_window("main").unwrap();

    let panel = window.to_panel().unwrap();

    let delegate = panel_delegate!(MyPanelDelegate {
        window_did_become_key,
        window_did_resign_key
    });

    let handle = app_handle.to_owned();

    delegate.set_listener(Box::new(move |delegate_name: String| {
        match delegate_name.as_str() {
            "window_did_become_key" => {
                let app_name = handle.package_info().name.to_owned();

                println!("[info]: {:?} panel becomes key window!", app_name);
            }
            "window_did_resign_key" => {
                println!("[info]: panel resigned from key window!");
            }
            _ => (),
        }
    }));

    // Set the window to float level
    #[allow(non_upper_case_globals)]
    const NSFloatWindowLevel: i32 = 4;
    panel.set_level(NSFloatWindowLevel);

    #[allow(non_upper_case_globals)]
    const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
    panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);

    #[allow(deprecated)]
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces,
    );

    panel.set_delegate(delegate);
}
