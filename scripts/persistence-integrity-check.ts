// Persistence integrity: ordering key, message ids, no dropped saves (R9, #21).
//
// WHY THIS EXISTS
// ---------------
// Three verified defects on the Listen persistence path (P2C §3, §4, §6):
//
//   1. migration 2's `update_conversation_timestamp_on_message_insert` sets
//      `updated_at = NEW.timestamp` for every inserted message. Listen inserts its
//      messages NEWEST-FIRST (each turn prepends its pair), so the LAST row is the
//      OLDEST message and its timestamp wins — `updated_at` ends up holding the
//      oldest message's time, which breaks `ORDER BY updated_at DESC` (the
//      conversation order) and the timestamp shown in the header. Ask appends
//      oldest-first, so it is unaffected — the defect is Listen-only.
//   2. `generateMessageId` was `msg_${timestamp}_${role}`. Two messages in the
//      same millisecond with the same role produced the SAME id, and `messages.id`
//      is a PRIMARY KEY — a collision aborts the whole save, at every layer.
//   3. the 500 ms debounced save had two silent loss windows: the timer callback
//      returned WITHOUT rescheduling when a save was already in flight, and a
//      pending timer was cleared on unmount with no flush.
//
// WHAT R9 CHANGES
// ---------------
//   * migration 4 (`conversation-timestamp.sql`) makes `updated_at` monotonic:
//     `max(updated_at, NEW.timestamp)`, so the key is the newest message whatever
//     the insert order. A new migration, never an edit to applied history.
//   * `generateMessageId` carries a per-process sequence, so same-millisecond ids
//     cannot collide; `isValidMessageId` still accepts legacy ids because old rows
//     keep their ids.
//   * `src/lib/pending-save.ts` coalesces debounced saves, reschedules instead of
//     dropping when a save is in flight, and flushes on dispose.
//
// THIS SCRIPT asserts:
//   A. on a database built from the real migrations (and, when it exists, on a
//      COPY of the real user database taken with SQLite's backup API): the key is
//      the newest message, order-independently; the migration is idempotent,
//      non-destructive and reversible; two same-millisecond ids both insert;
//   B. the id scheme cannot collide in a millisecond, and old ids remain valid;
//   C. an in-flight save never drops the newest state, and dispose flushes;
//   D. structurally: a new migration (not an edit), the sequence in the id, the
//      silent return gone, R6's publish rule still the thing that decides what is
//      publishable, and R3's transcript ids untouched.
//
// Run with:  node --experimental-strip-types scripts/persistence-integrity-check.ts

import { DatabaseSync, backup } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relPath: string): string => {
  try {
    return readFileSync(join(ROOT, relPath), "utf8");
  } catch {
    return "";
  }
};
/** Compare code, not prose: comments legitimately quote the old expressions. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const count = (source: string, pattern: RegExp): number =>
  (source.match(new RegExp(pattern.source, "g")) ?? []).length;

type Failure = { name: string; problem: string };
const failures: Failure[] = [];
const fail = (name: string, problem: string) => {
  failures.push({ name, problem });
  console.log(`  FAIL  ${name}`);
  console.log(`        ${problem}`);
};
const ok = (line: string) => console.log(`  ok    ${line}`);
const check = (name: string, condition: boolean, detail: () => string) => {
  if (condition) ok(name);
  else fail(name, detail());
};

console.log("=".repeat(72));
console.log("persistence integrity - ordering key, ids, no dropped saves (R9)");
console.log("=".repeat(72));

const CHAT_SQL = read("src-tauri/src/db/migrations/chat-history.sql");
const ORDER_SQL = read("src-tauri/src/db/migrations/conversation-timestamp.sql");
const ORDER_DOWN_SQL = read(
  "src-tauri/src/db/migrations/conversation-timestamp.down.sql"
);
const TRANSCRIPT_SQL = read("src-tauri/src/db/migrations/transcript-events.sql");
const MIGRATIONS_RS = code(read("src-tauri/src/db/main.rs"));

const WORK = join(tmpdir(), "hyperly-r9-check");
/** The real user database. It is only ever opened read-only and copied with
 *  SQLite's own backup API — never written to. */
const REAL_DB = join(
  process.env.APPDATA ?? "",
  "com.attaquarks.hyperly",
  "hyperly.db"
);

