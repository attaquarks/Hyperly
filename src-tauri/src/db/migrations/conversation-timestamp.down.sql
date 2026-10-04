-- Migration 4 (down): restore the migration-2 trigger bodies exactly.
--
-- Registered as `MigrationKind::Down` for version 4, so `sqlx` has a real
-- reversal. It touches no table, index or row - only the two triggers it
-- re-created - so a downgrade leaves every conversation and message in place.
-- `scripts/persistence-integrity-check.ts` proves the reversal on a database and
-- on a copy of the real user database.

DROP TRIGGER IF EXISTS update_conversation_timestamp_on_message_insert;
DROP TRIGGER IF EXISTS update_conversation_timestamp_on_message_update;

CREATE TRIGGER IF NOT EXISTS update_conversation_timestamp_on_message_insert
AFTER INSERT ON messages
FOR EACH ROW
BEGIN
    UPDATE conversations
    SET updated_at = NEW.timestamp
    WHERE id = NEW.conversation_id;
END;

CREATE TRIGGER IF NOT EXISTS update_conversation_timestamp_on_message_update
AFTER UPDATE ON messages
FOR EACH ROW
BEGIN
    UPDATE conversations
    SET updated_at = NEW.timestamp
    WHERE id = NEW.conversation_id;
END;
