/**
 * Durable transcript-event store (Phase 4 R3, issue #16).
 *
 * WHY THIS EXISTS
 * ---------------
 * `transcriptSegments` was React state: it died with the process, and only Q/A
 * pairs that had already reached the model were persisted. Nothing survived a
 * restart, which made the README's "every session is saved with its full
 * transcript" false. Events are now written to SQLite **as they happen**,
 * independently of the AI: the write completes before the caller is handed the
 * text, so an AI failure (or a crash) can never lose speech.
 *
 * THE SHAPE (decisions recorded on issue #16)
 * -------------------------------------------
 *   * ids are `INTEGER PRIMARY KEY AUTOINCREMENT` (see transcript-events.sql) -
 *     monotonic, collision-free, native to SQLite, no id crate.
 *   * `kind` in {partial, final, ai_response}; the conversation is a projection
 *     of this log.
 *   * `source` in {system, microphone} is separate from `speaker_label`, which
 *     stays NULL until identity is genuinely known (R8).
 *   * retention: events that belong to a conversation are kept forever; only
 *     orphans (`conversation_id IS NULL`, e.g. the app was killed before a save)
 *     are pruned, at 90 days.
 *
 * TESTABILITY
 * -----------
 * The SQL adapter is injected, so `scripts/transcript-store-check.ts` drives
 * this module against a real SQLite file with `node:sqlite` - including the
 * migration itself and a restart. This module deliberately has no imports.
 */

export type SpeechSource = "system" | "microphone";
export type TranscriptKind = "partial" | "final" | "ai_response";

export interface TranscriptEvent {
  id: number;
  conversation_id: string | null;
  source: SpeechSource;
  kind: TranscriptKind;
  text: string;
  start_ms: number | null;
  end_ms: number | null;
  speaker_label: string | null;
  created_at: number;
}

export interface DeadLetterAudio {
  id: number;
  conversation_id: string | null;
  source: SpeechSource;
  audio: Uint8Array;
  byte_length: number;
  attempts: number;
  error: string | null;
  created_at: number;
}

