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
//! THE DEEPGRAM PROTOCOL (verified against the official reference,
//! developers.deepgram.com/reference/speech-to-text/listen-streaming):
//!   connect  wss://api.deepgram.com/v1/listen?model=<m>&encoding=linear16
//!            &sample_rate=16000&channels=1&interim_results=true
//!            &endpointing=300&utterance_end_ms=1000
//!   auth     `Authorization: Token <key>` on the upgrade request
//!   audio    raw binary s16le little-endian frames
//!   server   `{"type":"Results","channel":{"alternatives":[{"transcript":
//!            ...}]},"is_final":bool}` — interim (is_final=false) and final
//!            (is_final=true). NOTE: encoding is `linear16` on the streaming
//!            endpoint — `pcm_s16le` is the BATCH API's name and gets
//!            rejected/misread here (the bug that silently disabled the
//!            first streaming attempt).
//!
//! Capability detection: the profile is derived from the endpoint (Deepgram
//! hosts — and local mock servers for testing — use the Deepgram listen
//! protocol), and `byok_test_streaming` performs a REAL WebSocket handshake
//! at test time — the dashboard shows a green light only when the provider
//! actually accepted one.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::Emitter;
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

#[derive(Serialize, Clone, Debug)]
pub struct StreamEventPayload {
    pub text: String,
    pub is_final: bool,
}

/// The Deepgram listen protocol URL. `encoding=linear16` — the streaming
/// endpoint's name for raw s16le (the batch API's `pcm_s16le` is rejected
/// here). Local hosts use the same protocol shape so a mock server can test
/// the full path end to end.
fn streaming_ws_url(base_url: &str, model: &str) -> Option<String> {
    let base = base_url.trim().trim_end_matches('/');
    let base = base.strip_suffix("/v1").unwrap_or(base);
    let host = base
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let lowered = host.to_lowercase();
    let is_deepgram = lowered.contains("deepgram.com");
    let is_local = lowered.contains("127.0.0.1") || lowered.contains("localhost");
    if is_deepgram || is_local {
        Some(format!(
            "{}/v1/listen?model={}&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000",
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

/// Extract the transcript + is_final flag from one server message.
fn parse_results(text: &str) -> Option<StreamEventPayload> {
    let parsed = serde_json::from_str::<serde_json::Value>(text).ok()?;
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
        return None;
    }
    let is_final = parsed
        .get("is_final")
        .and_then(|f| f.as_bool())
        .unwrap_or(false);
    Some(StreamEventPayload { text: transcript, is_final })
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
        if let (Ok(header_name), Ok(header_value)) =
            (name.parse::<HeaderName>(), value.parse::<HeaderValue>())
        {
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

/// Spawn the streaming session. Events go BOTH to the optional AppHandle
/// (`stt-stream-*` window events for the frontend) and to the returned
/// channel (the test harness reads this directly; production drops it).
pub fn spawn_session_events(
    app: Option<tauri::AppHandle>,
    config: SttStreamConfig,
) -> Result<
    (
        SttStreamSession,
        tokio::sync::mpsc::UnboundedReceiver<StreamEventPayload>,
    ),
    String,
> {
    let Some(url) = streaming_ws_url(&config.base_url, &config.model) else {
        return Err("This provider has no known streaming endpoint; it runs in one-shot mode.".to_string());
    };
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("Invalid streaming URL: {}", e))?;
    for (name, value) in auth_headers(&config.base_url, &config.api_key) {
        if let (Ok(header_name), Ok(header_value)) =
            (name.parse::<HeaderName>(), value.parse::<HeaderValue>())
        {
            request.headers_mut().insert(header_name, header_value);
        }
    }

    let (audio_tx, mut audio_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<f32>>();
    let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel::<StreamEventPayload>();
    let task = tauri::async_runtime::spawn(async move {
        let report = |active: bool, reason: Option<String>| {
            if let Some(app) = &app {
                let _ = app.emit(
                    "stt-stream-status",
                    serde_json::json!({ "active": active, "reason": reason }),
                );
            }
        };
        let emit_event = |event: &StreamEventPayload| {
            if let Some(app) = &app {
                let name = if event.is_final {
                    "stt-stream-final"
                } else {
                    "stt-stream-partial"
                };
                let _ = app.emit(name, event.clone());
            }
        };

        let connect = tokio::time::timeout(
            std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS),
            tokio_tungstenite::connect_async(request),
        )
        .await;
        let ws_stream = match connect {
            Ok(Ok((ws_stream, _))) => {
                report(true, None);
                ws_stream
            }
            Ok(Err(error)) => {
                report(false, Some(format!("stream connect failed: {}", error)));
                return;
            }
            Err(_) => {
                report(false, Some("stream connect timed out".to_string()));
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
                                report(false, Some("stream closed while sending audio".to_string()));
                                return;
                            }
                        }
                        None => {
                            // Sender dropped: session ended. Close politely.
                            let _ = sink.close().await;
                            report(false, None);
                            return;
                        }
                    }
                }
                // Transcripts down.
                incoming = stream.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if let Some(event) = parse_results(&text) {
                                emit_event(&event);
                                let _ = event_tx.send(event);
                            }
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => {
                            report(false, Some(format!("stream error: {}", error)));
                            return;
                        }
                        None => {
                            report(false, None);
                            return;
                        }
                    }
                }
            }
        }
    });

    Ok((SttStreamSession { audio_tx, task }, event_rx))
}

