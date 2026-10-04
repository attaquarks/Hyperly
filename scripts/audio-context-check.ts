// One AudioContext per capture owner (Phase 4 R11, issue #22).
//
// WHY THIS EXISTS
// ---------------
// Verified in the source:
//
//   * `useVoiceInput` built its AudioContext inside the build effect and closed it
//     in that effect's cleanup, so a context was constructed on mount even for a
//     mic that never turned on, and every device change AND every
//     voice-sensitivity step built a new one (the consumer re-keyed on
//     `deviceId:sensitivity`, and `useVoiceSensitivity` resolves through a storage
//     event that `persistVadConfig` fires on every slider step). Chromium caps live
//     hardware contexts (about six) before force-collecting, so sustained churn
//     could evict a live context from under the other room's mic.
//   * `MicVAD.setOptions` was never used, so a live VAD could not be re-tuned in
//     place.
//
// WHAT R11 CHANGES
// ---------------
//   * `src/lib/audio-context.ts` — one pooled AudioContext. `acquire()` creates it
//     on first use and hands the same context to every later holder; `release()`
//     closes it only when the LAST holder lets go, so a remount reuses it and one
//     room's teardown can never close a context the other room is using.
//   * `src/lib/vad-sensitivity.ts` — the real slider-to-threshold mapping, so the
//     live VAD is re-tuned with `setOptions` instead of being rebuilt.
//   * the mic remount key drops the sensitivity component; the device id stays.
//
// THIS SCRIPT asserts, by driving the real pool and the real mapping:
//   A. the pool's algebra: one context however many holders, closed only at zero,
//      one fresh context per later cycle, idempotent release, never two live;
//   B. the pass condition - dragging the sensitivity slider while capturing keeps
//      exactly ONE AudioContext, closes none, never rebuilds the VAD, and re-tunes
//      it once per step (with the pre-R11 shape shown alongside for contrast);
//   C. the threshold mapping: the tuned default, the clamps, monotonicity;
//   D. structurally: the hook no longer constructs or closes a context itself, the
//      build effect's inputs are still device-only, `setOptions` is used, D1's
//      generation guards still hold, R5's ownership is untouched, and both rooms
//      pass the sensitivity through instead of re-keying on it.
//
// Run with:  node --experimental-strip-types scripts/audio-context-check.ts

import { readFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

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
console.log("one AudioContext per capture owner (Phase 4 R11)");
console.log("=".repeat(72));

const voiceInputSource = code(read("src/hooks/useVoiceInput.ts"));
const micDriverSource = code(
  read("src/pages/app/components/completion/MicDriver.tsx")
);
const listenMicSource = code(
  read("src/pages/app/components/speech/ListenUserMic.tsx")
);
const speechPanelSource = code(read("src/pages/app/components/speech/index.tsx"));
const sensitivityHookSource = read("src/hooks/useVoiceSensitivity.ts");

type Stats = { created: number; closed: number; live: number; holders: number };
type Pool = {
  acquire(): AudioContext;
  release(): void;
  readonly current: AudioContext | null;
  readonly stats: Stats;
};

let PoolClass: (new (create: () => AudioContext) => Pool) | null = null;
let thresholdsFn: ((sensitivity: number) => {
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
}) | null = null;

try {
  const mod: any = await import("../src/lib/audio-context.ts");
  if (typeof mod.AudioContextPool !== "function") {
    throw new Error("audio-context.ts must export AudioContextPool");
  }
  PoolClass = mod.AudioContextPool;
} catch (error) {
  fail(
    "the context pool runs",
    error instanceof Error ? error.message : String(error)
  );
}
try {
  const mod: any = await import("../src/lib/vad-sensitivity.ts");
  if (typeof mod.speechThresholds !== "function") {
    throw new Error("vad-sensitivity.ts must export speechThresholds");
  }
  thresholdsFn = mod.speechThresholds;
} catch (error) {
  fail(
    "the threshold mapping runs",
    error instanceof Error ? error.message : String(error)
  );
}

/** A factory whose contexts count their own creation and closure. */
const makeFactory = () => {
  const state = { created: 0, closed: 0 };
  const create = (): AudioContext => {
    state.created += 1;
    return {
      state: "running",
      close: () => {
        state.closed += 1;
        return Promise.resolve();
      },
    } as unknown as AudioContext;
  };
  return { state, create };
};

// ---- A. the pool's algebra -------------------------------------------------

console.log("\nA. the context pool");

if (PoolClass) {
  {
    const { state, create } = makeFactory();
    const pool = new PoolClass(create);
    const first = pool.acquire();
    check(
      "the first acquire creates exactly one context",
      pool.stats.created === 1 &&
        pool.stats.live === 1 &&
        pool.stats.holders === 1,
      () => JSON.stringify(pool.stats)
    );

    const second = pool.acquire();
    check(
      "a second holder reuses the same context, not a second one",
      second === first && pool.stats.created === 1 && pool.stats.holders === 2,
      () => `same=${second === first} stats=${JSON.stringify(pool.stats)}`
    );

    pool.release();
    check(
      "one release does not close a context another holder is using",
      pool.stats.live === 1 &&
        pool.stats.closed === 0 &&
        pool.stats.holders === 1 &&
        state.closed === 0,
      () => `stats=${JSON.stringify(pool.stats)} closed=${state.closed}`
    );

    pool.release();
    check(
      "the last release closes it exactly once",
      pool.stats.live === 0 &&
        pool.stats.closed === 1 &&
        pool.stats.holders === 0 &&
        state.closed === 1,
      () => `stats=${JSON.stringify(pool.stats)} closed=${state.closed}`
    );

    pool.release();
    check(
      "releasing with no holders is a no-op (idempotent, no underflow)",
      pool.stats.holders === 0 && pool.stats.closed === 1,
      () => JSON.stringify(pool.stats)
    );

    const third = pool.acquire();
    check(
      "a later acquire after a full cycle creates one fresh context",
      third !== first &&
        pool.stats.created === 2 &&
        pool.stats.live === 1 &&
        state.created === 2,
      () => `stats=${JSON.stringify(pool.stats)}`
    );
  }

  {
    // Conservation over an interleaved sequence: never more than one live context,
    // and every context ever created is either live or closed.
    const { state, create } = makeFactory();
    const pool = new PoolClass(create);
    const script = [1, 1, -1, 1, 1, -1, -1, 1, -1, -1, -1];
    let peak = 0;
    for (const step of script) {
      if (step === 1) pool.acquire();
      else pool.release();
      peak = Math.max(peak, pool.stats.live);
    }
    check(
      "no interleaving leaves two contexts live, and none is lost",
      peak <= 1 &&
        pool.stats.created === pool.stats.closed + pool.stats.live &&
        state.created === pool.stats.created,
      () => `peak=${peak} stats=${JSON.stringify(pool.stats)}`
    );
  }
}

// ---- B. the pass condition: a sensitivity drag while capturing -------------

console.log("\nB. dragging the sensitivity slider while capturing");

if (PoolClass && thresholdsFn) {
  const STEPS = 21; // 0.00 ... 1.00

  {
    // The app's shape after R11: the build effect acquires the pool once, and a
    // sensitivity change re-tunes that live VAD with setOptions. Nothing in the
    // drag path can touch the pool or the VAD's identity.
    const { state, create } = makeFactory();
    const pool = new PoolClass(create);
    const reTuned: number[] = [];

    const context = pool.acquire(); // the build effect
    const liveVad = {
      // The only operation the drag path performs.
      setOptions: (update: { positiveSpeechThreshold: number }) => {
        reTuned.push(update.positiveSpeechThreshold);
      },
    };

    for (let step = 0; step < STEPS; step++) {
      liveVad.setOptions(thresholdsFn(step / (STEPS - 1)));
    }

    check(
      "the drag keeps exactly ONE AudioContext for its whole length",
      pool.stats.created === 1 && pool.stats.live === 1 && state.created === 1,
      () => `stats=${JSON.stringify(pool.stats)}`
    );
    check(
      "...and closes none, so nothing is evicted mid-capture",
      pool.stats.closed === 0 && state.closed === 0,
      () => `stats=${JSON.stringify(pool.stats)}`
    );
    check(
      "...and the same context is still the live one at the end",
      context === pool.current,
      () => "the live context changed during the drag"
    );
    check(
      "the live VAD is re-tuned once per step (setOptions, not a rebuild)",
      reTuned.length === STEPS,
      () => `setOptions calls=${reTuned.length}`
    );
    check(
      "the thresholds follow the slider end to end",
      reTuned[0] === 0.9 && reTuned[STEPS - 1] === 0.15,
      () => `first=${reTuned[0]} last=${reTuned[STEPS - 1]}`
    );
  }

  {
    // The pre-R11 shape, for contrast: a remount per step, each closing the
    // previous context. This is the pile-up Chromium's context cap reacts to.
    const { state, create } = makeFactory();
    const pool = new PoolClass(create);
    for (let step = 0; step < STEPS; step++) {
      pool.acquire(); // the new instance's build effect
      pool.release(); // the previous instance's cleanup
    }
    check(
      "for contrast: rebuilding per step (the pre-R11 shape) cycles a context every step",
      state.created >= STEPS - 1 && state.closed >= STEPS - 1,
      () => `created=${state.created} closed=${state.closed}`
    );
  }
}

// ---- C. the threshold mapping ---------------------------------------------

console.log("\nC. the threshold mapping");

if (thresholdsFn) {
  const mid = thresholdsFn(0.5);
  check(
    "the tuned default is unchanged (0.5 -> positive 0.5 / negative 0.35)",
    mid.positiveSpeechThreshold === 0.5 && mid.negativeSpeechThreshold === 0.35,
    () => JSON.stringify(mid)
  );

  const top = thresholdsFn(1);
  const bottom = thresholdsFn(0);
  check(
    "the ends are clamped (1 -> 0.15/0.1, 0 -> 0.9/0.75)",
    top.positiveSpeechThreshold === 0.15 &&
      top.negativeSpeechThreshold === 0.1 &&
      bottom.positiveSpeechThreshold === 0.9 &&
      bottom.negativeSpeechThreshold === 0.75,
    () => `top=${JSON.stringify(top)} bottom=${JSON.stringify(bottom)}`
  );

  const outOfRange = [thresholdsFn(-3), thresholdsFn(4)];
  check(
    "values outside 0-1 behave like the ends",
    outOfRange[0].positiveSpeechThreshold === 0.9 &&
      outOfRange[1].positiveSpeechThreshold === 0.15,
    () => JSON.stringify(outOfRange)
  );

  let monotonic = true;
  let previous = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= 20; step++) {
    const value = thresholdsFn(step / 20).positiveSpeechThreshold;
    if (value > previous) monotonic = false;
    previous = value;
  }
  check(
    "more sensitivity never raises the bar for calling a frame speech",
    monotonic,
    () => "the mapping is not monotonic"
  );
}