/** The slice of `@tauri-apps/plugin-sql`'s `Database` this store needs. */
export interface SqlAdapter {
  execute(
    sql: string,
    params?: unknown[]
  ): Promise<{ rowsAffected?: number; lastInsertId?: number }>;
  select<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const ORPHAN_RETENTION_DAYS = 90;
export const ORPHAN_RETENTION_MS =
  ORPHAN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** Dead-letter audio is capped so a long outage cannot grow without bound. */
export const MAX_DEAD_LETTERS = 20;

export interface AddEventInput {
  source: SpeechSource;
  kind: TranscriptKind;
  text: string;
  conversationId?: string | null;
  startMs?: number | null;
  endMs?: number | null;
  speakerLabel?: string | null;
}

export interface AddDeadLetterInput {
  source: SpeechSource;
  audio: Uint8Array;
  attempts: number;
  error?: string | null;
  conversationId?: string | null;
}

export interface TranscriptStoreOptions {
  adapter: SqlAdapter;
  now?: () => number;
  maxDeadLetters?: number;
  orphanRetentionMs?: number;
}

export interface TranscriptStore {
  addEvent(input: AddEventInput): Promise<TranscriptEvent>;
  listEvents(conversationId: string, limit?: number): Promise<TranscriptEvent[]>;
  /** The newest unsaved (orphan) events, oldest-first - the crash-recovery read. */
  listRecentOrphans(limit?: number): Promise<TranscriptEvent[]>;
  addDeadLetter(input: AddDeadLetterInput): Promise<DeadLetterAudio>;
  listDeadLetters(limit?: number): Promise<DeadLetterAudio[]>;
  /** Retention: orphans only. Returns how many rows each table lost. */
  pruneOrphans(now?: number): Promise<{ events: number; deadLetters: number }>;
  countEvents(): Promise<number>;
}

const VALID_SOURCES: readonly SpeechSource[] = ["system", "microphone"];
const VALID_KINDS: readonly TranscriptKind[] = ["partial", "final", "ai_response"];

/** Base64 helpers that work in the webview and under node. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(bytes).toString("base64");
};

export const base64ToBytes = (text: string): Uint8Array => {
  if (typeof atob === "function") {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(text, "base64"));
};

export const createTranscriptStore = (
  options: TranscriptStoreOptions
): TranscriptStore => {
  const { adapter } = options;
  const now = options.now ?? (() => Date.now());
  const maxDeadLetters = options.maxDeadLetters ?? MAX_DEAD_LETTERS;
  const orphanRetentionMs = options.orphanRetentionMs ?? ORPHAN_RETENTION_MS;

  const assertSource = (source: string): SpeechSource => {
    if (!VALID_SOURCES.includes(source as SpeechSource)) {
      throw new Error(`Unknown speech source: ${source}`);
    }
    return source as SpeechSource;
  };
  const assertKind = (kind: string): TranscriptKind => {
    if (!VALID_KINDS.includes(kind as TranscriptKind)) {
      throw new Error(`Unknown transcript kind: ${kind}`);
    }
    return kind as TranscriptKind;
  };

  return {
    async addEvent(input: AddEventInput): Promise<TranscriptEvent> {
      const source = assertSource(input.source);
      const kind = assertKind(input.kind);
      const createdAt = now();
      const result = await adapter.execute(
        "INSERT INTO transcript_events " +
          "(conversation_id, source, kind, text, start_ms, end_ms, speaker_label, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          input.conversationId ?? null,
          source,
          kind,
          input.text,
          input.startMs ?? null,
          input.endMs ?? null,
          input.speakerLabel ?? null,
          createdAt,
        ]
      );
      const id = result.lastInsertId;
      if (typeof id !== "number") {
        throw new Error("transcript_events insert returned no id");
      }
      return {
        id,
        conversation_id: input.conversationId ?? null,
        source,
        kind,
        text: input.text,
        start_ms: input.startMs ?? null,
        end_ms: input.endMs ?? null,
        speaker_label: input.speakerLabel ?? null,
        created_at: createdAt,
      };
    },

    listEvents(conversationId: string, limit = 500): Promise<TranscriptEvent[]> {
      return adapter.select<TranscriptEvent>(
        "SELECT * FROM transcript_events WHERE conversation_id = ? ORDER BY id ASC LIMIT ?",
        [conversationId, limit]
      );
    },

    async listRecentOrphans(limit = 200): Promise<TranscriptEvent[]> {
      // Selected by newest id, then reversed so the caller renders oldest-first.
      const rows = await adapter.select<TranscriptEvent>(
        "SELECT * FROM transcript_events WHERE conversation_id IS NULL ORDER BY id DESC LIMIT ?",
        [limit]
      );
      return rows.reverse();
    },

    async addDeadLetter(input: AddDeadLetterInput): Promise<DeadLetterAudio> {
      const source = assertSource(input.source);
      const audioBase64 = bytesToBase64(input.audio);
      const createdAt = now();
      const result = await adapter.execute(
        "INSERT INTO transcript_dead_letter_audio " +
          "(conversation_id, source, audio_base64, byte_length, attempts, error, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          input.conversationId ?? null,
          source,
          audioBase64,
          input.audio.byteLength,
          input.attempts,
          input.error ?? null,
          createdAt,
        ]
      );
      // Cap the table: keep the newest rows, drop the rest.
      await adapter.execute(
        "DELETE FROM transcript_dead_letter_audio WHERE id NOT IN " +
          "(SELECT id FROM transcript_dead_letter_audio ORDER BY id DESC LIMIT ?)",
        [maxDeadLetters]
      );
      const id = result.lastInsertId;
      if (typeof id !== "number") {
        throw new Error("transcript_dead_letter_audio insert returned no id");
      }
      return {
        id,
        conversation_id: input.conversationId ?? null,
        source,
        audio: input.audio,
        byte_length: input.audio.byteLength,
        attempts: input.attempts,
        error: input.error ?? null,
        created_at: createdAt,
      };
    },

    async listDeadLetters(limit = 50): Promise<DeadLetterAudio[]> {
      const rows = await adapter.select<
        Omit<DeadLetterAudio, "audio"> & { audio_base64: string }
      >(
        "SELECT * FROM transcript_dead_letter_audio ORDER BY id DESC LIMIT ?",
        [limit]
      );
      return rows.map((row) => ({
        id: row.id,
        conversation_id: row.conversation_id,
        source: row.source,
        audio: base64ToBytes(row.audio_base64),
        byte_length: row.byte_length,
        attempts: row.attempts,
        error: row.error,
        created_at: row.created_at,
      }));
    },

    async pruneOrphans(
      at = now()
    ): Promise<{ events: number; deadLetters: number }> {
      // Retention touches ONLY orphans: anything belonging to a conversation is
      // kept forever, so user history is never silently truncated.
      const cutoff = at - orphanRetentionMs;
      const events = await adapter.execute(
        "DELETE FROM transcript_events WHERE conversation_id IS NULL AND created_at < ?",
        [cutoff]
      );
      const deadLetters = await adapter.execute(
        "DELETE FROM transcript_dead_letter_audio WHERE conversation_id IS NULL AND created_at < ?",
        [cutoff]
      );
      return {
        events: events.rowsAffected ?? 0,
        deadLetters: deadLetters.rowsAffected ?? 0,
      };
    },

    async countEvents(): Promise<number> {
      const rows = await adapter.select<{ n: number }>(
        "SELECT COUNT(*) AS n FROM transcript_events"
      );
      return rows[0]?.n ?? 0;
    },
  };
};