/// Production wrapper: forwards the session's events to the window events.
pub fn spawn_session(
    app: tauri::AppHandle,
    config: SttStreamConfig,
) -> Result<SttStreamSession, String> {
    spawn_session_events(Some(app), config).map(|(session, _rx)| session)
}

#[cfg(test)]
mod streaming_integration_tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    /// A local WebSocket server speaking the Deepgram SERVER side of the
    /// protocol: it accepts, counts the binary audio frames it receives, and
    /// answers the Nth frame with an interim Results message and the (N+1)th
    /// with a final one. This exercises the REAL session path — connect,
    /// auth-free local handshake, audio streaming up, transcripts parsing
    /// down — with no external service.
    async fn spawn_mock_deepgram() -> (u16, tokio::sync::oneshot::Receiver<usize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (frames_tx, frames_rx) = tokio::sync::oneshot::channel::<usize>();
        tokio::spawn(async move {
            let (tcp, _addr) = listener.accept().await.expect("accept");
            let mut ws = tokio_tungstenite::accept_async(tcp)
                .await
                .expect("ws handshake");
            let mut audio_frames = 0usize;
            let mut interim_sent = false;
            let mut final_sent = false;
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    ws.next(),
                )
                .await
                {
                    Ok(Some(Ok(Message::Binary(bytes)))) => {
                        audio_frames += 1;
                        // Two s16le samples per binary frame (our hops carry
                        // >0 samples; count frames, not bytes).
                        if audio_frames >= 2 && !interim_sent {
                            interim_sent = true;
                            let msg = serde_json::json!({
                                "type": "Results",
                                "channel": {"alternatives": [{"transcript": "hello", "confidence": 0.9}]},
                                "is_final": false
                            });
                            let _ = ws
                                .send(Message::Text(msg.to_string()))
                                .await;
                        }
                        if audio_frames >= 4 && !final_sent {
                            final_sent = true;
                            let msg = serde_json::json!({
                                "type": "Results",
                                "channel": {"alternatives": [{"transcript": "hello world", "confidence": 0.95}]},
                                "is_final": true
                            });
                            let _ = ws
                                .send(Message::Text(msg.to_string()))
                                .await;
                            // Give the session a beat to pump both events,
                            // then end the server side.
                            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                            let _ = frames_tx.send(audio_frames);
                            return;
                        }
                    }
                    Ok(Some(Ok(_))) => continue,
                    _ => {
                        let _ = frames_tx.send(audio_frames);
                        return;
                    }
                }
            }
        });
        (port, frames_rx)
    }

    #[tokio::test]
    async fn streaming_session_streams_audio_and_emits_interim_then_final_events() {
        let (port, frames_rx) = spawn_mock_deepgram().await;

        // The session profile accepts local hosts for exactly this kind of
        // end-to-end test.
        let (session, mut events) = spawn_session_events(
            None,
            SttStreamConfig {
                base_url: format!("http://127.0.0.1:{}", port),
                api_key: "test-key".to_string(),
                model: "nova-3".to_string(),
            },
        )
        .expect("session spawns");

        // Feed audio hops: f32 in, the session converts to s16le and streams.
        let hop: Vec<f32> = vec![0.25; 16000]; // 1 s of audio
        for _ in 0..4 {
            session
                .audio_tx
                .send(hop.clone())
                .expect("audio hop accepted");
        }

        // The transcript events must arrive in order: interim then final.
        let interim = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            events.recv(),
        )
        .await
        .expect("interim event within 10s")
        .expect("event channel alive");
        assert!(!interim.is_final, "first event must be interim");
        assert_eq!(interim.text, "hello");

        let final_event = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            events.recv(),
        )
        .await
        .expect("final event within 10s")
        .expect("event channel alive");
        assert!(final_event.is_final, "second event must be final");
        assert_eq!(final_event.text, "hello world");

        // The mock actually received our audio frames (the s16le conversion
        // and the WebSocket send really happened).
        let frames = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            frames_rx,
        )
        .await
        .expect("mock finished")
        .expect("frames count");
        assert!(
            frames >= 4,
            "the mock server must receive the streamed audio frames (got {})",
            frames
        );

        // Dropping the sender ends the session politely.
        drop(session);
    }

    #[tokio::test]
    async fn streaming_ws_url_uses_linear16_and_profiles_local_hosts() {
        // THE regression: the first streaming attempt used the BATCH API's
        // `pcm_s16le`, which the streaming endpoint does not accept.
        let url = streaming_ws_url("https://api.deepgram.com", "nova-3")
            .expect("deepgram profile");
        assert!(url.starts_with("wss://api.deepgram.com/v1/listen?"), "{}", url);
        assert!(url.contains("encoding=linear16"), "{}", url);
        assert!(url.contains("sample_rate=16000"), "{}", url);
        assert!(url.contains("interim_results=true"), "{}", url);
        assert!(!url.contains("pcm_s16le"), "{}", url);

        // Local hosts speak the same protocol (mock-server testing).
        let local = streaming_ws_url("http://127.0.0.1:1234", "m")
            .expect("local profile");
        assert!(local.starts_with("ws://127.0.0.1:1234/v1/listen?"), "{}", local);

        // Unrecognized endpoint families have NO profile: one-shot mode.
        assert!(streaming_ws_url("https://example.com", "m").is_none());
    }
}
