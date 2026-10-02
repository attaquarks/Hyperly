// Durable speech-block queue: a transcription failure must never destroy audio.
//
// WHY THIS EXISTS
// ---------------
// Phase 4 R2 (issue #15). Both capture paths used to hand the audio straight to
// the provider and then forget it:
//   * mic   - `onSpeechEnd` cleared `framesRef` and awaited `transcribe()`;
//             any throw lost the utterance.
//   * room  - the `speech-detected` handler awaited `fetchSTT()` inside a
//             try/catch; the blob was dropped on error.
// Audio was therefore destroyed *before* its transcription outcome was known.
//
// `src/lib/speech-block-queue.ts` makes the block durable: enqueue -> transcribe
// -> on failure RETAIN the block and retry with capped exponential backoff ->
// after `maxAttempts` dead-letter it (audio kept, error surfaced). Never silent.
//
// THIS SCRIPT ENFORCES (fixtures, no real timers - the scheduler is injected)
//   1. success delivers once and empties the queue;
//   2. a forced failure retains the block and retries it, then delivers it;
//   3. permanent failure is dead-lettered after exactly maxAttempts, and the
//      dead-lettered block still carries its audio;
//   4. delivery order is enqueue order even when a retry intervenes;
//   5. a block that dead-letters does not prevent the next block from landing;
//   6. overflow is signalled explicitly - the newest block is rejected through
//      `onOverflow`, never dropped in silence;
//   7. backoff grows per attempt and is capped.
//
// Run with:  node scripts/speech-queue-check.ts

import { SpeechBlockQueue } from "../src/lib/speech-block-queue.ts";

type Failure = { name: string; problem: string };
const failures: Failure[] = [];
const fail = (name: string, problem: string) => failures.push({ name, problem });

// ---- fake clock: the queue's backoff is driven manually ---------------------

const makeScheduler = () => {
  const timers: Array<{ fn: () => void; delay: number }> = [];
  return {
    schedule: (fn: () => void, delay: number) => void timers.push({ fn, delay }),
    delays: () => timers.map((t) => t.delay),
    /** Run every pending timer, flushing microtasks between them. */
    async run(): Promise<void> {
      let guard = 0;
      while (timers.length > 0) {
        if (++guard > 100) throw new Error("scheduler did not settle");
        const next = timers.shift()!;
        next.fn();
        await flush();
      }
    },
    /** Run exactly one pending timer - needed to observe each backoff step. */
    async runOne(): Promise<void> {
      const next = timers.shift();
      if (!next) return;
      next.fn();
      await flush();
    },
  };
};

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

const makeQueue = <T>(options: {
  transcribe: (block: { audio: T; attempts: number }) => Promise<string>;
  onText: (text: string, block: any) => void | Promise<void>;
  onError?: (error: unknown, block: any) => void;
  onDeadLetter?: (block: any, error: unknown) => void;
  onOverflow?: (source: string) => void;
  maxAttempts?: number;
  maxQueueDepth?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}) => {
  const scheduler = makeScheduler();
  const queue = new SpeechBlockQueue<T>({
    ...options,
    schedule: scheduler.schedule,
  } as any);
  return { queue, scheduler };
};

// ---- 1. success -------------------------------------------------------------

{
  const delivered: string[] = [];
  const { queue, scheduler } = makeQueue<string>({
    transcribe: async () => "hello",
    onText: (text) => void delivered.push(text),
  });
  queue.enqueue("microphone", "audio-1");
  await flush();
  await scheduler.run();
  await queue.idle();
  if (delivered.length !== 1 || delivered[0] !== "hello" || queue.size !== 0) {
    fail("success", `delivered=${JSON.stringify(delivered)} size=${queue.size}`);
  } else {
    console.log("  ok    success: delivered once, queue empty");
  }
}

// ---- 2. a forced failure retains and retries the block ----------------------

{
  const delivered: string[] = [];
  let calls = 0;
  const { queue, scheduler } = makeQueue<string>({
    transcribe: async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider 500");
      return "recovered";
    },
    onText: (text) => void delivered.push(text),
  });
  queue.enqueue("system", "audio-2");
  await flush();
  await scheduler.run();
  await queue.idle();
  if (calls !== 2 || delivered.length !== 1 || delivered[0] !== "recovered") {
    fail("retry", `calls=${calls} delivered=${JSON.stringify(delivered)}`);
  } else {
    console.log("  ok    failure retains the block, one retry delivers it (attempts=2)");
  }
}

// ---- 3. permanent failure dead-letters the block, audio intact --------------

