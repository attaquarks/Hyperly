//! Re-export of the streaming-STT engine (the `streaming-stt` workspace
//! member, deliberately Tauri-free so its integration tests run on Windows
//! runners without the WebView2 DLL loading trap). The app-side glue —
//! window-event forwarding and session teardown — lives in lib.rs, which
//! wraps `spawn_session` for the tauri event bus.

pub use streaming_stt::{
    detect_streaming_support, spawn_session, SttStreamConfig, SttStreamSession,
    StreamEventPayload, StreamingSupport,
};
