//! BYOK (bring your own key) connection testing.
//!
//! The dashboard's simple provider form needs a Test button that answers in
//! plain language: is this OpenAI-compatible endpoint reachable, does the key
//! work, and — most importantly — DOES THE CONFIGURED MODEL RESPOND. The
//! request runs in Rust (the Tauri HTTP client) so CORS never touches it and
//! local servers (Ollama, LM Studio, freellmapi) just work.
//!
//! The test is model-aware: with a model configured, an AI provider gets a
//! real one-token chat probe against /chat/completions and an STT provider
//! gets a real transcription probe (a tiny silent WAV) against
//! /audio/transcriptions — so "Test connection" proves the actual model
//! works, not just that the URL resolves.

use serde::Serialize;

const TIMEOUT_SECS: u64 = 10;

#[derive(Serialize)]
pub struct ByokTestResult {
    pub ok: bool,
    /// Model ids from the endpoint's discovery (OpenAI `{ "data": [ {"id": ...} ] }`).
    pub models: Vec<String>,
    /// Plain-language outcome for the dashboard's test panel.
    pub message: String,
}

#[derive(serde::Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
    // Some compatible servers (older vLLM, text-generation-webui) return a
    // `models` array instead of OpenAI's `data`.
    #[serde(default)]
    models: Vec<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct ModelEntry {
    id: String,
}

/// Candidate discovery URLs, in try order: the base as pasted (already ending
/// in /v1 or a server that serves /models), then the OpenAI-conventional
/// /v1/models.
fn discovery_urls(base: &str) -> Vec<String> {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.ends_with("/v1") {
        vec![format!("{}/models", trimmed)]
    } else {
        vec![
            format!("{}/v1/models", trimmed),
            format!("{}/models", trimmed),
        ]
    }
}

fn extract_model_ids(body: &str) -> Option<Vec<String>> {
    if let Ok(parsed) = serde_json::from_str::<ModelsResponse>(body) {
        let mut ids: Vec<String> = parsed
            .data
            .into_iter()
            .map(|m| m.id)
            .chain(parsed.models.into_iter().filter_map(|m| {
                m.get("id").or_else(|| m.get("name")).and_then(|v| {
                    v.as_str().map(|s| s.to_string())
                })
            }))
            .collect();
        if !ids.is_empty() {
            ids.sort();
            ids.dedup();
            return Some(ids);
        }
    }
    // Bare-array shape.
    if let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(&body) {
        let mut ids: Vec<String> = entries
            .into_iter()
            .filter_map(|m| {
                m.get("id")
                    .or_else(|| m.get("name"))
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
            })
            .collect();
        if !ids.is_empty() {
            ids.sort();
            ids.dedup();
            return Some(ids);
        }
    }
    None
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .unwrap_or_default()
}

/// A 0.2 s silent 16 kHz mono WAV, for the STT model probe. The provider must
/// accept the audio and answer with a transcript payload — a real end-to-end
/// test of the configured model.
fn silence_wav() -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::new(&mut cursor, spec).expect("wav writer");
    for _ in 0..3200 {
        writer.write_sample(0i16).expect("wav sample");
    }
    writer.finalize().expect("wav finalize");
    cursor.into_inner()
}

/// Run the model-aware probe: an AI provider gets a one-token chat call, an
/// STT provider gets the silence-WAV transcription. Returns (ok, message).
async fn probe_model(
    client: &reqwest::Client,
    base: &str,
    api_key: &str,
    kind: &str,
    model: &str,
) -> (bool, String) {
    let trimmed = base.trim().trim_end_matches('/');
    let model_trimmed = model.trim();
    if kind == "stt" {
        let url = format!("{}/v1/audio/transcriptions", trimmed);
        let wav = silence_wav();
        let file_part = reqwest::multipart::Part::bytes(wav)
            .file_name("probe.wav")
            .mime_str("audio/wav")
            .expect("mime");
        let form = reqwest::multipart::Form::new()
            .part("file", file_part)
            .text("model", model_trimmed.to_string());
        let mut request = client.post(&url).multipart(form);
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key.trim());
        }
        return match request.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response.text().await.unwrap_or_default();
                if (200..300).contains(&status) {
                    (true, format!("Model '{}' responded to a test transcription.", model_trimmed))
                } else {
                    (false, format!(
                        "The model probe failed: HTTP {} against {}{}",
                        status,
                        url,
                        if body.trim().is_empty() { String::new() } else { format!(" — server said: {}", body.chars().take(160).collect::<String>()) }
                    ))
                }
            }
            Err(error) => (false, format!("The model probe could not reach {}: {}", url, error)),
        };
    }

    // AI probe: a one-token chat completion against the configured model.
    let url = format!("{}/chat/completions", trimmed);
    let payload = serde_json::json!({
        "model": model_trimmed,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "stream": false
    });
    let mut request = client.post(&url).json(&payload);
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                (true, format!("Model '{}' responded to a test chat call.", model_trimmed))
            } else {
                (false, format!(
                    "The model probe failed: HTTP {} against {}{}",
                    status,
                    url,
                    if body.trim().is_empty() { String::new() } else { format!(" — server said: {}", body.chars().take(160).collect::<String>()) }
                ))
            }
        }
        Err(error) => (false, format!("The model probe could not reach {}: {}", url, error)),
    }
}

