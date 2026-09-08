//! One-time cleanup for legacy Hyperly autostart registrations.

#[cfg(target_os = "windows")]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

/// Removes the autorun value created by older Hyperly builds.
///
/// This is intentionally idempotent: deleting a missing value is treated as
/// success so every upgrade remains safe after autostart support is removed.
pub fn remove_legacy_autostart() {
    #[cfg(target_os = "windows")]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        match hkcu.open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            winreg::enums::KEY_WRITE,
        ) {
            Ok(run_key) => {
                if let Err(error) = run_key.delete_value("Hyperly") {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        eprintln!("Failed to remove legacy Hyperly autostart entry: {error}");
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("Failed to open Windows startup registry key: {error}"),
        }
    }
}
