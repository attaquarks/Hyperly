//! Streaming STT (Tier 2): the WebSocket path for streaming-capable providers.
//!
//! One-shot STT is an upload-then-wait round trip — the last big latency in
//! the stop-to-LLM path. Streaming providers (Deepgram nova-3 and friends)
//! accept audio over a WebSocket and return words WHILE the person is still
//! talking. This module runs that connection in Rust:
//!
//!   capture loop hop -> (f32 48 kHz) -> resample 16 kHz -> s16le bytes
//!     -> WebSocket -> provider -> interim/final transcripts
//!     -> `stt-stream-partial` / `stt-stream-final` text events
//!
//! The frontend consumes the TEXT events directly (no audio IPC, no
//! fetchSTT), so with a streaming provider the final text already exists
//! when the user presses Stop and the LLM is asked immediately.
//!
//! Capability detection: the profile is derived from the endpoint (Deepgram
//! hosts use the Deepgram listen protocol), and `byok_test_streaming`
//! performs a REAL WebSocket handshake at test time — the dashboard shows a
//! green light only when the provider actually accepted one.

use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;
use serde::Serialize;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

const CONNECT_TIMEOUT_SECS: u64 = 8;

#[derive(Clone, Debug, serde::Deserialize)]
pub struct SttStreamConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Serialize)]
pub struct StreamingSupport {
    pub supported: bool,
    pub message: String,
}

#[derive(Serialize)]
struct StreamEvent<'a> {
    text: &'a str,
    is_final: bool,
}

/// The Deepgram listen protocol: `wss://<host>/v1/listen` with raw s16le PCM
/// described by query parameters. Other provider protocols plug in here as
/// additional match arms.
fn streaming_ws_url(base_url: &str, model: &str) -> Option<String> {
    let base = base_url.trim().trim_end_matches('/');
    let base = base.strip_suffix("/v1").unwrap_or(base);
    let host = base
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    if host.contains("deepgram.com") {
        Some(format!(
            "{}/v1/listen?model={}&encoding=pcm_s16le&sample_rate=16000&channels=1&interim_results=true&utterance_end_ms=1000",
            host, model
        ))
    } else {
        // No streaming profile for this endpoint family.
        None
    }
}

fn auth_headers(base_url: &str, api_key: &str) -> Vec<(String, String)> {
    if base_url.to_lowercase().contains("deepgram.com") {
        // Deepgram's documented auth header for WebSockets.
        vec![(
            "Authorization".to_string(),
            format!("Token {}", api_key.trim()),
        )]
    } else {
        vec![(
            "Authorization".to_string(),
            format!("Bearer {}", api_key.trim()),
        )]
    }
}

/// Perform a REAL WebSocket handshake to detect streaming support. Called at
/// configuration-test time; the dashboard shows the green/red light from this.
pub async fn detect_streaming_support(config: &SttStreamConfig) -> StreamingSupport {
    let Some(url) = streaming_ws_url(&config.base_url, &config.model) else {
        return StreamingSupport {
            supported: false,
            message: "This provider does not publish a streaming endpoint Hyperly knows. It will be used in one-shot mode (upload per utterance).".to_string(),
        };
    };
    let mut request = match url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => {
            return StreamingSupport {
                supported: false,
                message: format!("Invalid streaming URL built from the base URL: {}", error),
            }
        }
    };
    for (name, value) in auth_headers(&config.base_url, &config.api_key) {
        // http::HeaderMap::insert needs typed HeaderName/HeaderValue, not
        // plain Strings.
        if let (Ok(header_name), Ok(header_value)) = (
            name.parse::<HeaderName>(),
            value.parse::<HeaderValue>(),
        ) {
            request.headers_mut().insert(header_name, header_value);
        }
    }
    let connect = tokio_tungstenite::connect_async(request).await;
    match connect {
        Ok((ws_stream, _response)) => {
            let (mut sink, _stream) = ws_stream.split();
            // Closing cleanly proves the handshake AND that auth passed.
            let _ = sink.close().await;
            StreamingSupport {
                supported: true,
                message: "Streaming supported — live words will arrive while someone is still talking.".to_string(),
            }
        }
        Err(error) => StreamingSupport {
            supported: false,
            message: format!("Streaming not available for this provider ({}). It will be used in one-shot mode.", error),
        },
    }
}

