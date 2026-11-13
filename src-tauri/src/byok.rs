//! BYOK (bring your own key) connection testing.
//!
//! The dashboard's simple provider form needs a Test button that answers in
//! plain language: is this OpenAI-compatible endpoint reachable, does the key
//! work, and which models does it serve? The request MUST run in Rust (the
//! Tauri HTTP client), not the webview: local servers (Ollama, LM Studio,
//! freellmapi) rarely send CORS headers, and the whole point of the panel is
//! that the user never debugs a connectivity failure themselves.
//!
//! Endpoint normalization: users paste base URLs in every shape —
//! `http://localhost:1234`, `http://localhost:1234/v1`, with or without a
//! trailing slash. OpenAI-compatible model discovery lives at `/v1/models`,
//! so both `GET {base}/models` and `GET {base}/v1/models` are tried and the
//! first one that answers wins.

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
    // bare array or a `models` array — handled by the fallback parse below.
    #[serde(default)]
    models: Vec<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct ModelEntry {
    id: String,
}

/// Candidate discovery URLs, in try order: the base as pasted (already ending
/// in `/v1` or pointing at a server that serves `/models`), then the
/// OpenAI-conventional `/v1/models`.
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
    // OpenAI shape first.
    if let Ok(parsed) = serde_json::from_str::<ModelsResponse>(body) {
        let mut ids: Vec<String> = parsed
            .data
            .into_iter()
            .map(|m| m.id)
            .chain(parsed.models.into_iter().filter_map(|m| {
                m.get("id")
                    .or_else(|| m.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            }))
            .collect();
        if !ids.is_empty() {
            ids.sort();
            ids.dedup();
            return Some(ids);
        }
    }
    // Bare-array shape: `[ {"id": ...}, ... ]`.
    if let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(body) {
        let mut ids: Vec<String> = entries
            .into_iter()
            .filter_map(|m| {
                m.get("id")
                    .or_else(|| m.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
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

/// Test one OpenAI-compatible base URL + key: discover the model list and
/// report the outcome in user language. Never panics, never hangs past the
/// timeout; every failure is a structured `ok: false` with an explanation.
#[tauri::command]
pub async fn byok_test_connection(
    base_url: String,
    api_key: String,
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
                return Ok(ByokTestResult {
                    ok: true,
                    models,
                    message: format!(
                        "Connected. {} model(s) available via {}.",
                        models.len(),
                        url
                    ),
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
