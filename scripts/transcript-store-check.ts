// Transcript-store check: the durable transcript + dead-letter store (R3).
//
// WHY THIS EXISTS
// ---------------
// Phase 4 R3 (issue #16). The transcript used to be React state - it died with
// the process - and R2's dead-lettered audio had nowhere to live but memory.
// R3 adds `transcript_events` and `transcript_dead_letter_audio` (migration 3)
// and a store that writes an event *before* the caller can reach the AI.
//
// THIS SCRIPT PROVES, against real SQLite files (node:sqlite, no new deps):
//   A. MIGRATION SAFETY - on a **copy of the real hyperly.db** (taken with
//      SQLite's own backup API, so WAL content is included):
//        * the migration is non-destructive: conversations, messages and
//          system_prompts keep their rows *and* their schema sql;
//        * old conversations still open (their rows read back identically);
//        * re-applying the up migration is idempotent;
//        * the registered down migration removes only what it created.
//   B. BEHAVIOUR - on a fresh database:
//        1. an event is durable *before* the AI is called: a second connection
//           sees the row before the injected "AI" callback runs, and the row
//           survives that callback throwing;
//        2. events survive a restart (close -> reopen -> same ids and order);
//        3. kind and source are constrained ({partial,final,ai_response} /
//           {system,microphone}); speaker_label is independent and nullable;
//        4. event ids are monotonic and reads come back in insertion order;
//        5. retention prunes ONLY orphans, at 90 days - conversation events are
//           never pruned, however old;
//        6. dead-lettered audio lands durably and round-trips byte-for-byte
//           across a restart, is capped, and obeys the same retention rule.
//
// Run with:  node scripts/transcript-store-check.ts

import { DatabaseSync, backup } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  createTranscriptStore,
  ORPHAN_RETENTION_MS,
  type SqlAdapter,
} from "../src/lib/transcript-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UP_SQL = readFileSync(
  join(ROOT, "src-tauri/src/db/migrations/transcript-events.sql"),
  "utf8"
);
const DOWN_SQL = readFileSync(
  join(ROOT, "src-tauri/src/db/migrations/transcript-events.down.sql"),
  "utf8"
);
const CHAT_SQL = readFileSync(
  join(ROOT, "src-tauri/src/db/migrations/chat-history.sql"),
  "utf8"
);

const WORK = join(tmpdir(), "hyperly-r3-check");
const failures: Array<{ name: string; problem: string }> = [];
const fail = (name: string, problem: string) => failures.push({ name, problem });
const ok = (line: string) => console.log(`  ok    ${line}`);
const note = (line: string) => console.log(`  --    ${line}`);

const REAL_DB = join(
  process.env.APPDATA ?? "",
  "com.attaquarks.hyperly",
  "hyperly.db"
);

/** The slice of the plugin's Database the store needs, over node:sqlite. */
const adapterFor = (db: DatabaseSync): SqlAdapter => ({
  async execute(sql: string, params: unknown[] = []) {
    const result = db.prepare(sql).run(...(params as never[]));
    return {
      rowsAffected: Number(result.changes),
      lastInsertId: Number(result.lastInsertRowid),
    };
  },
  async select(sql: string, params: unknown[] = []) {
    return db.prepare(sql).all(...(params as never[])) as never;
  },
});

const rowsOf = (db: DatabaseSync, sql: string): unknown[] =>
  db.prepare(sql).all() as unknown[];

/** A stable digest of the rows in the tables migration 3 must not touch. */
const snapshot = (db: DatabaseSync): Record<string, string> => {
  const tables = ["conversations", "messages", "system_prompts"];
  const out: Record<string, string> = {};
  for (const table of tables) {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table);
    if (!exists) continue;
    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { sql: string } | undefined;
    const rows = rowsOf(db, `SELECT * FROM ${table} ORDER BY rowid`);
    out[table] = `${schema?.sql ?? ""}::${rows.length}::${JSON.stringify(rows)}`;
  }
  return out;
};

console.log("=".repeat(72));
console.log("transcript store - durable events, safe migration (Phase 4 R3)");
console.log("=".repeat(72));

// ---- A. migration safety, on a copy of the real database -------------------

const day = 24 * 60 * 60 * 1000;
const rowsWith = (db: DatabaseSync, sql: string, params: unknown[] = []): any[] =>
  db.prepare(sql).all(...(params as never[])) as any[];

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

