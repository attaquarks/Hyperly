use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[allow(dead_code)]
fn get_payment_endpoint() -> Result<String, String> {
    // License removed: payment endpoint is no longer required.
    Ok(String::new())
}

#[allow(dead_code)]
fn get_api_access_key() -> Result<String, String> {
    // License removed: API access key is no longer required.
    Ok(String::new())
}

// Secure storage functions using Tauri's app data directory
fn get_secure_storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;

    // Create the directory if it doesn't exist
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

#[derive(Debug, Serialize, Deserialize)]
pub struct StorageItem {
    key: String,
    value: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StorageResult {
    license_key: Option<String>,
    instance_id: Option<String>,
    selected_hyperly_model: Option<String>,
}

#[tauri::command]
pub async fn secure_storage_save(app: AppHandle, items: Vec<StorageItem>) -> Result<(), String> {
    let storage_path = get_secure_storage_path(&app)?;

    let mut storage = if storage_path.exists() {
        let content = fs::read_to_string(&storage_path)
            .map_err(|e| format!("Failed to read storage file: {}", e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        SecureStorage::default()
    };

    for item in items {
        match item.key.as_str() {
            "hyperly_license_key" => storage.license_key = Some(item.value),
            "hyperly_instance_id" => storage.instance_id = Some(item.value),
            "selected_hyperly_model" => storage.selected_hyperly_model = Some(item.value),
            _ => return Err(format!("Invalid storage key: {}", item.key)),
        }
    }

    let content = serde_json::to_string(&storage)
        .map_err(|e| format!("Failed to serialize storage: {}", e))?;

    fs::write(&storage_path, content)
        .map_err(|e| format!("Failed to write storage file: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn secure_storage_get(app: AppHandle) -> Result<StorageResult, String> {
    let storage_path = get_secure_storage_path(&app)?;

    if !storage_path.exists() {
        return Ok(StorageResult {
            license_key: None,
            instance_id: None,
            selected_hyperly_model: None,
        });
    }

    let content = fs::read_to_string(&storage_path)
        .map_err(|e| format!("Failed to read storage file: {}", e))?;

    let storage: SecureStorage = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse storage file: {}", e))?;

    Ok(StorageResult {
        license_key: storage.license_key,
        instance_id: storage.instance_id,
        selected_hyperly_model: storage.selected_hyperly_model,
    })
}

#[tauri::command]
pub async fn secure_storage_remove(app: AppHandle, keys: Vec<String>) -> Result<(), String> {
    let storage_path = get_secure_storage_path(&app)?;

    if !storage_path.exists() {
        return Ok(()); // Nothing to remove
    }

    let content = fs::read_to_string(&storage_path)
        .map_err(|e| format!("Failed to read storage file: {}", e))?;

    let mut storage: SecureStorage = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse storage file: {}", e))?;

    for key in keys {
        match key.as_str() {
            "hyperly_license_key" => storage.license_key = None,
            "hyperly_instance_id" => storage.instance_id = None,
            "selected_hyperly_model" => storage.selected_hyperly_model = None,
            _ => return Err(format!("Invalid storage key: {}", key)),
        }
    }

    let content = serde_json::to_string(&storage)
        .map_err(|e| format!("Failed to serialize storage: {}", e))?;

    fs::write(&storage_path, content)
        .map_err(|e| format!("Failed to write storage file: {}", e))?;

    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ActivationRequest {
    license_key: String,
    instance_name: String,
    machine_id: String,
    app_version: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ActivationResponse {
    activated: bool,
    error: Option<String>,
    license_key: Option<String>,
    instance: Option<InstanceInfo>,
    is_dev_license: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ValidateResponse {
    is_active: bool,
    last_validated_at: Option<String>,
    is_dev_license: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct InstanceInfo {
    id: String,
    name: String,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct CheckoutResponse {
    success: Option<bool>,
    checkout_url: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn activate_license_api(
    _app: AppHandle,
    _license_key: String,
) -> Result<ActivationResponse, String> {
    // License removed for the personal/Windows-only build.
    // All Pro-tier features are always unlocked, so activation is a no-op
    // that simply returns a synthetic "active" response for any callers
    // that still depend on the IPC shape.
    Ok(ActivationResponse {
        activated: true,
        error: None,
        license_key: None,
        instance: Some(InstanceInfo {
            id: "personal-build".to_string(),
            name: "Personal Windows Build".to_string(),
            created_at: "1970-01-01T00:00:00Z".to_string(),
        }),
        is_dev_license: true,
    })
}

#[tauri::command]
pub async fn deactivate_license_api(_app: AppHandle) -> Result<ActivationResponse, String> {
    // License removed: deactivation is a no-op.
    Ok(ActivationResponse {
        activated: true,
        error: None,
        license_key: None,
        instance: Some(InstanceInfo {
            id: "personal-build".to_string(),
            name: "Personal Windows Build".to_string(),
            created_at: "1970-01-01T00:00:00Z".to_string(),
        }),
        is_dev_license: true,
    })
}

#[tauri::command]
pub async fn validate_license_api(_app: AppHandle) -> Result<ValidateResponse, String> {
    // License removed: validation always reports an active "dev" license.
    Ok(ValidateResponse {
        is_active: true,
        last_validated_at: None,
        is_dev_license: true,
    })
}

#[tauri::command]
pub fn mask_license_key_cmd(license_key: String) -> String {
    if license_key.len() <= 8 {
        return "*".repeat(license_key.len());
    }

    let first_four = &license_key[..4];
    let last_four = &license_key[license_key.len() - 4..];
    let middle_stars = "*".repeat(license_key.len() - 8);

    format!("{}{}{}", first_four, middle_stars, last_four)
}

#[tauri::command]
pub async fn get_checkout_url() -> Result<CheckoutResponse, String> {
    // License removed: there is no checkout flow anymore.
    Ok(CheckoutResponse {
        success: Some(false),
        checkout_url: None,
        error: Some(
            "License purchase is not available in the personal/Windows-only build."
                .to_string(),
        ),
    })
}
