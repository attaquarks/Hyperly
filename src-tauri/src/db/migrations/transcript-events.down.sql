-- Migration 3 (down): revert ONLY what transcript-events.sql created.
--
-- Registered as `MigrationKind::Down` for version 3, so `sqlx` has a real
-- reversal: it drops the two new tables (and their indexes, implicitly) and
-- touches nothing else. Existing conversations and messages survive a downgrade
-- byte for byte - see `scripts/transcript-store-check.ts`, which proves the
-- same property for the up path against a copy of a real database.
DROP TABLE IF EXISTS transcript_dead_letter_audio;
DROP TABLE IF EXISTS transcript_events;