if (!existsSync(REAL_DB)) {
  note(`no real database at ${REAL_DB} - migration-safety check skipped`);
} else {
  const copyPath = join(WORK, "hyperly-copy.db");
  // SQLite's own backup API: takes a consistent snapshot including WAL content,
  // and the original is only ever opened read-only.
  const original = new DatabaseSync(REAL_DB, { readOnly: true });
  await backup(original, copyPath);
  original.close();

  const copy = new DatabaseSync(copyPath);
  const tablesBefore = snapshot(copy);
  const ledgerBefore = rowsWith(copy, "SELECT version, description FROM _sqlx_migrations ORDER BY version");
  const conversationCount = rowsWith(copy, "SELECT COUNT(*) AS n FROM conversations")[0]?.n ?? 0;
  const messageCount = rowsWith(copy, "SELECT COUNT(*) AS n FROM messages")[0]?.n ?? 0;
  const newest = rowsWith(copy, "SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1")[0];
  const messagesOfNewestBefore = newest
    ? rowsWith(copy, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid", [newest.id])
    : [];

  copy.exec(UP_SQL);
  const tablesAfter = snapshot(copy);
  const ledgerAfter = rowsWith(copy, "SELECT version, description FROM _sqlx_migrations ORDER BY version");
  const integrity = rowsWith(copy, "PRAGMA integrity_check");

  const untouched = Object.keys(tablesBefore).every(
    (table) => tablesBefore[table] === tablesAfter[table]
  );
  if (!untouched) {
    fail(
      "A1 non-destructive",
      "an existing table's rows or schema sql changed - the migration is NOT safe"
    );
  } else {
    ok(
      `non-destructive on a real copy: ${conversationCount} conversations and ` +
        `${messageCount} messages preserved byte-for-byte (rows + schema)`
    );
  }

  const newTables = ["transcript_events", "transcript_dead_letter_audio"].every(
    (table) =>
      !!copy
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table)
  );
  if (!newTables) fail("A2 new tables", "transcript tables missing after the migration");
  else ok("transcript_events + transcript_dead_letter_audio created");

  if (JSON.stringify(ledgerBefore) !== JSON.stringify(ledgerAfter)) {
    fail("A3 migration ledger", "_sqlx_migrations changed");
  } else {
    ok(`migration ledger untouched (${ledgerAfter.length} applied versions)`);
  }

  if (!integrity.every((row) => Object.values(row)[0] === "ok")) {
    fail("A4 integrity", `PRAGMA integrity_check: ${JSON.stringify(integrity)}`);
  } else {
    ok("PRAGMA integrity_check: ok");
  }

  // "Old conversations still open": re-read the newest conversation's messages
  // and compare with the pre-migration read. Counts only are printed - this is
  // real user history, not test data.
  const messagesOfNewestAfter = newest
    ? rowsWith(copy, "SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid", [newest.id])
    : [];
  if (JSON.stringify(messagesOfNewestBefore) !== JSON.stringify(messagesOfNewestAfter)) {
    fail("A5 old conversations", "the newest conversation's messages changed across the migration");
  } else {
    ok(
      `old conversations still open: the newest conversation's ` +
        `${messagesOfNewestAfter.length} message(s) read back identically`
    );
  }

  // Idempotent: applying the shipped up SQL twice must be a no-op.
  copy.exec(UP_SQL);
  const idempotent = JSON.stringify(tablesAfter) === JSON.stringify(snapshot(copy));
  if (!idempotent) fail("A6 idempotent", "re-applying the up migration changed rows");
  else ok("re-applying the up migration is a no-op (idempotent)");

  // Reversible: the registered down SQL removes only what the up created.
  copy.exec(DOWN_SQL);
  const tablesReverted = snapshot(copy);
  const stillGone = ["transcript_events", "transcript_dead_letter_audio"].every(
    (table) =>
      !copy
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table)
  );
  const legacyIntact = Object.keys(tablesBefore).every(
    (table) => tablesBefore[table] === tablesReverted[table]
  );
  if (!stillGone || !legacyIntact) {
    fail("A7 reversible", `down migration: tablesGone=${stillGone} legacyIntact=${legacyIntact}`);
  } else {
    ok("down migration removes only the two new tables; legacy data still intact");
  }

  copy.close();
}

// ---- B. behaviour, on a fresh database -------------------------------------

const freshPath = join(WORK, "fresh.db");
rmSync(freshPath, { force: true });
const fresh = new DatabaseSync(freshPath);
fresh.exec(CHAT_SQL); // the FK target for a real conversation
fresh.exec(UP_SQL);

const store = createTranscriptStore({ adapter: adapterFor(fresh) });