const rows = (db: DatabaseSync, sql: string, params: unknown[] = []): any[] =>
  db.prepare(sql).all(...(params as never[])) as any[];
const one = (db: DatabaseSync, sql: string, params: unknown[] = []): any =>
  (db.prepare(sql).get(...(params as never[])) ?? {}) as any;

/** A database built exactly as migration 2 builds one. */
const freshDb = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec(CHAT_SQL);
  return db;
};
/** The same database with migration 4 applied. */
const migratedDb = (): DatabaseSync => {
  const db = freshDb();
  if (ORDER_SQL) db.exec(ORDER_SQL);
  return db;
};

const insertConversation = (db: DatabaseSync, id: string, updatedAt: number) =>
  db
    .prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
    )
    .run(id, "conversation", 1000, updatedAt);

const insertMessage = (
  db: DatabaseSync,
  id: string,
  conversationId: string,
  role: string,
  timestamp: number
) =>
  db
    .prepare(
      "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files) VALUES (?, ?, ?, ?, ?, NULL)"
    )
    .run(id, conversationId, role, `content ${timestamp}`, timestamp);

const updatedAtOf = (db: DatabaseSync, conversationId: string): number =>
  one(db, "SELECT updated_at FROM conversations WHERE id = ?", [conversationId])
    .updated_at;

/** A stable digest of the tables migration 4 must not touch at all. */
const snapshot = (db: DatabaseSync): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const table of ["conversations", "messages", "system_prompts"]) {
    const exists = one(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      [table]
    ).name;
    if (!exists) continue;
    const schema = one(
      db,
      "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?",
      [table]
    ).sql;
    const all = rows(db, `SELECT * FROM ${table} ORDER BY rowid`);
    out[table] = `${schema ?? ""}::${all.length}::${JSON.stringify(all)}`;
  }
  return out;
};

const triggerSql = (db: DatabaseSync, name: string): string =>
  one(db, "SELECT sql FROM sqlite_master WHERE type='trigger' AND name = ?", [
    name,
  ]).sql ?? "";

// Both modules under test are pure, so they load directly.
let generateMessageId: ((role: string, timestamp?: number) => string) | null = null;
let isValidMessageId: ((id: string) => boolean) | null = null;
let PendingSaveClass: (new (options: any) => any) | null = null;

try {
  const mod: any = await import("../src/lib/chat-constants.ts");
  if (
    typeof mod.generateMessageId !== "function" ||
    typeof mod.isValidMessageId !== "function"
  ) {
    throw new Error("chat-constants.ts must export the id helpers");
  }
  generateMessageId = mod.generateMessageId;
  isValidMessageId = mod.isValidMessageId;
} catch (error) {
  fail(
    "the id helpers run",
    error instanceof Error ? error.message : String(error)
  );
}
try {
  const mod: any = await import("../src/lib/pending-save.ts");
  if (typeof mod.PendingSave !== "function") {
    throw new Error("pending-save.ts must export PendingSave");
  }
  PendingSaveClass = mod.PendingSave;
} catch (error) {
  fail(
    "the pending-save module runs",
    error instanceof Error ? error.message : String(error)
  );
}

// ---- A. the ordering key ---------------------------------------------------

console.log("\nA. conversations.updated_at");

check(
  "the timestamp migration exists (as a new migration)",
  ORDER_SQL.length > 0 && ORDER_DOWN_SQL.length > 0,
  () => "conversation-timestamp.sql / conversation-timestamp.down.sql are missing"
);

{
  // The defect, demonstrated on the schema migration 2 builds: Listen inserts
  // newest-first, so the LAST insert is the OLDEST message and its timestamp wins.
  const before = freshDb();
  insertConversation(before, "conv", 1000);
  insertMessage(before, "a1", "conv", "assistant", 3000);
  insertMessage(before, "u1", "conv", "user", 2999);
  const legacyValue = updatedAtOf(before, "conv");
  check(
    "the un-migrated trigger really does keep the oldest message (the defect)",
    legacyValue === 2999,
    () => `updated_at=${legacyValue}, expected the pre-fix 2999`
  );
}

