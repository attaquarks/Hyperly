// Vestigial continuous mode is gone (Phase 4 cleanup).
//
// WHY THIS EXISTS
// ---------------
// Verified in the source before the cleanup:
//
//   * `useSystemAudio` held `isContinuousMode` and `isRecordingInContinuousMode`
//     state that was never set to `true` anywhere in the app, plus a
//     `recordingProgress` counter whose only reader was a `RecordingPanel`
//     component that nothing rendered. `startContinuousRecording` and
//     `ignoreContinuousRecording` were defined and exported but never called,
//     and `ignoreContinuousRecording` returned early on its own first line
//     (`if (!isContinuousMode || !capturing) return;`), so it could never do
//     anything. `RecordingPanel.tsx` itself had no importer.
//   * the Rust capture loop emitted `continuous-recording-start`,
//     `recording-progress` and `continuous-recording-stopped` once per capture;
//     after the frontend listeners above were the only consumers, nothing in the
//     app could observe any of the three.
//
// WHAT THE CLEANUP CHANGED
// ------------------------
//   * `useSystemAudio` lost the two dead states, the dead counter, the two dead
//     callbacks, the three listeners that fed them, and the dead panel file.
//   * `speaker/commands.rs` lost the three orphan emits only.
//   * everything that merely shared that code survived: the partial-transcript
//     branch (`speech-partial`, gated on the same one-second cadence), the
//     `manual-stop-continuous` listener that `manual_stop_continuous` drives, and
//     `start_system_audio_capture` / `stop_system_audio_capture`.
//
// THIS SCRIPT asserts, on the real tree:
//   A. the dead symbols, the dead panel and the removed events are gone from the
//      frontend (CODE, not comments - the comments deliberately name them);
//   B. the removed events have no emitter left on the Rust side;
//   C. the live paths that shared that code are still wired end to end;
//   D. the listener teardown in the hook matches the listeners it now creates.
//
// Run with:  node --experimental-strip-types scripts/dead-continuous-mode-check.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const readRel = (relPath: string): string => {
  try {
    return readFileSync(join(ROOT, relPath), "utf8");
  } catch {
    return "";
  }
};
const exists = (relPath: string): boolean => {
  try {
    return statSync(join(ROOT, relPath)).isFile();
  } catch {
    return false;
  }
};
/** Compare code, not prose: the comments legitimately quote the old names. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const walk = (relDir: string, ext: string): string => {
  const out: string[] = [];
  const visit = (rel: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(ROOT, rel));
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry}`;
      let isDir = false;
      try {
        isDir = statSync(join(ROOT, child)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) visit(child);
      else if (child.endsWith(ext)) out.push(readRel(child));
    }
  };
  visit(relDir);
  return out.join("\n");
};

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
console.log("vestigial continuous mode is gone (Phase 4 cleanup)");
console.log("=".repeat(72));

const hook = readRel("src/hooks/useSystemAudio.ts");
const hookCode = code(hook);
const speechPanel = readRel("src/pages/app/components/speech/index.tsx");
const completionPanel = readRel(
  "src/pages/app/components/completion/index.tsx"
);
const rust = code(walk("src-tauri/src", ".rs"));

// ---- A. the dead frontend surface is gone ----------------------------------

const deadSymbols = [
  "isContinuousMode",
  "setIsContinuousMode",
  "isRecordingInContinuousMode",
  "setIsRecordingInContinuousMode",
  "recordingProgress",
  "setRecordingProgress",
  "startContinuousRecording",
  "ignoreContinuousRecording",
];

for (const symbol of deadSymbols) {
  check(
    `no live reference to \`${symbol}\``,
    !hookCode.includes(symbol),
    () => `useSystemAudio still references ${symbol}`
  );
}

const frontendCode = code(walk("src", ".ts")) + code(walk("src", ".tsx"));
for (const symbol of ["startContinuousRecording", "ignoreContinuousRecording"]) {
  check(
    `no consumer of the removed \`${symbol}\` export`,
    !frontendCode.includes(symbol),
    () => `something in src/ still calls ${symbol}`
  );
}

check(
  "the dead RecordingPanel is deleted, not merely unrendered",
  !exists("src/pages/app/components/speech/RecordingPanel.tsx"),
  () => "RecordingPanel.tsx is back; it had no importer"
);

check(
  "the speech and completion panels do not mention the dead panel",
  !speechPanel.includes("RecordingPanel") &&
    !completionPanel.includes("RecordingPanel"),
  () => "a panel still imports RecordingPanel"
);

// ---- B. the orphaned events have no emitter left ----------------------------

const orphanedEvents = [
  "recording-progress",
  "continuous-recording-start",
  "continuous-recording-stopped",
];

for (const event of orphanedEvents) {
  check(
    `the frontend no longer listens for \`${event}\``,
    !hookCode.includes(event),
    () => `useSystemAudio still listens for ${event}`
  );
  check(
    `the Rust side no longer emits \`${event}\``,
    !rust.includes(event),
    () => `src-tauri still emits ${event} with no listener`
  );
}

// ---- C. the live paths that shared that code are intact --------------------

const speechPartialEmitted = rust.includes('"speech-partial"');
const speechPartialListened = hookCode.includes("speech-partial");
check(
  "`speech-partial` is still emitted by Rust and listened for by the hook",
  speechPartialEmitted && speechPartialListened,
  () =>
    `partial transcript wiring broke (emit=${speechPartialEmitted}, listen=${speechPartialListened})`
);

check(
  "the partial-transcript cadence survived the progress-emit removal",
  /audio_buffer\.len\(\) % \(sr as usize\) == 0/.test(rust) &&
    /audio_buffer\.len\(\) >= \(sr as usize\) \* 2/.test(rust),
  () => "the one-second/ two-second gate around the partial emit was removed too"
);

const manualStopListened = rust.includes('"manual-stop-continuous"');
const manualStopCommand = /fn manual_stop_continuous/.test(rust);
check(
  "`manual-stop-continuous` still has both its listener and its command",
  manualStopListened && manualStopCommand,
  () =>
    `manual stop wiring broke (listen=${manualStopListened}, command=${manualStopCommand})`
);

check(
  "the capture start/stop commands are still defined and still invoked",
  rust.includes("fn start_system_audio_capture") &&
    rust.includes("fn stop_system_audio_capture") &&
    hookCode.includes("start_system_audio_capture") &&
    hookCode.includes("stop_system_audio_capture"),
  () => "a real capture command went missing with the vestige"
);

// ---- D. the hook's listener teardown matches what it creates ----------------

check(
  "no orphaned unlisten handles remain in the hook",
  !/progressUnlisten|startUnlisten|stopUnlisten/.test(hookCode),
  () => "a listener was removed without its teardown"
);

check(
  "the remaining listener effect is named for what it does",
  hookCode.includes("setupCaptureListeners") &&
    !hookCode.includes("setupContinuousListeners"),
  () => "the listener effect still presents itself as continuous-mode wiring"
);

check(
  "the hook still creates and tears down both surviving listeners",
  /errorUnlisten = await listen\("audio-encoding-error"/.test(hookCode) &&
    /discardedUnlisten = await listen\("speech-discarded"/.test(hookCode) &&
    /if \(errorUnlisten\) errorUnlisten\(\);/.test(hookCode) &&
    /if \(discardedUnlisten\) discardedUnlisten\(\);/.test(hookCode),
  () => "an error/discard listener or its teardown is missing"
);

// ---- report ----------------------------------------------------------------

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log(
    "PASS - vestigial continuous mode is gone: the dead states, callbacks,\n" +
      "       listeners and panel are removed, the three orphaned events are no\n" +
      "       longer emitted, and the partial-transcript, manual-stop and\n" +
      "       capture start/stop paths that shared that code are still wired."
  );
  process.exit(0);
}
console.log(`FAIL - ${failures.length} check(s) failed:`);
for (const f of failures) console.log(`  ${f.name}\n    ${f.problem}`);
process.exit(1);
