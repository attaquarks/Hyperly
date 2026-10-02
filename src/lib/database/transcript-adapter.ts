import { getDatabase } from "./config";
import {
  createTranscriptStore,
  type SqlAdapter,
  type TranscriptStore,
} from "@/lib/transcript-store";

/**
 * App-side wiring for the durable transcript store (Phase 4 R3).
 *
 * `transcript-store.ts` stays pure and adapter-injected so the check scripts can
 * drive it with `node:sqlite`; this module is the thin bridge to the real
 * database handle the rest of the app uses (`@tauri-apps/plugin-sql`).
 */
let store: TranscriptStore | null = null;

export const getTranscriptStore = async (): Promise<TranscriptStore> => {
  if (!store) {
    const db = await getDatabase();
    const adapter: SqlAdapter = {
      execute: async (sql, params = []) => {
        const result = await db.execute(sql, params as never[]);
        return {
          rowsAffected: result.rowsAffected,
          lastInsertId: result.lastInsertId,
        };
      },
      select: <T,>(sql: string, params: unknown[] = []) =>
        db.select<T[]>(sql, params as never[]),
    };
    store = createTranscriptStore({ adapter });
  }
  return store;
};