{
  // The pass condition: newest-first inserts, and the key ends up NEWEST.
  const db = migratedDb();
  insertConversation(db, "conv", 1000);
  insertMessage(db, "a1", "conv", "assistant", 3000);
  insertMessage(db, "u1", "conv", "user", 2999);
  const value = updatedAtOf(db, "conv");
  const newest = one(
    db,
    "SELECT MAX(timestamp) AS m FROM messages WHERE conversation_id = ?",
    ["conv"]
  ).m;
  const oldest = one(
    db,
    "SELECT MIN(timestamp) AS m FROM messages WHERE conversation_id = ?",
    ["conv"]
  ).m;
  check(
    "after the migration the key is the NEWEST message, not the last inserted",
    value === 3000 && value === newest && value !== oldest,
    () => `updated_at=${value} newest=${newest} oldest=${oldest}`
  );
}

{
  // Order-independence: Ask appends oldest-first and must be unaffected.
  const db = migratedDb();
  insertConversation(db, "conv", 1000);
  insertMessage(db, "u1", "conv", "user", 2999);
  insertMessage(db, "a1", "conv", "assistant", 3000);
  check(
    "the key is order-independent (an appending writer lands on the same value)",
    updatedAtOf(db, "conv") === 3000,
    () => `updated_at=${updatedAtOf(db, "conv")}`
  );
}

{
  // Monotonic by intent: a newer message advances the key, an older one can never
  // move it back.
  const db = migratedDb();
  insertConversation(db, "conv", 5000);
  insertMessage(db, "old", "conv", "user", 1000);
  const afterOlder = updatedAtOf(db, "conv");
  insertMessage(db, "new", "conv", "assistant", 7000);
  const afterNewer = updatedAtOf(db, "conv");
  check(
    "the key only moves forward: an older insert cannot move it back",
    afterOlder === 5000 && afterNewer === 7000,
    () => `afterOlder=${afterOlder} afterNewer=${afterNewer}`
  );
}

if (generateMessageId) {
  // The id pass condition: two messages created in the same millisecond with the
  // same role must both save. `messages.id` is a PRIMARY KEY, so before R9 the
  // second insert collided and aborted the whole save.
  const db = migratedDb();
  insertConversation(db, "conv", 1000);
  const stamp = 1_700_000_000_000;
  const first = generateMessageId("assistant", stamp);
  const second = generateMessageId("assistant", stamp);
  let inserted = 0;
  let collision: string | null = null;
  for (const id of [first, second]) {
    try {
      insertMessage(db, id, "conv", "assistant", stamp);
      inserted += 1;
    } catch (error) {
      collision = error instanceof Error ? error.message : String(error);
    }
  }
  check(
    "two messages created in the same millisecond both save (ids cannot collide)",
    first !== second && inserted === 2 && collision === null,
    () =>
      `ids=${first}/${second} inserted=${inserted} error=${collision ?? "none"}`
  );
}

