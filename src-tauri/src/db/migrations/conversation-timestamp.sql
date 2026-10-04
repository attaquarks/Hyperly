-- Migration 4: make conversations.updated_at monotonic (Phase 4 R9, issue #21).
--
-- THE DEFECT
-- Migration 2's `update_conversation_timestamp_on_message_insert` sets
-- `updated_at = NEW.timestamp` for every inserted message. Listen inserts its
-- messages NEWEST-FIRST (each turn prepends its user/assistant pair), so the LAST
-- row inserted is the OLDEST message and its timestamp wins: `updated_at` ends up
-- holding the oldest message's time. That breaks `ORDER BY updated_at DESC` (the
-- conversation list order) and the timestamp shown in the conversation header.
-- Ask appends oldest-first, so it lands on the newest row and is unaffected -
-- the defect is Listen-only.
--
-- THE FIX
-- Only ever move the key FORWARD: `updated_at = max(updated_at, NEW.timestamp)`.
-- The value is then the newest message in the conversation whatever the insert
-- order, which is what "last activity" means, and it matches what a reload
-- produces (a reload reads the messages in timestamp order).
--
-- WHY A NEW MIGRATION
-- Migration 2 is already applied in users' databases and carries a recorded
-- checksum, so it is never edited. This migration is a strict re-creation of the
-- same two triggers with the monotonic body.
--
-- Non-destructive and idempotent: no table, index or row is touched, and running
-- it again recreates the same triggers (DROP IF EXISTS + CREATE IF NOT EXISTS).
-- Reversible: conversation-timestamp.down.sql restores the migration-2 bodies.

DROP TRIGGER IF EXISTS update_conversation_timestamp_on_message_insert;
DROP TRIGGER IF EXISTS update_conversation_timestamp_on_message_update;

CREATE TRIGGER IF NOT EXISTS update_conversation_timestamp_on_message_insert
AFTER INSERT ON messages
FOR EACH ROW
BEGIN
    UPDATE conversations
    SET updated_at = max(updated_at, NEW.timestamp)
    WHERE id = NEW.conversation_id;
END;

CREATE TRIGGER IF NOT EXISTS update_conversation_timestamp_on_message_update
AFTER UPDATE ON messages
FOR EACH ROW
BEGIN
    UPDATE conversations
    SET updated_at = max(updated_at, NEW.timestamp)
    WHERE id = NEW.conversation_id;
END;