/// The live session: the capture loop pushes f32 hops through `audio_tx`; the
/// task below converts, streams, and translates server messages into events.
pub struct SttStreamSession {
    pub audio_tx: tokio::sync::mpsc::UnboundedSender<Vec<f32>>,
    pub task: tauri::async_runtime::JoinHandle<()>,
}

/// Spawn the streaming session: connect, then pump audio up and transcripts
/// down until the audio channel closes (the sender is dropped on stop).
pub fn spawn_session(
    app: tauri::AppHandle,
    config: SttStreamConfig,
) -> Result<SttStreamSession, String> {
    let Some(url) = streaming_ws_url(&config.base_url, &config.model) else {
        return Err("This provider has no known streaming endpoint; it runs in one-shot mode.".to_string());
    };
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("Invalid streaming URL: {}", e))?;
    for (name, value) in auth_headers(&config.base_url, &config.api_key) {
        // http::HeaderMap::insert needs typed HeaderName/HeaderValue, not
        // plain Strings.
        if let (Ok(header_name), Ok(header_value)) = (
            name.parse::<HeaderName>(),
            value.parse::<HeaderValue>(),
        ) {
            request.headers_mut().insert(header_name, header_value);
        }
    }

    let (audio_tx, mut audio_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<f32>>();
    let task = tauri::async_runtime::spawn(async move {
        let connect = tokio::time::timeout(
            std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS),
            tokio_tungstenite::connect_async(request),
        )
        .await;
        let ws_stream = match connect {
            Ok(Ok((ws_stream, _))) => {
                let _ = app.emit("stt-stream-status", serde_json::json!({ "active": true }));
                ws_stream
            }
            Ok(Err(error)) => {
                let _ = app.emit(
                    "stt-stream-status",
                    serde_json::json!({ "active": false, "reason": format!("stream connect failed: {}", error) }),
                );
                return;
            }
            Err(_) => {
                let _ = app.emit(
                    "stt-stream-status",
                    serde_json::json!({ "active": false, "reason": "stream connect timed out" }),
                );
                return;
            }
        };
        let (mut sink, mut stream) = ws_stream.split();

        loop {
            tokio::select! {
                // Audio up: f32 hops -> s16le bytes.
                audio = audio_rx.recv() => {
                    match audio {
                        Some(hop) => {
                            let mut bytes = Vec::with_capacity(hop.len() * 2);
                            for sample in hop {
                                let clamped = sample.clamp(-1.0, 1.0);
                                bytes.extend_from_slice(
                                    &((clamped * 32767.0) as i16).to_le_bytes(),
                                );
                            }
                            if sink.send(Message::Binary(bytes)).await.is_err() {
                                let _ = app.emit(
                                    "stt-stream-status",
                                    serde_json::json!({ "active": false, "reason": "stream closed while sending audio" }),
                                );
                                return;
                            }
                        }
                        None => {
                            // Sender dropped: session ended. Close politely.
                            let _ = sink.close().await;
                            let _ = app.emit("stt-stream-status", serde_json::json!({ "active": false }));
                            return;
                        }
                    }
                }
                // Transcripts down.
                incoming = stream.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                                let transcript = parsed
                                    .get("channel")
                                    .and_then(|c| c.get("alternatives"))
                                    .and_then(|a| a.get(0))
                                    .and_then(|alt| alt.get("transcript"))
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("")
                                    .trim()
                                    .to_string();
                                if transcript.is_empty() {
                                    continue;
                                }
                                let is_final = parsed.get("is_final").and_then(|f| f.as_bool()).unwrap_or(false);
                                let _ = app.emit(
                                    if is_final { "stt-stream-final" } else { "stt-stream-partial" },
                                    serde_json::to_value(StreamEvent { text: &transcript, is_final }).unwrap_or_default(),
                                );
                            }
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => {
                            let _ = app.emit(
                                "stt-stream-status",
                                serde_json::json!({ "active": false, "reason": format!("stream error: {}", error) }),
                            );
                            return;
                        }
                        None => {
                            let _ = app.emit("stt-stream-status", serde_json::json!({ "active": false }));
                            return;
                        }
                    }
                }
            }
        }
    });

    Ok(SttStreamSession { audio_tx, task })
}
