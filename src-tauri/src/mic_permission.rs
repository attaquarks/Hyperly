//! Grants the webview microphone permission on Windows.
//!
//! Tauri v2 brokers microphone access only on macOS, through
//! `tauri-plugin-macos-permissions`. On Windows the request goes straight to
//! WebView2, and the only `PermissionRequested` handler WRY installs — see
//! `wry/src/webview2/mod.rs` — is registered when clipboard access is enabled
//! and allows exactly one kind:
//!
//! ```ignore
//! let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
//! args.PermissionKind(&mut kind)?;
//! if kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ {
//!     args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
//! }
//! ```
//!
//! Every other kind, microphone included, falls out of that `if` without its
//! state ever being set, so WebView2 refuses it. `navigator.mediaDevices
//! .getUserMedia({ audio })` therefore never yields a stream in *either* room.
//!
//! That matches the reported symptom exactly: the mic button turns on, no user
//! audio is captured, and no `user` transcript appears — in Ask and Listen
//! alike — while system-audio capture keeps working, because that is a Rust
//! WASAPI loopback that never touches the webview.
//!
//! This module installs the handler the webview is missing. It has to be
//! registered per window, and before the page asks for the mic; registering
//! during window setup satisfies both.

/// Installs a `PermissionRequested` handler that approves the microphone.
///
/// Safe to call from `.setup()`: `with_webview` executes inline when invoked on
/// the main thread (`tauri_runtime_wry::send_user_message`), so this does not
/// wait on an event loop that has not started yet.
#[cfg(target_os = "windows")]
pub fn allow_microphone<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionRequestedEventArgs, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    // `PermissionRequestedEventHandler` is generated in the private `callback`
    // module and re-exported at the crate root, not under `Win32`.
    use webview2_com::PermissionRequestedEventHandler;

    let label = window.label().to_string();
    // The closure below takes ownership; the outer `label` is still needed for
    // the error path after `with_webview` returns.
    let closure_label = label.clone();

    let result = window.with_webview(move |webview| {
        let controller = webview.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(e) => {
                eprintln!("[mic] {closure_label}: no CoreWebView2, mic will stay blocked: {e}");
                return;
            }
        };

        let handler = PermissionRequestedEventHandler::create(Box::new(
            |_, args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                let Some(args) = args else { return Ok(()) };

                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                unsafe { args.PermissionKind(&mut kind)? };

                // Microphone is what the voice input needs. Clipboard-read is
                // approved here too so this handler does not regress the paste
                // path that WRY's own handler covers.
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    || kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ
                {
                    unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
                }

                Ok(())
            },
        ));

        let mut token = 0i64;
        match unsafe { core.add_PermissionRequested(&handler, &mut token) } {
            Ok(()) => eprintln!("[mic] {closure_label}: microphone permission handler registered"),
            Err(e) => eprintln!("[mic] {closure_label}: could not register handler: {e}"),
        }
    });

    if let Err(e) = result {
        eprintln!("[mic] {label}: with_webview failed: {e}");
    }
}

/// No-op on platforms that broker microphone access themselves (macOS via
/// `tauri-plugin-macos-permissions`), or that have no WebView2 (Linux).
#[cfg(not(target_os = "windows"))]
pub fn allow_microphone<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}
