// Consent guard: the microphone must not be reachable without an explicit
// in-app decision, and Listen must not start capturing on its own.
//
// WHY THIS EXISTS
// ---------------
// Phase 4 R7 (owner decision 2026-09-30, issue #12, "Option 1"):
//   * the first microphone use asks in-app; nothing is captured until accepted;
//   * consent is remembered; denial is the default;
//   * capture starts only from an explicit gesture (Start button, spacebar,
//     global hotkey, push-to-talk) - never from a mount effect.
//
// Windows specifics: Tauri brokers mic access only on macOS, so Hyperly
// installs its own WebView2 PermissionRequested handler
// (src-tauri/src/mic_permission.rs). It used to set ALLOW unconditionally,
// which made the app the strongest auto-approval path on the machine. It now
// mirrors the in-app consent flag, and src/lib/mic-consent.ts re-asserts the
// stored decision on every boot.
//
// This script fails if that gate is removed, if the consent command disappears
// from the Tauri handler list, if the mic can be opened without
// requestMicConsent(), or if the Listen auto-start effect returns.
//
// Run with:  node scripts/mic-consent-check.ts

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Failure = { where: string; problem: string };
const failures: Failure[] = [];

const read = (relPath: string): string => {
  try {
    return readFileSync(join(ROOT, relPath), "utf8");
  } catch {
    return "";
  }
};

const must = (relPath: string, pattern: RegExp, label: string): void => {
  if (!pattern.test(read(relPath))) {
    failures.push({ where: relPath, problem: `missing: ${label}` });
  }
};

const mustNot = (relPath: string, pattern: RegExp, label: string): void => {
  if (pattern.test(read(relPath))) {
    failures.push({ where: relPath, problem: `present but must not be: ${label}` });
  }
};

// 1. Rust: the WebView2 handler denies the microphone until consent is granted.
must("src-tauri/src/mic_permission.rs", /MIC_CONSENT/, "consent flag (MIC_CONSENT)");
must("src-tauri/src/mic_permission.rs", /fn set_mic_consent/, "set_mic_consent command fn");
must("src-tauri/src/mic_permission.rs", /PERMISSION_STATE_DENY/, "explicit DENY state");
must("src-tauri/src/mic_permission.rs", /COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ/, "clipboard-read path preserved");
must("src-tauri/src/lib.rs", /set_mic_consent/, "set_mic_consent registered in generate_handler");

// 2. Frontend: the store exists and is the only door to getUserMedia.
must("src/lib/mic-consent.ts", /export const requestMicConsent/, "requestMicConsent()");
must("src/lib/mic-consent.ts", /export const hasMicConsent/, "hasMicConsent()");
must("src/lib/mic-consent.ts", /"mic_consent"/, "persisted consent key");
must("src/main.tsx", /MicConsentDialog/, "dialog mounted at the app root");
must("src/main.tsx", /syncMicConsentToBackend/, "boot-time backend sync");

const micSrc = read("src/lib/microphone.ts");
// Compare code, not prose: comments legitimately mention getUserMedia.
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const micCode = stripComments(micSrc);
const fnStart = micCode.indexOf("export const getMicrophoneStream");
const fnBody = fnStart === -1 ? "" : micCode.slice(fnStart);
const consentAt = fnBody.indexOf("requestMicConsent()");
const firstGetUserMediaAt = fnBody.indexOf("getUserMedia");
if (fnStart === -1 || consentAt === -1) {
  failures.push({
    where: "src/lib/microphone.ts",
    problem: "missing: requestMicConsent() inside getMicrophoneStream",
  });
} else if (firstGetUserMediaAt !== -1 && firstGetUserMediaAt < consentAt) {
  failures.push({
    where: "src/lib/microphone.ts",
    problem: "getMicrophoneStream opens getUserMedia before requestMicConsent()",
  });
}

const primeStart = micCode.indexOf("export const primeMicrophoneLabels");
const primeBody =
  primeStart === -1 || fnStart === -1 ? "" : micCode.slice(primeStart, fnStart);
const primeConsentAt = primeBody.indexOf("hasMicConsent()");
const primeGumAt = primeBody.indexOf("getUserMedia");
if (primeStart === -1 || primeConsentAt === -1) {
  failures.push({
    where: "src/lib/microphone.ts",
    problem: "missing: primeMicrophoneLabels must check hasMicConsent() before probing",
  });
} else if (primeGumAt !== -1 && primeGumAt < primeConsentAt) {
  failures.push({
    where: "src/lib/microphone.ts",
    problem: "primeMicrophoneLabels probes getUserMedia before checking consent",
  });
}

// 3. Listen: no mount-effect auto-start, no suppression bookkeeping.
mustNot("src/hooks/useSystemAudio.ts", /autoListenSuppressedRef/, "auto-start suppression ref (auto-start is gone)");
mustNot("src/hooks/useSystemAudio.ts", /captureBehavior !== "auto"\)\s*return/, "auto-mode autostart effect guard");

console.log("=".repeat(72));
console.log("microphone consent - explicit decision, no unattended capture");
console.log("=".repeat(72));

if (failures.length === 0) {
  console.log("\n  ok    WebView2 handler denies the mic until consent is granted");
  console.log("  ok    consent store + dialog + boot-time backend sync present");
  console.log("  ok    getUserMedia is gated behind requestMicConsent()");
  console.log("  ok    Listen has no auto-start effect");
  console.log("\n" + "=".repeat(72));
  console.log("PASS - the microphone requires an explicit, remembered consent decision.");
  process.exit(0);
}

console.log(`\n  FAIL  ${failures.length} finding(s):`);
for (const f of failures) console.log(`        ${f.where} - ${f.problem}`);
console.log("\n" + "=".repeat(72));
console.log("FAIL - microphone consent guarantees are broken:");
for (const f of failures) console.log(`  ${f.where}  ${f.problem}`);
console.log(
  "\n  Fix: restore the deny-by-default gate (Rust), the consent store/dialog\n" +
    "  (src/lib/mic-consent.ts + root mount), the getUserMedia gate, and remove\n" +
    "  any effect that starts Listen without a user gesture."
);
process.exit(1);
