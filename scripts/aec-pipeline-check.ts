import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createMicAec } from "../src/lib/aec/index.ts";
import { releaseMicAecSession } from "../src/lib/aec/release.ts";
import { AecRecoveryPolicy } from "../src/lib/aec/recovery.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hook = readFileSync(join(ROOT, "src/hooks/useVoiceInput.ts"), "utf8");
const worker = readFileSync(join(ROOT, "src/lib/aec/localvqe-worker.ts"), "utf8");
const micAec = readFileSync(join(ROOT, "src/lib/aec/mic-aec.ts"), "utf8");
const reference = readFileSync(join(ROOT, "src/lib/aec/reference.ts"), "utf8");
const releaseSource = readFileSync(join(ROOT, "src/lib/aec/release.ts"), "utf8");
const worklet = readFileSync(join(ROOT, "public/aec/mic-aec-worklet.js"), "utf8");
const shippedWorklet = worklet;
const systemAudio = readFileSync(join(ROOT, "src/hooks/useSystemAudio.ts"), "utf8");
const toggle = readFileSync(join(ROOT, "src/pages/audio/components/AecToggle.tsx"), "utf8");

console.log("AEC pipeline - Step 0 bypass preserves the original mic stream");

const source = {} as MediaStream;
const enabled = createMicAec(source, true);
assert.strictEqual(enabled.output, source, "enabled bypass must return source identity");
assert.strictEqual(enabled.source, source, "session must retain the original source");
assert.deepEqual(enabled.status, { state: "bypass", reason: "no-reference" });
console.log("  ok    enabled bypass returns the exact source stream object");

const disabled = createMicAec(source, false);
assert.strictEqual(disabled.output, source, "disabled path must return source identity");
assert.strictEqual(disabled.source, source, "disabled session must retain the source");
assert.deepEqual(disabled.status, { state: "off" });
console.log("  ok    disabled path returns the exact source stream object");

assert.match(hook, /createMicAec\(source, readAecEnabled\(\)\)/);
const sessionReleaseCalls = hook.match(/releaseMicAecSession\(session\)/g) ?? [];
assert.ok(sessionReleaseCalls.length >= 2,
  `expected releaseMicAecSession(session) in pause and setup cleanup, found ${sessionReleaseCalls.length}`);
