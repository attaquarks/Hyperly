-- Migration 3: durable transcript events + dead-letter audio (Phase 4 R3, issue #16)
--
-- NON-DESTRUCTIVE BY CONSTRUCTION: this migration only CREATEs new objects with
-- IF NOT EXISTS. It never ALTERs, DROPs, or rewrites `conversations`,
-- `messages` or `system_prompts`, so existing user history is untouched; the
-- matching down file (transcript-events.down.sql) drops only what this file
-- creates.
--
-- Ids are INTEGER PRIMARY KEY AUTOINCREMENT, the same scheme as
-- `system_prompts` - monotonic, cannot collide, native to SQLite, no id crate
-- needed. Event ids are local to this table: the projection joins on
-- `conversation_id`, and must never assume they relate to `messages.id`.
--
-- `source` (where the audio came from) is deliberately separate from
-- `speaker_label` (who it sounded like, NULL until identity is genuinely
-- known) - that separation is R8's whole point. `kind` covers speech blocks and
-- AI answers because the conversation list is a projection of this log.
CREATE TABLE IF NOT EXISTS transcript_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- NULL until the session is saved as a conversation ("orphan"); orphans are
    -- the only rows retention ever prunes.
    conversation_id TEXT,
    source TEXT NOT NULL CHECK(source IN ('system', 'microphone')),
    kind TEXT NOT NULL CHECK(kind IN ('partial', 'final', 'ai_response')),
    text TEXT NOT NULL,
    -- Session-relative offsets of the audio the text came from; NULL for
    -- ai_response, which has no audio of its own.
    start_ms INTEGER,
    end_ms INTEGER,
    -- NULL until identity is known; never inferred from `source`.
    speaker_label TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

-- The projection reads a conversation's events in insertion order.
CREATE INDEX IF NOT EXISTS idx_transcript_events_conversation
    ON transcript_events(conversation_id, id ASC);
-- Retention and "reveal the last unsaved session on relaunch" both scan by
-- creation time, newest first.
CREATE INDEX IF NOT EXISTS idx_transcript_events_created_at
    ON transcript_events(created_at DESC);
-- Orphan pruning filters on the NULL conversation_id.
CREATE INDEX IF NOT EXISTS idx_transcript_events_orphans
    ON transcript_events(conversation_id, created_at DESC);

-- Audio that exhausted its transcription attempts (Phase 4 R2's dead letters).
-- R2 could only hold this in memory; this table is where it lands durably, so a
-- provider outage no longer loses speech - it becomes recoverable.
-- Bounded: `prune_orphan_audio`-style retention uses the same 90-day orphan
-- rule, and the writer keeps only the newest rows (see transcript-store.ts).
CREATE TABLE IF NOT EXISTS transcript_dead_letter_audio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    source TEXT NOT NULL CHECK(source IN ('system', 'microphone')),
    -- The captured audio exactly as it arrived (WAV bytes), base64-encoded.
    -- TEXT rather than BLOB on purpose: tauri-plugin-sql binds parameters as
    -- JSON, where a BLOB has no unambiguous encoding, while base64 is exact and
    -- round-trips byte-for-byte (asserted in scripts/transcript-store-check.ts).
    audio_base64 TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_created_at
    ON transcript_dead_letter_audio(created_at DESC);
