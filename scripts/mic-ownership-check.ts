// One capture owner at a time (Phase 4 R5, issue #18).
//
// WHY THIS EXISTS
// ---------------
// Phase 2A §C2 (lines 372-393) proved two simultaneous getUserMedia + STT
// pipelines are reachable, and R5 is that finding. Verified in the source:
//
//   * both overlay panels stay MOUNTED in every mode (`app/index.tsx` hides the
//     inactive one with CSS), and `completion/index.tsx:31` renders
//     `<MicDriver {...completion} />` unconditionally, so the Ask mic exists
//     while Listen is on screen;
//   * the Ask↔Listen coordination is a RISING-EDGE-only effect
//     (`useCompletion.ts` — `capturing && !prevCapturingRef.current`), so once a
//     Listen capture is running the guard is latched and cannot fire again;
//   * the global Voice Input shortcut is delivered TWICE for one press
//     (`useCompletion.ts` direct `listen("start-audio-recording")` plus
//     `registerAudioCallback(toggleRecording)` via `useGlobalShortcuts.ts`),
//     and neither path is scoped to a panel or to the capture state.
//
// Path 1 (the reported bug): Listen is capturing → press the global shortcut →
// the Ask mic starts too. Two getUserMedia streams, two AudioContexts, two STT
// pipelines, one of them hidden behind the CSS-hidden panel.
//
// WHAT R5 CHANGES
// ---------------
// One owner token (`src/lib/capture-owner.ts`). Every activation of a capture
// REQUESTS ownership; while another source owns it, the request is refused, so
// the second pipeline cannot start. The token is identity-checked and
// idempotent: re-requesting while holding returns the same token, releasing
// twice is a no-op, and a stale token can never release a newer owner — a token
// that can leak would be worse than no token at all.
//
// THIS SCRIPT asserts, by driving the real module and the real predicate:
//   A. the reported sequence keeps exactly one owner (Listen only), the refusal
//      changes no state, and a refused press cannot resurface later;
//   B. lifecycle: press-then-press releases (no leak); a system capture preempts
//      the mic; the mic stays off after the capture stops (the documented
//      product rule); unmount releases; a stale token cannot free a newer owner;
//      a same-source re-request does not pile up tokens;
//   C. the <=1 invariant survives every interleaving of the real actions;
//   D. structurally: the duplicate shortcut delivery is gone, the Ask VAD drive
//      is gated on ownership, Listen takes and releases the token, and C1
//      (panel-scoped Space in AskPushToTalkKey) is untouched.
//
// Run with:  node --experimental-strip-types scripts/mic-ownership-check.ts

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
console.log("capture ownership - exactly one microphone at a time (Phase 4 R5)");
console.log("=".repeat(72));

const ownerSource = read("src/lib/capture-owner.ts");
const completionSource = code(read("src/hooks/useCompletion.ts"));
const systemAudioSource = code(read("src/hooks/useSystemAudio.ts"));
const completionPanel = code(
  read("src/pages/app/components/completion/index.tsx")
);
const pushToTalkKey = code(
  read("src/pages/app/components/completion/AskPushToTalkKey.tsx")
);

// ---- D. structural: the wiring that makes the behaviour reachable -----------

console.log("\nD. structural wiring");