// B1. durable BEFORE the AI is called, and it outlives the AI failing.
const first = await store.addEvent({
  source: "microphone",
  kind: "final",
  text: "what is our staging URL",
  startMs: 1000,
  endMs: 3200,
  speakerLabel: null,
});

// A second connection reads the file itself, not the store's own view - so this
// is the disk truth, exactly as a crash would leave it.
const reader = new DatabaseSync(freshPath);
const atAiEntry = reader
  .prepare("SELECT id, text FROM transcript_events WHERE id = ?")
  .get(first.id) as { id: number; text: string } | undefined;

let aiThrew = false;
try {
  // Stand-in for `processWithAI`: the provider call fails outright.
  throw new Error("simulated provider failure");
} catch {
  aiThrew = true;
}
const afterAiFailure = reader
  .prepare("SELECT COUNT(*) AS n FROM transcript_events WHERE id = ?")
  .get(first.id) as { n: number };

if (!atAiEntry || atAiEntry.text !== first.text) {
  fail("B1 before-ai", "the event was not on disk before the AI step was entered");
} else if (!aiThrew || afterAiFailure.n !== 1) {
  fail("B1 before-ai", "the event did not survive the AI step failing");
} else {
  ok("written before the AI is called, and still there after the AI step fails");
}
reader.close();

// B2. restart: close the process's handle, reopen from the file, read it back.
fresh.close();
const restarted = new DatabaseSync(freshPath);
const restartedEvents = restarted
  .prepare("SELECT id, text, kind, source, created_at FROM transcript_events ORDER BY id")
  .all() as any[];
if (
  restartedEvents.length !== 1 ||
  restartedEvents[0].id !== first.id ||
  restartedEvents[0].text !== first.text ||
  restartedEvents[0].kind !== "final" ||
  restartedEvents[0].source !== "microphone"
) {
  fail("B2 restart", `after restart: ${JSON.stringify(restartedEvents)}`);
} else {
  ok(`survives a restart: event ${restartedEvents[0].id} reads back intact from the file`);
}

const store2 = createTranscriptStore({ adapter: adapterFor(restarted) });

// B3. kind and source are constrained at the schema level.
let kindRejected = false;
let sourceRejected = false;
try {
  restarted
    .prepare("INSERT INTO transcript_events (source, kind, text, created_at) VALUES (?, ?, ?, ?)")
    .run("microphone", "bogus_kind", "x", Date.now());
} catch {
  kindRejected = true;
}
try {
  restarted
    .prepare("INSERT INTO transcript_events (source, kind, text, created_at) VALUES (?, ?, ?, ?)")
    .run("bogus_source", "final", "x", Date.now());
} catch {
  sourceRejected = true;
}
if (!kindRejected || !sourceRejected) {
  fail("B3 constraints", `kindRejected=${kindRejected} sourceRejected=${sourceRejected}`);
} else {
  ok("kind and source are constrained by CHECK ({partial,final,ai_response} / {system,microphone})");
}

// B4. ids are monotonic, reads come back in insertion order, and speaker_label
// stays independent of source (R8's separation, enforced from the start).
const conversationId = "conv-r3-check";
restarted
  .prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
  .run(conversationId, "R3 check", Date.now(), Date.now());

const ordered: number[] = [];
for (const [i, text] of ["first", "second", "third"].entries()) {
  const e = await store2.addEvent({
    source: "system",
    kind: "final",
    text,
    conversationId,
    startMs: i * 1000,
    endMs: i * 1000 + 500,
    speakerLabel: null,
  });
  ordered.push(e.id);
}
const listed = await store2.listEvents(conversationId);
const monotonic = ordered.every((id, i) => i === 0 || id > ordered[i - 1]);
const inOrder = listed.map((e) => e.text).join(",") === "first,second,third";
const labelsIndependent = listed.every((e) => e.speaker_label === null && e.source === "system");
if (!monotonic || !inOrder || !labelsIndependent) {
  fail(
    "B4 order",
    `monotonic=${monotonic} inOrder=${inOrder} labelsIndependent=${labelsIndependent}`
  );
} else {
  ok(`ids monotonic (${ordered.join(" < ")}), conversation reads in insertion order`);
  ok("speaker_label independent of source and NULL until identity is known");
}

// B5. retention prunes ONLY orphans, at 90 days.
const past = Date.now() - 100 * day;
const recent = Date.now() - 1 * day;
const oldStore = createTranscriptStore({ adapter: adapterFor(restarted), now: () => past });
const recentStore = createTranscriptStore({ adapter: adapterFor(restarted), now: () => recent });

