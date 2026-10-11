import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMicAec } from "../src/lib/aec/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hook = readFileSync(join(ROOT, "src/hooks/useVoiceInput.ts"), "utf8");
const worker = readFileSync(join(ROOT, "src/lib/aec/localvqe-worker.ts"), "utf8");
const micAec = readFileSync(join(ROOT, "src/lib/aec/mic-aec.ts"), "utf8");
const worklet = readFileSync(join(ROOT, "src/lib/aec/mic-aec-worklet.ts"), "utf8");
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
assert.match(hook, /session\.source\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
assert.match(hook, /micAec\?\.source\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
console.log("  ok    microphone acquisition uses the saved toggle and teardown stops source");

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

assert.match(micAec, /import \{ createLocalVqeWorker \} from "\.\/localvqe-worker-factory\.ts"/);
assert.match(hook, /await session\.activate\(context, getActiveAecReferenceFeed\(\)/);
assert.match(micAec, /if \(!enabled \|\| disposed \|\| activating\) return/);
assert.match(micAec, /if \(!feed \|\| feed\.status\.state === "degraded"/);
assert.match(micAec, /feed\.takeRef\(AEC_HOP_SAMPLES\)/);
assert.match(micAec, /worker\?\.postMessage\([\s\S]*type: "process"/);
assert.match(worklet, /const AEC_SAMPLE_RATE = 16_000/);
assert.match(worker, /localvqe_process_frame_f32/);
assert.match(systemAudio, /if \(!readAecEnabled\(\)\) return/);
assert.match(systemAudio, /setActiveAecReferenceFeed\(feed\)/);
assert.match(hook, /setAecStatus\(session\.status\)/);
assert.match(hook, /session\.source\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
assert.match(toggle, /does not guarantee echo removal/);
console.log("  ok    enabled mic path consumes the shared reference, resamples to 16 kHz, and sends hops to the worker");
console.log("  ok    failures bypass, AEC status is separate, teardown stops source, and toggle copy makes no efficacy claim");

console.log("PASS - the Step 0 AEC bypass is an identity-preserving no-op.");