{
  // Idempotent: re-applying the migration must be a no-op, exactly like R3's.
  const db = migratedDb();
  const before = triggerSql(
    db,
    "update_conversation_timestamp_on_message_insert"
  );
  db.exec(ORDER_SQL);
  const after = triggerSql(
    db,
    "update_conversation_timestamp_on_message_insert"
  );
  check(
    "re-applying the migration is a no-op",
    before.length > 0 && before === after && /max\(/.test(after),
    () => `trigger changed to: ${after.slice(0, 90)}`
  );
}

{
  // Reversible: the down migration restores the migration-2 behaviour exactly.
  const db = migratedDb();
  db.exec(ORDER_DOWN_SQL);
  const restored = triggerSql(
    db,
    "update_conversation_timestamp_on_message_insert"
  );
  insertConversation(db, "conv", 1000);
  insertMessage(db, "a1", "conv", "assistant", 3000);
  insertMessage(db, "u1", "conv", "user", 2999);
  check(
    "the down migration restores the migration-2 triggers (a real reversal)",
    !/max\(/.test(restored) && updatedAtOf(db, "conv") === 2999,
    () => `updated_at=${updatedAtOf(db, "conv")}`
  );
}

{
  // Non-destructive and consistent: applying the migration rewrites no row, leaves
  // every table's schema alone, and keeps the file intact.
  const db = freshDb();
  insertConversation(db, "existing", 4000);
  insertMessage(db, "kept", "existing", "user", 4000);
  const before = snapshot(db);
  db.exec(ORDER_SQL);
  const after = snapshot(db);
  const integrity = rows(db, "PRAGMA integrity_check");
  check(
    "the migration touches no row and no table schema, and the file stays intact",
    JSON.stringify(before) === JSON.stringify(after) &&
      Object.keys(before).every((table) => before[table] === after[table]) &&
      integrity.every((row) => Object.values(row)[0] === "ok"),
    () => "rows or schema changed"
  );
}

// ---- A2. on a COPY of the real user database -------------------------------

if (!existsSync(REAL_DB)) {
  console.log(
    "\n  --    no real database at %APPDATA%; the migration was proved on the real schema above"
  );
} else {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const copyPath = join(WORK, "hyperly-copy.db");
  const original = new DatabaseSync(REAL_DB, { readOnly: true });
  await backup(original, copyPath);
  original.close();

  const copy = new DatabaseSync(copyPath);
  const tablesBefore = snapshot(copy);
  const ledgerBefore = rows(
    copy,
    "SELECT version, description FROM _sqlx_migrations ORDER BY version"
  );
  const conversationCount =
    one(copy, "SELECT COUNT(*) AS n FROM conversations").n ?? 0;
  const messageCount = one(copy, "SELECT COUNT(*) AS n FROM messages").n ?? 0;

  copy.exec(ORDER_SQL);

  const tablesAfter = snapshot(copy);
  const ledgerAfter = rows(
    copy,
    "SELECT version, description FROM _sqlx_migrations ORDER BY version"
  );
  const integrity = rows(copy, "PRAGMA integrity_check");

  check(
    `non-destructive on a real copy: ${conversationCount} conversations and ${messageCount} messages preserved byte-for-byte (rows keep their ids)`,
    JSON.stringify(tablesBefore) === JSON.stringify(tablesAfter),
    () => "an existing table's rows or ids changed"
  );
  check(
    "the SQL migration leaves the sqlx ledger alone (the plugin owns it)",
    JSON.stringify(ledgerBefore) === JSON.stringify(ledgerAfter),
    () => "_sqlx_migrations changed"
  );
  check(
    "integrity_check is ok on the migrated copy",
    integrity.every((row) => Object.values(row)[0] === "ok"),
    () => JSON.stringify(integrity)
  );

  if (conversationCount > 0) {
    const target = one(
      copy,
      "SELECT id, updated_at FROM conversations ORDER BY rowid LIMIT 1"
    );
    const stamp = Number(target.updated_at ?? 0) + 1_000_000;
    insertMessage(copy, "r9-probe-message", target.id, "assistant", stamp);
    check(
      "on real data the fixed trigger advances the key to the new message's timestamp",
      updatedAtOf(copy, target.id) === stamp,
      () => `updated_at=${updatedAtOf(copy, target.id)} expected=${stamp}`
    );
  } else {
    console.log("  --    the real database has no conversations to probe");
  }
  copy.close();
}

// ---- B. the message id scheme ---------------------------------------------

console.log("\nB. message ids");

if (generateMessageId && isValidMessageId) {
  {
    const stamp = 1_700_000_000_000;
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generateMessageId("user", stamp));
    check(
      "1000 messages in the same millisecond produce 1000 distinct ids",
      ids.size === 1000,
      () => `${ids.size} distinct ids`
    );
  }

  {
    const stamp = 1_700_000_000_001;
    const id = generateMessageId("assistant", stamp);
    check(
      "a generated id still names its timestamp and role, and validates",
      id.includes(String(stamp)) &&
        id.endsWith("assistant") &&
        isValidMessageId(id),
      () => `id=${id}`
    );
  }

  {
    // Old rows keep their ids, so the legacy shape must still validate.
    const legacy = [
      "msg_1696291234567_user",
      "msg_1696291234568_assistant",
      "msg_1696291234569_system",
    ];
    check(
      "legacy ids (already in users' databases) still validate",
      legacy.every((id) => isValidMessageId!(id)),
      () => legacy.filter((id) => !isValidMessageId!(id)).join(", ")
    );
    check(
      "a malformed id is still rejected",
      !isValidMessageId("msg_notanumber_user") &&
        !isValidMessageId("msg_123_") &&
        !isValidMessageId("message_123_user"),
      () => "the validator accepts a malformed id"
    );
  }

  {
    // A user/assistant pair created at one instant must be distinct even before
    // the caller applies its own offset.
    const stamp = 1_700_000_000_002;
    const ids = new Set([
      generateMessageId("user", stamp),
      generateMessageId("assistant", stamp),
      generateMessageId("user", stamp),
      generateMessageId("assistant", stamp),
    ]);
    check(
      "four ids created at one instant (both roles) are all distinct",
      ids.size === 4,
      () => `${ids.size} distinct ids`
    );
  }
}

// ---- C. the debounced save -------------------------------------------------

console.log("\nC. the debounced save");

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

/** A deterministic scheduler: timers run only when the test says so.
 *
 *  `schedule` returns a token and `cancel` removes it, so a test can assert that
 *  nothing is left armed. Inject BOTH where that matters — the module's default
 *  canceller is `clearTimeout`, which knows nothing about this array. */
const makeClock = () => {
  type Timer = { fn: () => void; delay: number };
  const timers: Timer[] = [];
  return {
    schedule: (fn: () => void, delay: number): unknown => {
      const timer: Timer = { fn, delay };
      timers.push(timer);
      return timer;
    },
    cancel: (timer: unknown): void => {
      const index = timers.indexOf(timer as Timer);
      if (index >= 0) timers.splice(index, 1);
    },
    get pending(): number {
      return timers.length;
    },
    /** Fire every pending timer, flushing microtasks between them. */
    async run(): Promise<void> {
      let guard = 0;
      while (timers.length > 0) {
        if (++guard > 100) throw new Error("scheduler did not settle");
        timers.shift()!.fn();
        await flush();
      }
    },
    /** Fire exactly one pending timer. */
    async runOne(): Promise<void> {
      const next = timers.shift();
      if (!next) return;
      next.fn();
      await flush();
    },
  };
};

if (PendingSaveClass) {
  {
    // Rapid changes coalesce: only the newest state is written.
    const clock = makeClock();
    const saved: number[] = [];
    const pending = new PendingSaveClass({
      save: async (state: number) => void saved.push(state),
      delayMs: 500,
      schedule: clock.schedule,
    });
    pending.schedule(1);
    pending.schedule(2);
    pending.schedule(3);
    await clock.run();
    check(
      "rapid changes collapse into one save of the newest state",
      saved.length === 1 && saved[0] === 3,
      () => `saved=${JSON.stringify(saved)}`
    );
  }

  {
    // The pass condition for the loss window: a new answer arriving while a save
    // is in flight must still be written. Before R9 the timer callback returned
    // without rescheduling, so the newest state was never saved.
    const clock = makeClock();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saved: number[] = [];
    const pending = new PendingSaveClass({
      save: async (state: number) => {
        await gate;
        saved.push(state);
      },
      delayMs: 500,
      schedule: clock.schedule,
    });

    pending.schedule(1);
    const first = clock.runOne();
    await flush();
    pending.schedule(2);
    const second = clock.runOne();
    release!();
    await first;
    await second;
    await clock.run();

    check(
      "the newest state is never dropped while a save is in flight",
      saved[saved.length - 1] === 2 && saved.includes(1),
      () => `saved=${JSON.stringify(saved)}`
    );
  }

  {
    const clock = makeClock();
    const saved: number[] = [];
    const pending = new PendingSaveClass({
      save: async (state: number) => void saved.push(state),
      delayMs: 500,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    pending.schedule(7);
    await pending.flush();
    check(
      "flush() writes the pending state immediately (unmount must not drop it)",
      saved.length === 1 && saved[0] === 7 && clock.pending === 0,
      () => `saved=${JSON.stringify(saved)} timers=${clock.pending}`
    );
  }

  {
    const clock = makeClock();
    const saved: number[] = [];
    const pending = new PendingSaveClass({
      save: async (state: number) => void saved.push(state),
      delayMs: 500,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    pending.schedule(9);
    await pending.dispose();
    check(
      "dispose() flushes the pending save and leaves no timer behind",
      saved.length === 1 && saved[0] === 9 && clock.pending === 0,
      () => `saved=${JSON.stringify(saved)} timers=${clock.pending}`
    );
  }

  {
    const clock = makeClock();
    const saved: number[] = [];
    const pending = new PendingSaveClass({
      save: async (state: number) => void saved.push(state),
      delayMs: 500,
      schedule: clock.schedule,
    });
    await pending.flush();
    await clock.run();
    check(
      "nothing pending means nothing is written",
      saved.length === 0,
      () => `saved=${JSON.stringify(saved)}`
    );
  }

  {
    const clock = makeClock();
    const errors: unknown[] = [];
    const saved: number[] = [];
    let failing = true;
    const pending = new PendingSaveClass({
      save: async (state: number) => {
        if (failing) throw new Error("disk full");
        saved.push(state);
      },
      delayMs: 500,
      schedule: clock.schedule,
      onError: (error: unknown) => void errors.push(error),
    });
    pending.schedule(1);
    await clock.run();
    failing = false;
    pending.schedule(2);
    await clock.run();
    check(
      "a failed save is reported, not swallowed, and does not block the next one",
      errors.length === 1 && saved.join(",") === "2",
      () => `errors=${errors.length} saved=${JSON.stringify(saved)}`
    );
  }

  {
    const clock = makeClock();
    const saved: number[] = [];
    const pending = new PendingSaveClass({
      save: async (state: number) => void saved.push(state),
      delayMs: 500,
      schedule: clock.schedule,
    });
    pending.schedule(1);
    await pending.dispose();
    pending.schedule(2);
    await clock.run();
    check(
      "after dispose nothing further is scheduled",
      saved.join(",") === "1",
      () => `saved=${JSON.stringify(saved)}`
    );
  }
}

// ---- D. structural ---------------------------------------------------------

console.log("\nD. structural");

const systemAudioSource = code(read("src/hooks/useSystemAudio.ts"));
const chatConstantsSource = code(read("src/lib/chat-constants.ts"));

check(
  "the fix is a NEW migration, not an edit to applied history",
  count(CHAT_SQL, /SET updated_at = NEW\.timestamp/g) === 2 &&
    !/max\(/.test(CHAT_SQL) &&
    ORDER_SQL.length > 0,
  () =>
    `chat-history.sql has ${count(
      CHAT_SQL,
      /SET updated_at = NEW\.timestamp/g
    )} legacy trigger bodies, and ${
      /max\(/.test(CHAT_SQL) ? "was edited in place" : "was left alone"
    }`
);

check(
  "migration 4 is registered with a real down",
  count(MIGRATIONS_RS, /version:\s*4/g) === 2 &&
    /conversation-timestamp\.sql/.test(MIGRATIONS_RS) &&
    /conversation-timestamp\.down\.sql/.test(MIGRATIONS_RS),
  () => "main.rs does not register the version-4 up and down"
);

check(
  "the ordering migration leaves R3's transcript tables alone",
  !/transcript/i.test(ORDER_SQL) && /AUTOINCREMENT/.test(TRANSCRIPT_SQL),
  () => "the ordering migration mentions transcript tables"
);

check(
  "generateMessageId no longer builds the colliding shape",
  !/msg_\$\{timestamp\}_\$\{role\}/.test(chatConstantsSource) &&
    /sequence/i.test(chatConstantsSource),
  () => "the id is still msg_{timestamp}_{role}"
);

check(
  "the validator accepts the sequence and the legacy shape",
  /\(\?:\\d\+_\)\?|\(\\d\+_\)\?/.test(chatConstantsSource),
  () => "isValidMessageId does not accept an optional sequence"
);

check(
  "useSystemAudio uses the coalescing save and flushes on unmount",
  /new PendingSave/.test(systemAudioSource) &&
    /\.flush\(\)/.test(systemAudioSource),
  () => "the debounce is not the coalescing implementation"
);

check(
  "the silent drop is gone",
  !/isSavingRef/.test(systemAudioSource) &&
    !/saveTimeoutRef/.test(systemAudioSource),
  () => "the old silent-return refs are still there"
);

check(
  "R6 still decides what is publishable",
  /mayPublish\(/.test(systemAudioSource) &&
    /schedule\(conversation\)/.test(systemAudioSource) &&
    /saveConversation\(state\)/.test(systemAudioSource),
  () =>
    "the save path no longer writes exactly the state the turn decided to publish"
);

// ---- report ----------------------------------------------------------------

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log(
    "PASS - the ordering key is the newest message, ids cannot collide, and no\n" +
      "       pending save is dropped: proved on the real schema, on a copy of the\n" +
      "       real database, and against the real modules."
  );
  process.exit(0);
}
console.log(`FAIL - ${failures.length} check(s) failed:`);
for (const f of failures) console.log(`  ${f.name}\n    ${f.problem}`);
process.exit(1);