/// Test one OpenAI-compatible base URL + key: discover the model list, and —
/// when a model is configured — run the real model probe (chat for AI,
/// transcription for STT). Never panics, never hangs past the timeout; every
/// failure is a structured `ok: false` with an explanation in user language.
#[tauri::command]
pub async fn byok_test_connection(
    base_url: String,
    api_key: String,
    kind: Option<String>,
    model: Option<String>,
) -> Result<ByokTestResult, String> {
    let urls = discovery_urls(&base_url);
    if urls.is_empty() {
        return Ok(ByokTestResult {
            ok: false,
            models: vec![],
            message: "Enter a base URL first (for example http://localhost:1234 or https://api.openai.com/v1).".to_string(),
        });
    }

    let client = client();
    let mut last_status: Option<u16> = None;
    let mut last_body = String::new();

    for url in &urls {
        let mut request = client.get(url);
        // Empty keys are legitimate for local servers with no auth.
        if !api_key.trim().is_empty() {
            request = request.bearer_auth(api_key.trim());
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                if error.is_timeout() {
                    return Ok(ByokTestResult {
                        ok: false,
                        models: vec![],
                        message: format!(
                            "Timed out after {} s reaching {}. Is the server running on that address and port?",
                            TIMEOUT_SECS, url
                        ),
                    });
                }
                if error.is_connect() {
                    return Ok(ByokTestResult {
                        ok: false,
                        models: vec![],
                        message: format!(
                            "Could not connect to {}. Nothing answered there — check the server is running and the port is right.",
                            url
                        ),
                    });
                }
                return Ok(ByokTestResult {
                    ok: false,
                    models: vec![],
                    message: format!("Could not reach {}: {}", url, error),
                });
            }
        };

        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();

        if status == 200 {
            if let Some(models) = extract_model_ids(&body) {
                let count = models.len();
                // With a model configured, prove THE MODEL responds — the
                // discovery list alone proves nothing about the model.
                let mut final_message =
                    format!("Connected. {} model(s) available via {}.", count, url);
                let mut ok = true;
                if let Some(model) = model.as_deref().filter(|m| !m.trim().is_empty()) {
                    let kind_deref = kind.as_deref().unwrap_or("ai");
                    let (probe_ok, probe_message) =
                        probe_model(&client, &base_url, &api_key, kind_deref, model).await;
                    if probe_ok {
                        final_message = format!(
                            "Connected. {} model(s) listed, and '{}' is responding.",
                            count, model
                        );
                    } else {
                        ok = false;
                        final_message = format!(
                            "{} models listed, but the model test failed. {}",
                            count, probe_message
                        );
                    }
                }
                return Ok(ByokTestResult {
                    ok,
                    models,
                    message: final_message,
                });
            }
            // 200 but not a model list: the URL answered, but it is not an
            // OpenAI-compatible API (a web page, a different protocol).
            last_status = Some(status);
            last_body = body.chars().take(160).collect();
            continue;
        }

        last_status = Some(status);
        last_body = body.chars().take(160).collect();
    }

    let detail = if last_body.trim().is_empty() {
        String::new()
    } else {
        format!(" Server said: {}", last_body)
    };
    let message = match last_status {
        Some(401) | Some(403) => {
            format!("The API key was rejected (HTTP {}{}).", last_status.unwrap(), detail)
        }
        Some(404) => format!(
            "No OpenAI-compatible model list at that URL (HTTP 404).{} Is it really an OpenAI-compatible API?",
            detail
        ),
        Some(status) if (500..600).contains(&status) => {
            format!("The server returned an error (HTTP {}{}).", status, detail)
        }
        Some(status) => format!("The server answered HTTP {}{}.", status, detail),
        None => "No model list found at that URL.".to_string(),
    };

    Ok(ByokTestResult {
        ok: false,
        models: vec![],
        message,
    })
}
