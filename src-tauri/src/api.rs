use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[allow(dead_code)]
fn get_app_endpoint() -> Result<String, String> {
    // Hyperly Pro API has been removed; the app endpoint is no longer required.
    Ok(String::new())
}

#[allow(dead_code)]
fn get_api_access_key() -> Result<String, String> {
    // Hyperly Pro API has been removed; the access key is no longer required.
    Ok(String::new())
}

// Secure storage functions
fn get_secure_storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;

    Ok(app_data_dir.join("secure_storage.json"))
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct SecureStorage {
    license_key: Option<String>,
    instance_id: Option<String>,
    selected_hyperly_model: Option<String>,
}

pub async fn get_stored_credentials(
    app: &AppHandle,
) -> Result<(String, String, Option<Model>), String> {
    let storage_path = get_secure_storage_path(app)?;

    if !storage_path.exists() {
        return Err("No license found. Please activate your license first.".to_string());
    }

    let content = fs::read_to_string(&storage_path)
        .map_err(|e| format!("Failed to read storage file: {}", e))?;

    let storage: SecureStorage = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse storage file: {}", e))?;

    let license_key = storage
        .license_key
        .ok_or("License key not found".to_string())?;
    let instance_id = storage
        .instance_id
        .ok_or("Instance ID not found".to_string())?;

    let selected_model: Option<Model> = storage
        .selected_hyperly_model
        .and_then(|json_str| serde_json::from_str(&json_str).ok());

    Ok((license_key, instance_id, selected_model))
}

// Audio API Structs (kept for backward compatibility with the JS IPC shape)
#[derive(Debug, Serialize, Deserialize)]
pub struct AudioResponse {
    success: bool,
    transcription: Option<String>,
    error: Option<String>,
}

// Hyperly Pro Model Struct (used by get_stored_credentials)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Model {
    pub provider: String,
    pub name: String,
    pub id: String,
    pub model: String,
    pub description: String,
    pub modality: String,
    #[serde(rename = "isAvailable")]
    pub is_available: bool,
}

// Stub ApiResponseConfig (Hyperly Pro API removed; only the struct shape remains)
#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ApiResponseConfig {
    pub url: String,
    pub body: String,
    pub model: String,
}

// Audio API Command
#[tauri::command]
pub async fn transcribe_audio(
    _app: AppHandle,
    _audio_base64: String,
) -> Result<AudioResponse, String> {
    // Hyperly Pro API removed: return a synthetic "unavailable" response.
    Ok(AudioResponse {
        success: false,
        transcription: None,
        error: Some("Hyperly Pro API has been removed in the personal/Windows-only build.".to_string()),
    })
}

// Helper function to fetch API response configuration
#[allow(dead_code)]
async fn fetch_api_response_config(
    _app: &AppHandle,
    _provider: Option<String>,
    _model: Option<String>,
) -> Result<ApiResponseConfig, String> {
    // Hyperly Pro API has been removed; return an empty config so callers
    // can detect the missing backend without panicking.
    Ok(ApiResponseConfig {
        url: String::new(),
        body: String::new(),
        model: String::new(),
    })
}

#[tauri::command]
pub async fn chat_stream_response(
    _app: AppHandle,
    _user_message: String,
    _system_prompt: Option<String>,
    _image_base64: Option<serde_json::Value>,
    _history: Option<String>,
) -> Result<String, String> {
    Err("Hyperly Pro API has been removed in the personal/Windows-only build.".to_string())
}

// Models API Command
#[tauri::command]
pub async fn fetch_models(_app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}

// Fetch Hyperly Prompts API
#[tauri::command]
pub async fn fetch_prompts(_app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({"prompts": [], "total": 0}))
}

// Create System Prompt API Command
#[tauri::command]
pub async fn create_system_prompt(
    _app: AppHandle,
    _request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Err("Hyperly Pro API has been removed in the personal/Windows-only build.".to_string())
}

// Helper command to check if license is available
#[tauri::command]
pub async fn check_license_status(app: AppHandle) -> Result<bool, String> {
    match get_stored_credentials(&app).await {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn get_activity(_app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({"success": true, "data": [], "total_tokens_used": 0}))
}
