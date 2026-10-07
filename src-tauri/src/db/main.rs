use std::fs;
use std::path::{Path, PathBuf};
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
        // Migration 3: durable transcript events + dead-letter audio (Phase 4 R3).
        // Non-destructive: it creates two new tables and their indexes and never
        // touches conversations, messages or system_prompts. The paired Down
        // entry drops exactly those two objects, so sqlx has a real reversal.
        Migration {
            version: 3,
            description: "create_transcript_events",
            sql: include_str!("migrations/transcript-events.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "drop_transcript_events",
            sql: include_str!("migrations/transcript-events.down.sql"),
            kind: MigrationKind::Down,
        },
        // Migration 4: make conversations.updated_at monotonic (Phase 4 R9).
        // Migration 2's trigger sets updated_at = NEW.timestamp per inserted
        // message, and Listen inserts newest-first, so the key ended up holding
        // the OLDEST message's time. This re-creates the same two triggers with
        // `max(updated_at, NEW.timestamp)`. It touches no table and no row - only
        // the triggers - so existing conversations, messages and their ids are
        // untouched, and the Down entry restores the migration-2 bodies.
        Migration {
            version: 4,
            description: "monotonic_conversation_timestamp",
            sql: include_str!("migrations/conversation-timestamp.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "restore_conversation_timestamp",
            sql: include_str!("migrations/conversation-timestamp.down.sql"),
            kind: MigrationKind::Down,
        },
    ]
}

/// One-time data migration: copy the legacy Pluely database into Hyperly's
/// app-data directory so existing users keep their conversations and system
/// prompts across the rebrand.
///
/// Runs at the very top of `run()`, before the SQL plugin preload opens (and,
/// on Windows, locks) `hyperly.db`. Never overwrites an existing Hyperly DB.
///
/// PHASE B (one-shot gate): this import is deliberately KEPT — deleting it
/// outright would destroy a Pluely-upgrading user's history — but it is now
/// gated behind a `.legacy-migration-done` sentinel file beside the target
/// DB, so the whole path runs AT MOST ONCE EVER. Once the marker exists, the
/// import is skipped forever, whatever happens to either database afterwards.
/// That lets it ship safely now (users still migrate) and lets a later
/// release delete this code outright without it ever re-running. Only a
/// transient failure (dir creation, primary copy) leaves the marker unwritten,
/// so a failed migration retries on the next launch.
pub fn migrate_legacy_database() {
    let Some(base) = app_data_base() else {
        return;
    };

    let legacy_dir = base.join("com.srikanthnani.pluely");
    let legacy_db = legacy_dir.join("pluely.db");
    let target_dir = base.join("com.attaquarks.hyperly");
    let target_db = target_dir.join("hyperly.db");

    // One-shot gate: after the first launch that reaches a decision, the
    // marker exists and everything below is skipped permanently.
    let marker = target_dir.join(".legacy-migration-done");
    if marker.exists() {
        return;
    }

    if target_db.exists() {
        // An existing Hyperly DB — never overwrite it. Record the decision so
        // this is decided once, not on every launch.
        write_marker(&target_dir, &marker);
        return;
    }
    if !legacy_db.exists() {
        // No legacy install. Record it so this too is a one-shot check.
        write_marker(&target_dir, &marker);
        return;
    }

    if let Err(e) = fs::create_dir_all(&target_dir) {
        eprintln!("DB migration: failed to create app data dir: {}", e);
        return; // transient — no marker, retry next launch
    }

    // Copy the database plus any WAL/SHM sidecars so a legacy database that
    // was in WAL mode migrates consistently.
    let mut migrated_primary = false;
    for suffix in ["pluely.db", "pluely.db-wal", "pluely.db-shm"] {
        let src = legacy_dir.join(suffix);
        if !src.exists() {
            continue;
        }
        let dst = target_dir.join(suffix.replacen("pluely.db", "hyperly.db", 1));
        match fs::copy(&src, &dst) {
            Ok(_) => {
                if suffix == "pluely.db" {
                    migrated_primary = true;
                }
            }
            Err(e) => eprintln!("DB migration: failed to copy {:?} -> {:?}: {}", src, dst, e),
        }
    }

    if migrated_primary {
        eprintln!("DB migration: migrated legacy pluely.db to hyperly.db");
        write_marker(&target_dir, &marker);
    } else {
        eprintln!(
            "DB migration: legacy db present but the primary copy failed; will retry next launch"
        );
    }
}

/// Write the one-shot marker beside the target DB. Best-effort: a failure
/// here only means the decision may be re-evaluated next launch, which is
/// always safe because an existing `hyperly.db` is never overwritten.
fn write_marker(target_dir: &Path, marker: &Path) {
    if let Err(e) = fs::create_dir_all(target_dir) {
        eprintln!("DB migration: cannot create dir for one-shot marker: {}", e);
        return;
    }
    if let Err(e) = fs::write(marker, b"done") {
        eprintln!("DB migration: failed to write one-shot marker: {}", e);
    }
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