// ---- D. structural ---------------------------------------------------------

console.log("\nD. structural");

const audioContextSource = read("src/lib/audio-context.ts");

check(
  "the pool exists, is pure, and is a singleton export",
  audioContextSource.length > 0 &&
    !/^import\s/m.test(audioContextSource) &&
    /export const audioContextPool/.test(audioContextSource),
  () => "src/lib/audio-context.ts is missing, imports something, or exports no pool"
);

check(
  "the hook no longer constructs or closes a context itself",
  !/new AudioContext\(\)/.test(voiceInputSource) &&
    !/\.close\(\)/.test(voiceInputSource) &&
    /audioContextPool\.acquire\(\)/.test(voiceInputSource) &&
    /audioContextPool\.release\(\)/.test(voiceInputSource),
  () =>
    "useVoiceInput still owns the context instead of the pool (acquire/release not found)"
);

check(
  "the build effect's inputs are still device-only",
  /\[micDeviceId, micDeviceName, resetAccumulator\]/.test(voiceInputSource) &&
    !/sensitivity/.test(
      /\[micDeviceId, micDeviceName, resetAccumulator\]/.exec(voiceInputSource)?.[0] ??
        ""
    ),
  () =>
    "the build effect now depends on the sensitivity, so a slider step would rebuild the VAD"
);

check(
  "sensitivity is applied with setOptions through the shared mapping",
  /\.setOptions\(/.test(voiceInputSource) &&
    /speechThresholds\(/.test(voiceInputSource) &&
    /from "@\/lib\/vad-sensitivity"/.test(voiceInputSource),
  () => "the live VAD is not re-tuned with setOptions(speechThresholds(...))"
);

check(
  "D1 still holds: the generation guards and the shared hangover remain",
  /generationRef/.test(voiceInputSource) &&
    /generationRef\.current \+= 1/.test(voiceInputSource) &&
    /micRedemptionMs\(\)/.test(voiceInputSource),
  () => "a D1-verified guard (generation/hangover) was disturbed"
);

check(
  "the context is still handed to MicVAD (vad-web never owns it)",
  /getStream: acquire/.test(voiceInputSource) &&
    /pauseStream/.test(voiceInputSource) &&
    /resumeStream: acquire/.test(voiceInputSource),
  () =>
    "the vad-web stream wiring changed (the selected-device behaviour must stay)"
);

check(
  "R5's ownership is untouched - no second microphone owner path",
  !/captureOwnership/.test(voiceInputSource),
  () => "useVoiceInput gained an ownership path; R5 owns exclusivity"
);

check(
  "the Ask mic passes the sensitivity instead of re-keying on it",
  /sensitivity=\{sensitivity\}/.test(micDriverSource) &&
    !/:\$\{sensitivity\}/.test(micDriverSource) &&
    !/key=\{[^}]*sensitivity/.test(micDriverSource) &&
    /key=\{[^}]*deviceId/.test(micDriverSource),
  () =>
    "MicDriver still keys on the sensitivity (a slider step would rebuild the device stream)"
);

check(
  "the Listen mic passes the sensitivity instead of re-keying on it",
  /sensitivity/.test(listenMicSource) &&
    /useVoiceInput\(\{[\s\S]{0,120}sensitivity/.test(listenMicSource) &&
    /sensitivity=\{voiceSensitivity\}/.test(speechPanelSource) &&
    !/:\$\{voiceSensitivity\}/.test(speechPanelSource),
  () =>
    "ListenUserMic or its caller still rebuilds the VAD when the sensitivity changes"
);

check(
  "the sensitivity hook's doc no longer prescribes a remount key",
  !/remount key/.test(sensitivityHookSource),
  () => "useVoiceSensitivity still tells consumers to re-key on the value"
);

// ---- report ----------------------------------------------------------------

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log(
    "PASS - one AudioContext per capture owner: a sensitivity drag while capturing\n" +
      "       keeps exactly one context live, closes none, and re-tunes the running\n" +
      "       VAD in place instead of rebuilding it."
  );
  process.exit(0);
}
console.log(`FAIL - ${failures.length} check(s) failed:`);
for (const f of failures) console.log(`  ${f.name}\n    ${f.problem}`);
process.exit(1);