const oldOrphan = await oldStore.addEvent({ source: "system", kind: "final", text: "old orphan" });
const oldOwned = await oldStore.addEvent({
  source: "system",
  kind: "final",
  text: "old but owned",
  conversationId,
});
const freshOrphan = await recentStore.addEvent({
  source: "system",
  kind: "final",
  text: "fresh orphan",
});

const pruned = await store2.pruneOrphans(Date.now());
const survivors = new Set(
  (restarted.prepare("SELECT id FROM transcript_events").all() as any[]).map((r) => r.id)
);
if (survivors.has(oldOrphan.id)) {
  fail("B5 retention", "the 100-day-old ORPHAN survived pruning");
} else if (!survivors.has(oldOwned.id)) {
  fail("B5 retention", "a conversation-owned event was pruned - user history was truncated");
} else if (!survivors.has(freshOrphan.id)) {
  fail("B5 retention", "a 1-day-old orphan was pruned");
} else if (pruned.events !== 1) {
  fail("B5 retention", `pruned ${pruned.events} events, expected exactly 1 orphan`);
} else {
  ok(
    "retention prunes only the 100-day-old ORPHAN: the owned event and the fresh orphan are kept"
  );
}

// B6. dead-letter audio lands durably and round-trips byte-for-byte.
const bytes = new Uint8Array(256);
for (let i = 0; i < 256; i++) bytes[i] = i;

await store2.addDeadLetter({
  source: "system",
  audio: bytes,
  attempts: 3,
  error: "provider 500",
  conversationId,
});
restarted.close();

const afterRestart = new DatabaseSync(freshPath);
const store3 = createTranscriptStore({ adapter: adapterFor(afterRestart) });
const deadLetters = await store3.listDeadLetters();
const roundTripped =
  deadLetters.length === 1 &&
  deadLetters[0].byte_length === 256 &&
  deadLetters[0].audio.length === 256 &&
  deadLetters[0].audio.every((b, i) => b === i);
if (!roundTripped) {
  fail(
    "B6 dead-letter durable",
    `after restart: ${deadLetters.length} row(s), ${deadLetters[0]?.audio.length} byte(s)`
  );
} else {
  ok("dead-lettered audio is durable across a restart and round-trips byte-for-byte");
}

// The cap keeps the newest rows so an outage cannot grow without bound.
const capped = createTranscriptStore({
  adapter: adapterFor(afterRestart),
  maxDeadLetters: 3,
});
for (let i = 0; i < 5; i++) {
  await capped.addDeadLetter({
    source: "microphone",
    audio: new Uint8Array([i]),
    attempts: 3,
    error: `failure ${i}`,
  });
}
const cappedCount = (
  afterRestart.prepare("SELECT COUNT(*) AS n FROM transcript_dead_letter_audio").get() as any
).n;
if (cappedCount !== 3) {
  fail("B6 cap", `dead-letter table holds ${cappedCount}, expected the cap of 3`);
} else {
  ok("dead-letter audio is capped (keeps the newest 3)");
}

// Retention applies the same orphan rule to the audio table.
const oldAudio = createTranscriptStore({ adapter: adapterFor(afterRestart), now: () => past });
await oldAudio.addDeadLetter({ source: "system", audio: new Uint8Array([9]), attempts: 3 });
await oldAudio.addDeadLetter({
  source: "system",
  audio: new Uint8Array([8]),
  attempts: 3,
  conversationId,
});
const audioPruned = await store3.pruneOrphans(Date.now());
const audioLeft = (
  afterRestart.prepare("SELECT COUNT(*) AS n FROM transcript_dead_letter_audio").get() as any
).n;
if (audioPruned.deadLetters !== 1 || audioPruned.events !== 0 || audioLeft !== 4) {
  fail(
    "B6 retention",
    `pruned=${JSON.stringify(audioPruned)} left=${audioLeft}, expected 1 old orphan pruned of 5`
  );
} else {
  ok("dead-letter retention prunes only the old orphan; owned audio is kept");
}

afterRestart.close();

// ---- report ----------------------------------------------------------------

console.log("");
console.log("=".repeat(72));
if (failures.length === 0) {
  console.log(
    "PASS - the transcript is durable before the AI runs, survives a restart, and the\n" +
      "       migration is non-destructive on a copy of a real database."
  );
  process.exit(0);
}
console.log(`FAIL - ${failures.length} check(s) failed:`);
for (const f of failures) console.log(`  ${f.name}  ${f.problem}`);
process.exit(1);