{
  const delivered: string[] = [];
  const errors: unknown[] = [];
  const dead: any[] = [];
  const { queue, scheduler } = makeQueue<string>({
    transcribe: async () => {
      throw new Error("provider down");
    },
    onText: (text) => void delivered.push(text),
    onError: (error) => void errors.push(error),
    onDeadLetter: (block) => void dead.push(block),
    maxAttempts: 3,
  });
  queue.enqueue("system", "audio-doomed");
  await flush();
  await scheduler.run();
  await queue.idle();
  const intact = dead.length === 1 && dead[0].audio === "audio-doomed";
  if (delivered.length !== 0 || errors.length !== 3 || !intact) {
    fail(
      "dead-letter",
      `delivered=${delivered.length} errors=${errors.length} dead=${dead.length} audio=${dead[0]?.audio}`
    );
  } else {
    console.log("  ok    permanent failure: 3 attempts, dead-lettered, audio kept, nothing delivered");
  }
}

// ---- 4. order is preserved when a retry intervenes --------------------------

{
  const delivered: string[] = [];
  let first = 0;
  const { queue, scheduler } = makeQueue<string>({
    transcribe: async (block: any) => {
      if (block.audio === "A") {
        first += 1;
        if (first === 1) throw new Error("transient");
        return "A";
      }
      return "B";
    },
    onText: (text) => void delivered.push(text),
  });
  queue.enqueue("microphone", "A");
  queue.enqueue("microphone", "B");
  await flush();
  await scheduler.run();
  await queue.idle();
  if (delivered.join(",") !== "A,B") {
    fail("ordering", `delivered=${JSON.stringify(delivered)} (expected A then B)`);
  } else {
    console.log("  ok    a retried block still lands before the next one (A,B)");
  }
}

// ---- 5. a dead-letter does not block the following block --------------------

{
  const delivered: string[] = [];
  const dead: any[] = [];
  const { queue, scheduler } = makeQueue<string>({
    transcribe: async (block: any) => {
      if (block.audio === "doomed") throw new Error("permanent");
      return "good";
    },
    onText: (text) => void delivered.push(text),
    onDeadLetter: (block) => void dead.push(block),
    maxAttempts: 2,
  });
  queue.enqueue("system", "doomed");
  queue.enqueue("system", "fine");
  await flush();
  await scheduler.run();
  await queue.idle();
  if (delivered.join(",") !== "good" || dead.length !== 1) {
    fail("isolation", `delivered=${JSON.stringify(delivered)} dead=${dead.length}`);
  } else {
    console.log("  ok    one dead block does not stop the next from landing");
  }
}

// ---- 6. overflow is explicit, never a silent drop --------------------------

{
  const delivered: string[] = [];
  const overflows: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { queue, scheduler } = makeQueue<string>({
    transcribe: async () => {
      await gate;
      return "ok";
    },
    onText: (text) => void delivered.push(text),
    onOverflow: (source) => void overflows.push(source),
    maxQueueDepth: 2,
  });
  const id1 = queue.enqueue("system", "one");
  queue.enqueue("system", "two");
  const rejected = queue.enqueue("system", "three");
  await flush();
  const held = queue.size;
  release?.();
  await flush();
  await scheduler.run();
  await queue.idle();
  if (id1 === null || rejected !== null || overflows.length !== 1 || held !== 2) {
    fail(
      "overflow",
      `id1=${id1} rejected=${rejected} overflows=${overflows.length} held=${held}`
    );
  } else {
    console.log("  ok    overflow signalled explicitly; the excess block is refused, not lost");
  }
}

// ---- 7. backoff grows and is capped ----------------------------------------

{
  const { queue, scheduler } = makeQueue<string>({
    transcribe: async () => {
      throw new Error("down");
    },
    onText: () => {},
    maxAttempts: 4,
    baseDelayMs: 100,
    maxDelayMs: 250,
  });
  queue.enqueue("system", "x");
  await flush();
  const seen: number[] = [];
  let guard = 0;
  while (scheduler.delays().length > 0) {
    if (++guard > 20) break;
    seen.push(scheduler.delays()[0]);
    await scheduler.runOne();
  }
  await queue.idle();
  if (seen.join(",") !== "100,200,250") {
    fail("backoff", `delays=${seen.join(",")} (expected 100,200,250)`);
  } else {
    console.log("  ok    backoff grows per attempt and is capped (100,200,250)");
  }
}

// ---- report ----------------------------------------------------------------

console.log("");
console.log("=".repeat(72));
if (failures.length === 0) {
  console.log("PASS - a speech block survives transcription failure and is never dropped silently.");
  process.exit(0);
}
console.log(`FAIL - ${failures.length} fixture(s) failed:`);
for (const f of failures) console.log(`  ${f.name}  ${f.problem}`);
process.exit(1);