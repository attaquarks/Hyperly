/**
 * One chronological projection for the AI request history (Phase 4 R6, issue #19).
 *
 * THE DEFECT
 * ----------
 * A Listen session stores messages NEWEST-FIRST (each turn prepends its pair) and
 * one caller mixes a push into that array, yet those messages were handed to the
 * model in that order. A LIVE session therefore sent reverse-chronological
 * context while a RELOADED one was correct (`chat-history.action.ts` reads
 * `ORDER BY timestamp ASC`), so the same conversation behaved differently before
 * and after a restart.
 *
 * THE FIX
 * -------
 * Order once, at the boundary (`processWithAI`), from the timestamps every stored
 * message already carries — not at each call site, so no caller can re-introduce
 * its own order. R3's transcript projection does not go through here and is
 * untouched.
 *
 * `sort` is stable in current engines, so messages sharing a timestamp keep the
 * order they were stored in, and the input array is never mutated.
 */

export interface Timestamped {
  timestamp?: number;
}

export const chronological = <T extends Timestamped>(
  messages: readonly T[]
): T[] =>
  [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