assert.match(hook, /releaseMicAecSession\(micAec\)/);
assert.match(releaseSource, /session\.source\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
assert.match(releaseSource, /session\.dispose\(\)/);
const releaseOrder: string[] = [];
releaseMicAecSession({
  source: { getTracks: () => [{ stop: () => releaseOrder.push("track-stop") }] },
  dispose: () => releaseOrder.push("dispose"),
} as unknown as Parameters<typeof releaseMicAecSession>[0]);
assert.deepEqual(releaseOrder, ["track-stop", "dispose"]);
console.log("  ok    microphone acquisition uses the saved toggle and teardown stops source");
console.log("  ok    mic-release helper stops the owned source before disposing the AEC session");

const assetPaths = [
  "public/localvqe/localvqe.js",
  "public/localvqe/localvqe-glue.mjs",
  "public/localvqe/localvqe.wasm",
  "public/localvqe/localvqe-pi-aec-v1-49k-f32.gguf",
];
for (const assetPath of assetPaths) {
  assert.ok(existsSync(join(ROOT, assetPath)), `missing bundled LocalVQE asset: ${assetPath}`);
}
assert.match(worker, /import localVqeGlueUrl from "\/localvqe\/localvqe-glue\.mjs\?url"/);
assert.match(worker, /import\(\/\* @vite-ignore \*\/ localVqeGlueUrl\)/);
assert.match(worker, /new URL\(MODEL_URL, scope\.location\.origin\)/);
assert.match(worker, /const MODEL_URL = "\/localvqe\/localvqe-pi-aec-v1-49k-f32\.gguf"/);
assert.match(worker, /if \(!context\)/, "worker must reject a null LocalVQE context");
assert.match(worker, /if \(gap\) currentApi\.reset\(context\)/);
console.log("  ok    pinned worker assets exist; worker checks null context and resets on a gap");

const acquireStart = hook.indexOf("const acquire = async () => {");
const acquireEnd = hook.indexOf("const track = source.getAudioTracks()[0];", acquireStart);
const acquireBody = hook.slice(acquireStart, acquireEnd);
assert.ok(acquireStart >= 0 && acquireEnd > acquireStart, "could not locate microphone acquire block");
assert.ok(acquireBody.indexOf("releaseMicAecSession(previousSession)") < acquireBody.indexOf("createMicAec(source"),
  "acquire must release the previous mic session before replacing its ref");
const activeRouteIndex = micAec.indexOf("input.disconnect();\n        rawRouteConnected = false;");
const disposedBeforeActiveRoute = micAec.lastIndexOf("if (disposed)", activeRouteIndex);
assert.ok(activeRouteIndex >= 0 && disposedBeforeActiveRoute >= 0 && disposedBeforeActiveRoute < activeRouteIndex,
  "activation must check disposed before replacing the raw output with the AEC route");
const activationCatchIndex = micAec.indexOf("} catch (error) {", activeRouteIndex);
const disposedCatchIndex = micAec.indexOf("if (disposed) return;", activationCatchIndex);
const catchCleanupIndex = micAec.indexOf("detachTrackMonitor();", activationCatchIndex);
assert.ok(activationCatchIndex > activeRouteIndex && disposedCatchIndex > activationCatchIndex && disposedCatchIndex < catchCleanupIndex,
  "activation catch must leave output and status untouched when disposal already completed");
assert.match(micAec, /if \(feed\.status\.overflows !== lastReferenceOverflowCount\)/);
assert.match(micAec, /recovery\.noteOverflows\(newOverflows\)/);
assert.match(micAec, /const gap = feed\.consumeGap\(\)/);
assert.match(micAec, /ref: reference, gap/);
assert.match(micAec, /recovery\.noteWorkerFailure\(\)/);
assert.match(micAec, /worker\?\.postMessage\(\{ type: "reset" \}\)/);
assert.match(micAec, /LocalVQE failed after its recovery reset/);
assert.match(reference, /this\.pendingGap = true;\s*this\.frames\.clear\(\);/);
assert.match(reference, /consumeGap\(\): boolean/);
assert.match(worker, /if \(gap\) currentApi\.reset\(context\)/);
assert.match(micAec, /micTrack\.addEventListener\("ended"/);
assert.match(micAec, /settings\.deviceId !== initialDeviceId/);
assert.match(micAec, /settings\.sampleRate !== initialTrackSampleRate/);
assert.match(micAec, /const teardownForSourceChange = \(error: Error\)/);
assert.match(micAec, /disposeSession\(true\)/);
assert.match(micAec, /const disposeSession = \(preserveOutput = false\): void => \{[\s\S]*?disconnectGraph\(\);[\s\S]*?stopWorker\(\);[\s\S]*?source\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
assert.match(worker, /if \(!modulePromise\)/);
assert.match(worker, /pending\.catch\(\(\) => \{[\s\S]*?modulePromise === pending[\s\S]*?modulePromise = null/);
assert.match(worklet, /event\.data\.type === "dropped"[\s\S]*this\.playback\.push\(0\)/);
console.log("  ok    acquire disposes overwritten sessions; gaps reset; repeated overflow/failures bypass");
console.log("  ok    ended/device/rate changes release source and graph; rejected module load can retry");

const recovery = new AecRecoveryPolicy();
assert.equal(recovery.noteOverflows(1), "gap");
assert.equal(recovery.noteOverflows(1), "bypass");
const failureRecovery = new AecRecoveryPolicy();
assert.equal(failureRecovery.noteWorkerFailure(), "continue");
assert.equal(failureRecovery.noteWorkerFailure(), "continue");
assert.equal(failureRecovery.noteWorkerFailure(), "continue");
assert.equal(failureRecovery.noteWorkerFailure(), "reset");
assert.equal(failureRecovery.noteWorkerFailure(), "bypass");
const resetOnSuccess = new AecRecoveryPolicy();
resetOnSuccess.noteWorkerFailure();
resetOnSuccess.noteWorkerFailure();
resetOnSuccess.noteWorkerSuccess();
assert.equal(resetOnSuccess.noteWorkerFailure(), "continue");
console.log("  ok    recovery policy tolerates one overflow, resets after four failures, then bypasses on failure");

assert.match(micAec, /import \{ createLocalVqeWorker \} from "\.\/localvqe-worker-factory\.ts"/);
assert.match(hook, /await session\.activate\(context, getActiveAecReferenceFeed\(\)/);
assert.match(micAec, /if \(!enabled \|\| disposed \|\| activating\) return/);
assert.match(micAec, /if \(!feed \|\| feed\.status\.state === "degraded"/);
assert.match(micAec, /feed\.takeRef\(AEC_HOP_SAMPLES\)/);
assert.match(micAec, /worker\?\.postMessage\([\s\S]*type: "process"/);
assert.match(worklet, /const AEC_SAMPLE_RATE = 16000/);
assert.match(worker, /localvqe_process_frame_f32/);
assert.match(systemAudio, /if \(!readAecEnabled\(\)\) return/);
assert.match(systemAudio, /setActiveAecReferenceFeed\(feed\)/);
assert.match(hook, /setAecStatus\(session\.status\)/);
assert.match(hook, /releaseMicAecSession\(session\)/);
assert.match(toggle, /does not guarantee echo removal/);
console.log("  ok    enabled mic path consumes the shared reference, resamples to 16 kHz, and sends hops to the worker");
console.log("  ok    failures bypass, AEC status is separate, teardown stops source, and toggle copy makes no efficacy claim");

let registeredProcessorName = "";
let registeredProcessor: (new () => {
  port: { onmessage: ((event: { data: { type: string } }) => void) | null };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
}) | undefined;
class WorkletHarnessBase {
  port = {
    onmessage: null as ((event: { data: { type: string } }) => void) | null,
    postMessage: () => {},
  };
}
runInNewContext(shippedWorklet, {
  AudioWorkletProcessor: WorkletHarnessBase,
  Float32Array,
  sampleRate: 16_000,
  registerProcessor: (name: string, processor: typeof registeredProcessor) => {
    registeredProcessorName = name;
    registeredProcessor = processor;
  },
});
assert.equal(registeredProcessorName, "hyperly-mic-aec-bridge");
assert.ok(registeredProcessor, "shipped worklet must register a processor");
const workletInstance = new registeredProcessor();
workletInstance.port.onmessage?.({ data: { type: "bypass" } });
const bypassInput = new Float32Array([0.1, -0.2, 0.3, -0.4]);
const bypassOutput = new Float32Array(bypassInput.length);
assert.equal(workletInstance.process([[bypassInput]], [[bypassOutput]]), true);
assert.deepEqual(Array.from(bypassOutput), Array.from(bypassInput));
console.log("  ok    shipped AudioWorklet registers and copies mic samples in bypass mode");

console.log("PASS - the Step 0 AEC bypass is an identity-preserving no-op.");