check(
  "the ownership module exists and is pure",
  ownerSource.length > 0 && !/^import\s/m.test(ownerSource),
  () => "src/lib/capture-owner.ts is missing, or it imports something"
);
check(
  "it exports the token API and the single mic predicate",
  /export class CaptureOwnership/.test(ownerSource) &&
    /export const captureOwnership/.test(ownerSource) &&
    /export const mayMicrophoneRun/.test(ownerSource) &&
    /export type CaptureSource/.test(ownerSource) &&
    /export interface CaptureToken/.test(ownerSource),
  () => "capture-owner.ts is missing part of the ownership API"
);
check(
  "it names both capture sources",
  /"microphone"/.test(ownerSource) && /"system"/.test(ownerSource),
  () => "the microphone/system sources are not both declared"
);
check(
  "the shortcut is delivered once, not twice",
  !/listen\(\s*"start-audio-recording"/.test(completionSource),
  () =>
    "useCompletion still listens for start-audio-recording directly, so one press fires two handlers (P2A C2)"
);
check(
  "the Ask mic requests ownership, and releases it",
  /captureOwnership\.request\(\s*"microphone"\s*\)/.test(completionSource) &&
    /captureOwnership\.release\(/.test(completionSource),
  () => "useCompletion does not request/release the microphone token"
);
check(
  "the Ask VAD drive is gated on the token",
  /enableVAD:\s*mayMicrophoneRun\(/.test(completionSource),
  () => "the returned enableVAD is not gated by mayMicrophoneRun()"
);
check(
  "the system capture takes and releases the token",
  /captureOwnership\.take\(\s*"system"\s*\)/.test(systemAudioSource) &&
    /captureOwnership\.release\(/.test(systemAudioSource),
  () => "useSystemAudio does not take/release the system token on its capture edge"
);
check(
  "the rising-edge pause of the Ask mic remains",
  /capturing\s*&&\s*!prevCapturingRef\.current/.test(completionSource),
  () => "the Ask to Listen rising-edge coordination was removed"
);
check(
  "C1 is untouched: Space stays scoped to the visible Ask panel",
  /active=\{!isHidden\}/.test(completionPanel) &&
    /if\s*\(!active\)\s*return;/.test(pushToTalkKey) &&
    !/captureOwnership/.test(pushToTalkKey),
  () =>
    "AskPushToTalkKey's panel-level Space scoping changed (C1 was verified clean - do not touch it)"
);

// ---- A/B/C. behaviour: count the capture owners -----------------------------

type CaptureSource = "microphone" | "system";
type CaptureToken = { readonly source: CaptureSource; readonly id: number };
type Ownership = {
  readonly owner: CaptureSource | null;
  readonly activeCount: number;
  readonly token: CaptureToken | null;
  isHeldBy(source: CaptureSource): boolean;
  request(source: CaptureSource): CaptureToken | null;
  take(source: CaptureSource): CaptureToken;
  release(token: CaptureToken | null | undefined): void;
};
type OwnershipCtor = new () => Ownership;

let OwnershipClass: OwnershipCtor | null = null;
let mayMicrophoneRun: ((intent: boolean, ownership: Ownership) => boolean) | null =
  null;
let DecideAskMic: ((ownership: Ownership) => "start" | "refuse") | null = null;
let ReportClass: (new () => Ownership & {
  reportSystemCapture(detail: { capturing: boolean; micWithSystem: boolean }): void;
}) | null = null;

try {
  const mod: any = await import("../src/lib/capture-owner.ts");
  if (
    typeof mod.CaptureOwnership !== "function" ||
    typeof mod.mayMicrophoneRun !== "function" ||
    typeof mod.decideAskMic !== "function" ||
    typeof mod.CaptureOwnership.prototype.reportSystemCapture !== "function"
  ) {
    throw new Error(
      "capture-owner.ts must export CaptureOwnership (with reportSystemCapture), mayMicrophoneRun and decideAskMic"
    );
  }
  OwnershipClass = mod.CaptureOwnership;
  mayMicrophoneRun = mod.mayMicrophoneRun;
  DecideAskMic = mod.decideAskMic;
  ReportClass = mod.CaptureOwnership;
} catch (error) {
  fail(
    "the ownership module runs",
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * The guard's model of the app. Each method is one action the real hooks take,
 * so a sequence here is the production sequence rather than an invented one:
 *
 *   shortcut()    useCompletion's global-shortcut handler
 *   space()       AskPushToTalkKey -> setEnableVAD(prev => !prev)
 *   askPauses()   the rising-edge effect that pauses the mic for a capture
 *   listenStart() / listenStop()   useSystemAudio's `capturing` edge
 *   unmountMic()  useCompletion's unmount cleanup
 *
 * `runningOwners()` counts how many capture pipelines the app would actually
 * run: the Ask mic only when the production predicate allows it, plus the
 * Listen capture. Anything above 1 is the defect this item exists to prevent.
 */
const makeApp = () => {
  if (!OwnershipClass || !mayMicrophoneRun) {
    throw new Error("the ownership module did not load");
  }
  const predicate = mayMicrophoneRun;
  const ownership = new OwnershipClass();
  let micIntent = false;
  let micToken: CaptureToken | null = null;
  let systemToken: CaptureToken | null = null;
  let refusals = 0;

  /** The reconcile step: the intent is granted, or it is refused and undone. */
  const setMic = (on: boolean): boolean => {
    micIntent = on;
    if (on) {
      const token = ownership.request("microphone");
      if (!token) {
        // Refused. The intent is dropped, not parked: a refused press must not
        // start a mic later, when the other owner lets go.
        refusals += 1;
        micIntent = false;
        micToken = null;
        return false;
      }
      micToken = token;
      return true;
    }
    ownership.release(micToken);
    micToken = null;
    return false;
  };

  return {
    ownership,
    shortcut: () => setMic(!micIntent),
    space: () => setMic(!micIntent),
    askPauses: () => setMic(false),
    listenStart: () => {
      systemToken = ownership.take("system");
    },
    listenStop: () => {
      ownership.release(systemToken);
      systemToken = null;
    },
    unmountMic: () => {
      ownership.release(micToken);
      micToken = null;
      micIntent = false;
    },
    runningOwners: () =>
      (predicate(micIntent, ownership) ? 1 : 0) + (systemToken !== null ? 1 : 0),
    get micIntent() {
      return micIntent;
    },
    get refusals() {
      return refusals;
    },
  };
};
type App = ReturnType<typeof makeApp>;

console.log("\nA. the reported sequence: Listen is capturing, press the shortcut");

if (OwnershipClass) {
  const app = makeApp();
  app.listenStart();
  check(
    "with Listen capturing, exactly one capture owner is active",
    app.runningOwners() === 1 && app.ownership.owner === "system",
    () => `running=${app.runningOwners()} owner=${app.ownership.owner}`
  );

  app.shortcut();
  check(
    "pressing the global shortcut leaves EXACTLY ONE microphone active (the pass condition)",
    app.runningOwners() === 1 && app.ownership.owner === "system",
    () => `running=${app.runningOwners()} owner=${app.ownership.owner}`
  );
  check(
    "the refused press did not start the Ask mic",
    app.micIntent === false && !mayMicrophoneRun!(true, app.ownership),
    () =>
      `micIntent=${app.micIntent} micWouldRun=${mayMicrophoneRun!(
        true,
        app.ownership
      )}`
  );
  check(
    "the refusal is explicit, not silent-by-accident",
    app.refusals === 1,
    () => `refusals=${app.refusals}`
  );

  app.shortcut();
  check(
    "a second quick press during the capture is refused as well",
    app.runningOwners() === 1 &&
      app.ownership.owner === "system" &&
      app.refusals === 2,
    () =>
      `running=${app.runningOwners()} owner=${app.ownership.owner} refusals=${app.refusals}`
  );

  app.listenStop();
  check(
    "when the Listen capture stops, nothing is left running",
    app.runningOwners() === 0 && app.ownership.owner === null,
    () => `running=${app.runningOwners()} owner=${app.ownership.owner}`
  );
  check(
    "the refused press cannot resurface: the mic did not start when the token freed",
    app.micIntent === false && app.runningOwners() === 0,
    () => `micIntent=${app.micIntent} running=${app.runningOwners()}`
  );

  app.shortcut();
  check(
    "a press after the capture ends starts exactly one mic",
    app.runningOwners() === 1 && app.ownership.owner === "microphone",
    () => `running=${app.runningOwners()} owner=${app.ownership.owner}`
  );

  app.shortcut();
  check(
    "pressing again releases it - the token is not leaked",
    app.runningOwners() === 0 && app.ownership.owner === null,
    () => `running=${app.runningOwners()} owner=${app.ownership.owner}`
  );
}

// ---- B. lifecycle: the owner token must not leak ---------------------------

// ---- B2. D4 recovery: a fresh Ask request must succeed the moment Listen's
// token is released. The suspected mechanism is a STALE preempted Ask token
// (Listen's `take` minted a new one; a later re-acquire was refused against
// a token Listen had already released) - the symptom being a mic that
// ignores every activation and then starts on its own later.
//
// NOTE (D4 cause unconfirmed): both scenarios below PASS against the real
// state machine on main, so the token layer already recovers cleanly and no
// production change is made here. The app-level stuck mic was never
// reproduced in this layer - it needs manual runtime confirmation across a
// Listen->Ask cycle (see the commit message), not another token tweak.

console.log("\nB2. recovery after Listen stops (D4)");

if (OwnershipClass) {
  {
    // Ask owned the token first, Listen preempted it, the stale Ask token
    // could not free the system owner, then Listen stopped and released.
    const ownership = new OwnershipClass();
    const askFirst = ownership.request("microphone");
    const system = ownership.take("system");
    ownership.release(askFirst);
    ownership.release(system);
    const freed = ownership.owner === null && ownership.activeCount === 0;
    const retry = ownership.request("microphone");
    check(
      "preempted Ask token: after Listen stops and releases, a fresh Ask request succeeds immediately",
      freed && retry !== null && ownership.owner === "microphone",
      () =>
        `freed=${freed} retry=${retry === null ? "null (REFUSED - stuck mic)" : "ok"} owner=${ownership.owner}`
    );
  }

  {
    // Ask only pressed DURING the capture (refused, intent off), then Listen
    // stopped. Same bar: the next press must succeed immediately.
    const ownership = new OwnershipClass();
    const system = ownership.take("system");
    const refused = ownership.request("microphone");
    ownership.release(system);
    const retry = ownership.request("microphone");
    check(
      "press-during-capture: after Listen stops, the next press succeeds immediately",
      refused === null && retry !== null && ownership.owner === "microphone",
      () =>
        `refused=${refused === null} retry=${retry === null ? "null (REFUSED - stuck mic)" : "ok"} owner=${ownership.owner}`
    );
  }
}

console.log("\nB. lifecycle");

if (OwnershipClass) {
  {
    // Two quick presses with no capture: on, then off. Net zero, nothing held.
    const app = makeApp();
    app.shortcut();
    app.shortcut();
    check(
      "two quick presses with no capture leave no owner behind",
      app.ownership.owner === null && app.runningOwners() === 0,
      () => `owner=${app.ownership.owner} running=${app.runningOwners()}`
    );
    app.shortcut();
    check(
      "and a third press still starts the mic (no stale token blocks it)",
      app.runningOwners() === 1 && app.ownership.owner === "microphone",
      () => `owner=${app.ownership.owner} running=${app.runningOwners()}`
    );
  }

  {
    // The mic is on, then a Listen capture starts: the system preempts it, and
    // the Ask side's late release of its now-stale token must do nothing.
    const app = makeApp();
    app.shortcut();
    check(
      "the Ask mic holds the token before the capture starts",
      app.ownership.owner === "microphone" && app.runningOwners() === 1,
      () => `owner=${app.ownership.owner}`
    );
    app.listenStart();
    app.askPauses();
    check(
      "a starting capture preempts the mic - still exactly one owner",
      app.runningOwners() === 1 && app.ownership.owner === "system",
      () => `running=${app.runningOwners()} owner=${app.ownership.owner}`
    );
    check(
      "the preempted mic token cannot release the system owner",
      app.ownership.owner === "system",
      () => `owner=${app.ownership.owner}`
    );
    app.listenStop();
    check(
      "after the capture stops the mic stays off (the documented product rule)",
      app.micIntent === false &&
        app.runningOwners() === 0 &&
        app.ownership.owner === null,
      () =>
        `micIntent=${app.micIntent} running=${app.runningOwners()} owner=${app.ownership.owner}`
    );
  }

  {
    // Token identity: an old activation's late cleanup must never free a newer
    // owner's token.
    const app = makeApp();
    const stale = app.ownership.request("microphone")!;
    app.listenStart();
    app.listenStop();
    const fresh = app.ownership.request("microphone")!;
    app.ownership.release(stale);
    check(
      "a stale token cannot release a newer owner",
      app.ownership.owner === "microphone" && app.ownership.token === fresh,
      () => `owner=${app.ownership.owner}`
    );
    app.ownership.release(fresh);
    check(
      "the rightful token still releases normally",
      app.ownership.owner === null,
      () => `owner=${app.ownership.owner}`
    );
  }

  {
    // Re-requesting while already holding must not pile up tokens, and a double
    // release must be harmless.
    const app = makeApp();
    const first = app.ownership.request("microphone")!;
    const second = app.ownership.request("microphone")!;
    check(
      "re-requesting while holding returns the same token (no pile-up)",
      first === second && app.ownership.activeCount === 1,
      () => `same=${first === second} activeCount=${app.ownership.activeCount}`
    );
    app.ownership.release(first);
    app.ownership.release(first);
    check(
      "releasing twice is a no-op",
      app.ownership.owner === null && app.ownership.activeCount === 0,
      () =>
        `owner=${app.ownership.owner} activeCount=${app.ownership.activeCount}`
    );
  }

  {
    // The Ask room unmounts while its mic is on (tab teardown, window close).
    const app = makeApp();
    app.shortcut();
    app.unmountMic();
    check(
      "unmounting the Ask room releases its token",
      app.ownership.owner === null && app.runningOwners() === 0,
      () => `owner=${app.ownership.owner} running=${app.runningOwners()}`
    );
  }

  {
    // The panel Space key is a second activation path (C1's, untouched). It must
    // be covered by the same token without any code in AskPushToTalkKey.
    const app = makeApp();
    app.listenStart();
    app.space();
    check(
      "Space during a capture is refused by the same token (C1 file untouched)",
      app.runningOwners() === 1 &&
        app.ownership.owner === "system" &&
        app.refusals === 1,
      () =>
        `running=${app.runningOwners()} owner=${app.ownership.owner} refusals=${app.refusals}`
    );
  }
}

// ---- C. the invariant holds for every interleaving -------------------------

console.log("\nC. every interleaving of the real actions");

if (OwnershipClass) {
  const actions: Array<[string, (app: App) => void]> = [
    ["shortcut", (app) => app.shortcut()],
    ["space", (app) => app.space()],
    ["listen-start", (app) => app.listenStart()],
    ["listen-stop", (app) => app.listenStop()],
  ];
  const DEPTH = 4;
  let sequences = 0;
  let violations = 0;
  const walk = (left: number, run: Array<(app: App) => void>) => {
    if (left === 0) {
      sequences += 1;
      const app = makeApp();
      for (const action of run) {
        action(app);
        if (app.runningOwners() > 1 || app.ownership.activeCount > 1) {
          violations += 1;
          return;
        }
      }
      return;
    }
    for (const [, action] of actions) walk(left - 1, [...run, action]);
  };
  walk(DEPTH, []);
  check(
    `the <=1 owner invariant holds for all ${sequences} interleavings of length ${DEPTH}`,
    violations === 0,
    () => `${violations} interleaving(s) ran more than one capture owner`
  );
}

// ---- E. D3+D8: the shortcut press decides from the reported shape ---------

console.log("\nE. Ctrl+Shift+A decides from the reported capture shape");

if (DecideAskMic && ReportClass) {
  const shape = (
    capturing: boolean,
    micWithSystem: boolean
  ): InstanceType<typeof ReportClass> => {
    // A fresh registry per shape, as the unit tests do for the state machine.
    const ownership = new ReportClass();
    ownership.reportSystemCapture({ capturing, micWithSystem });
    return ownership;
  };

  check(
    "idle: the shortcut starts the mic",
    DecideAskMic(shape(false, false)) === "start",
    () => `got ${DecideAskMic(shape(false, false))}`
  );
  check(
    "system-only capture: the shortcut starts the mic normally",
    DecideAskMic(shape(true, false)) === "start",
    () => `got ${DecideAskMic(shape(true, false))}`
  );
  check(
    "mic+system capture: the shortcut refuses instead of silently no-op'ing",
    DecideAskMic(shape(true, true)) === "refuse",
    () => `got ${DecideAskMic(shape(true, true))}`
  );
  check(
    "a stale report (mic toggle off without capture) still starts",
    DecideAskMic(shape(false, true)) === "start",
    () => `got ${DecideAskMic(shape(false, true))}`
  );

  const idle = shape(false, false);
  check(
    "the visible refusal text exists at the Ask call site",
    /Microphone already in use by the Listen capture/.test(completionSource),
    () => "toggleRecording sets no user-visible refusal"
  );
  check(
    "the refusal returns before touching intent or the running capture",
    /decideAskMic\(\) === "refuse"[\s\S]{0,400}?return;/.test(
      completionSource
    ) && !/decideAskMic[\s\S]{0,400}?stop_/.test(completionSource),
    () => "the refuse path does not return early"
  );
  check(
    "Listen reports its live capture shape to the registry",
    /reportSystemCapture\(\{ capturing, micWithSystem \}\)/.test(
      systemAudioSource
    ),
    () => "useSystemAudio never reports { capturing, micWithSystem }"
  );
  void idle;
}

// ---- report ----------------------------------------------------------------

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log(
    "PASS - one capture owner at a time: with Listen capturing, the global\n" +
      "       shortcut leaves exactly one microphone active, and the owner token\n" +
      "       cannot leak."
  );
  process.exit(0);
}
console.log(`FAIL - ${failures.length} check(s) failed:`);
for (const f of failures) console.log(`  ${f.name}\n    ${f.problem}`);
process.exit(1);
