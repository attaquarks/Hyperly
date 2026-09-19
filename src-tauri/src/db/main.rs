use std::fs;
use std::path::PathBuf;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Returns all database migrations
pub fn migrations() -> Vec<Migration> {
    vec![
        // Migration 1: Create system_prompts table with indexes and triggers
        Migration {
            version: 1,
            description: "create_system_prompts_table",
            sql: include_str!("migrations/system-prompts.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 2: Create chat history tables (conversations and messages)
        Migration {
            version: 2,
            description: "create_chat_history_tables",
            sql: include_str!("migrations/chat-history.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

/// One-time data migration: copy the legacy Pluely database into Hyperly's
/// app-data directory so existing users keep their conversations and system
/// prompts across the rebrand.
///
/// Runs at the very top of `run()`, before the SQL plugin preload opens (and,
/// on Windows, locks) `hyperly.db`. Never overwrites an existing Hyperly DB.
pub fn migrate_legacy_database() {
    let Some(base) = app_data_base() else {
        return;
    };

    let legacy_dir = base.join("com.srikanthnani.pluely");
    let legacy_db = legacy_dir.join("pluely.db");
    if !legacy_db.exists() {
        return; // No legacy install — nothing to migrate
    }

    let target_dir = base.join("com.attaquarks.hyperly");
    let target_db = target_dir.join("hyperly.db");
    if target_db.exists() {
        return; // Never overwrite an existing Hyperly database
    }

    if let Err(e) = fs::create_dir_all(&target_dir) {
        eprintln!("DB migration: failed to create app data dir: {}", e);
        return;
    }

    // Copy the database plus any WAL/SHM sidecars so a legacy database that
    // was in WAL mode migrates consistently.
    for suffix in ["pluely.db", "pluely.db-wal", "pluely.db-shm"] {
        let src = legacy_dir.join(suffix);
        if !src.exists() {
            continue;
        }
        let dst = target_dir.join(suffix.replacen("pluely.db", "hyperly.db", 1));
        if let Err(e) = fs::copy(&src, &dst) {
            eprintln!("DB migration: failed to copy {:?} -> {:?}: {}", src, dst, e);
        }
    }

    eprintln!("DB migration: migrated legacy pluely.db to hyperly.db");
}

/// Resolve the platform app-data base directory without an `AppHandle`
/// (this runs before the Tauri builder exists). Mirrors the bases Tauri's
/// `path().app_data_dir()` uses per platform.
fn app_data_base() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    }
}
