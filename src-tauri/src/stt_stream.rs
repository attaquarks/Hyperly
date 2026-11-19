//! Re-export of the streaming-STT engine (the `streaming-stt` workspace
//! member, deliberately Tauri-free so its integration tests run on Windows
//! runners without the WebView2 DLL loading trap). The app-side glue —
//! window-event forwarding and session teardown — lives in lib.rs, which
//! wraps `spawn_session` for the tauri event bus.

// NOTE: StreamEventPayload is deliberately NOT re-exported — the app's
// forwarder handles those values by inference from the engine's receiver, and
// an unreferenced re-export is a cargo warning on every build.
pub use streaming_stt::{
    detect_streaming_support, spawn_session, SttStreamConfig, SttStreamSession,
    StreamingSupport,
};
