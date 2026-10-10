// Pin the vendored LocalVQE artifacts and smoke-test the real WASM + compact
// GGUF through the browser-shaped loader used by the Step 3 worker.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  LOCALVQE_SMOKE_SAMPLE_RATE,
  makeLocalVqeSmokeFixture,
} from "../src/lib/aec/fixtures/localvqe-smoke.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_DIR = join(ROOT, "public", "localvqe");
const ASSETS = [
  {
    name: "localvqe.js",
    bytes: 65_747,
    sha256: "a995cfa3fbf2a10aa61db8f6e85d8e8b2406309685ff4c5a05027e0fa0703222",
  },
  {
    name: "localvqe.wasm",
    bytes: 999_408,
    sha256: "c367083af7e7d32c1f23d57605ac1b6a48b592a750fa5c39ca806ae8d3c46297",
  },
  {
    name: "localvqe-pi-aec-v1-49k-f32.gguf",
    bytes: 2_325_312,
    sha256: "b80b75b9038d0d28079a84afe7d4f0b8f6404f723af4633c05ed4f96fb30b7b8",
  },
];

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

console.log("=".repeat(72));
console.log("LocalVQE asset provenance + real WASM worker-engine smoke test");
console.log("=".repeat(72));

const assetBytes = new Map<string, Buffer>();
for (const asset of ASSETS) {
  const path = join(ASSET_DIR, asset.name);
  const bytes = readFileSync(path);
  assert.equal(statSync(path).size, asset.bytes, `${asset.name} size differs from the pinned source`);
  const actualHash = sha256(bytes);
  assert.equal(actualHash, asset.sha256, `${asset.name} SHA-256 differs from the pinned source`);
  assetBytes.set(asset.name, bytes);
  console.log(`  ok    ${asset.name} (${asset.bytes} B, sha256 ${actualHash})`);
}

const gluePath = join(ASSET_DIR, "localvqe.js");
const glueText = assetBytes.get("localvqe.js")!.toString("utf8");
const sandbox = {
  console,
  window: {},
  document: { currentScript: { src: "http://127.0.0.1:1420/localvqe/localvqe.js" } },
  performance,
  crypto: globalThis.crypto,
  fetch,
  setTimeout,
  clearTimeout,
  TextDecoder,
  TextEncoder,
  WebAssembly,
  AbortController,
  URL,
};
vm.createContext(sandbox);
vm.runInContext(glueText, sandbox, { filename: gluePath });
assert.equal(typeof sandbox.createLocalVQEModule, "function", "classic glue did not expose its factory in the VM global");
console.log("  ok    VM loader exposes the classic-script factory with currentScript set");

const wasmBytes = assetBytes.get("localvqe.wasm")!;
const modelBytes = assetBytes.get("localvqe-pi-aec-v1-49k-f32.gguf")!;
const module = await sandbox.createLocalVQEModule({
  wasmBinary: new Uint8Array(wasmBytes),
  locateFile: (path: string) => `http://127.0.0.1:1420/localvqe/${path}`,
});
const cwrap = (name: string, returnType: string | null, args: string[]) =>
  module.cwrap(name, returnType, args) as (...values: unknown[]) => unknown;
const optionsNew = cwrap("localvqe_options_new", "number", []) as () => number;
const optionsSetModel = cwrap("localvqe_options_set_model_path", "number", ["number", "string"]) as (opts: number, path: string) => number;
const optionsSetThreads = cwrap("localvqe_options_set_threads", "number", ["number", "number"]) as (opts: number, threads: number) => number;
const newWithOptions = cwrap("localvqe_new_with_options", "number", ["number"]) as (opts: number) => number;
const optionsFree = cwrap("localvqe_options_free", null, ["number"]) as (opts: number) => void;
const lastError = cwrap("localvqe_last_error", "string", ["number"]) as (ctx: number) => string | null;
const sampleRate = cwrap("localvqe_sample_rate", "number", ["number"]) as (ctx: number) => number;
const hopLength = cwrap("localvqe_hop_length", "number", ["number"]) as (ctx: number) => number;
const reset = cwrap("localvqe_reset", null, ["number"]) as (ctx: number) => void;
const processFrame = cwrap("localvqe_process_frame_f32", "number", [
  "number", "number", "number", "number", "number",
]) as (ctx: number, mic: number, ref: number, hop: number, output: number) => number;
const freeContext = cwrap("localvqe_free", null, ["number"]) as (ctx: number) => void;

module.FS.writeFile("/model.gguf", new Uint8Array(modelBytes));
const options = optionsNew();
assert.notEqual(options, 0, "localvqe_options_new returned a null handle");
let context = 0;
try {
  assert.equal(optionsSetModel(options, "/model.gguf"), 0, "model path setter failed");
  assert.equal(optionsSetThreads(options, 1), 0, "single-thread setter failed");
  context = newWithOptions(options);
} finally {
  optionsFree(options);
}
if (!context) {
  throw new Error(`localvqe_new_with_options returned 0: ${lastError(0) || "no error string"}`);
}
assert.equal(sampleRate(context), LOCALVQE_SMOKE_SAMPLE_RATE);
assert.equal(hopLength(context), 256);
console.log(`  ok    shipped GGUF created ctx=${context} at ${sampleRate(context)} Hz / ${hopLength(context)}-sample hop`);

const fixture = makeLocalVqeSmokeFixture();
const hop = hopLength(context);
assert.equal(fixture.reference.length, LOCALVQE_SMOKE_SAMPLE_RATE * 4);
assert.equal(fixture.reference.length % hop, 0);
const processF32 = cwrap("localvqe_process_frame_f32", "number", [
  "number", "number", "number", "number", "number",
]) as (ctx: number, mic: number, ref: number, frameSamples: number, output: number) => number;
const pMic = module._malloc(hop * 4);
const pRef = module._malloc(hop * 4);
const pOut = module._malloc(hop * 4);
assert.ok(pMic && pRef && pOut, "could not allocate LocalVQE frame buffers");

const processStream = (mic: Float32Array, ref: Float32Array): { output: Float32Array; elapsedMs: number } => {
  const output = new Float32Array(mic.length);
  const startedAt = performance.now();
  for (let offset = 0; offset < mic.length; offset += hop) {
    module.HEAPF32.set(mic.subarray(offset, offset + hop), pMic >> 2);
    module.HEAPF32.set(ref.subarray(offset, offset + hop), pRef >> 2);
    const rc = processF32(context, pMic, pRef, hop, pOut);
    assert.equal(rc, 0, `localvqe_process_frame_f32 returned ${rc}: ${lastError(context) || "no error string"}`);
    output.set(module.HEAPF32.subarray(pOut >> 2, (pOut >> 2) + hop), offset);
  }
  return { output, elapsedMs: performance.now() - startedAt };
};

const energy = (values: Float32Array, start: number, end: number): number => {
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += values[i] * values[i];
  return sum;
};
const correlationAtLag = (
  output: Float32Array,
  nearEnd: Float32Array,
  start: number,
  lag: number
): number => {
  // Negative lag means output is delayed: compare output[t + |lag|] to nearEnd[t].
  const outputStart = start + Math.max(0, -lag);
  const nearStart = start + Math.max(0, lag);
  const length = Math.min(output.length - outputStart, nearEnd.length - nearStart);
  let dot = 0;
  let outputEnergy = 0;
  let nearEnergy = 0;
  for (let offset = 0; offset < length; offset += 1) {
    const outputSample = output[outputStart + offset];
    const nearSample = nearEnd[nearStart + offset];
    dot += outputSample * nearSample;
    outputEnergy += outputSample * outputSample;
    nearEnergy += nearSample * nearSample;
  }
  return dot / Math.sqrt(outputEnergy * nearEnergy);
};

let farOnly: ReturnType<typeof processStream>;
let doubleTalk: ReturnType<typeof processStream>;
try {
  reset(context);
  farOnly = processStream(fixture.farEndEcho, fixture.reference);
  reset(context);
  doubleTalk = processStream(fixture.doubleTalkMic, fixture.reference);
} finally {
  module._free(pMic);
  module._free(pRef);
  module._free(pOut);
}

const convergenceSkip = LOCALVQE_SMOKE_SAMPLE_RATE;
const erle = 10 * Math.log10(
  energy(fixture.farEndEcho, convergenceSkip, fixture.farEndEcho.length) /
    energy(farOnly.output, convergenceSkip, farOnly.output.length)
);
let nearCorrelation = -Infinity;
let nearBestLag = 0;
for (let lag = -400; lag <= 400; lag += 1) {
  const candidate = correlationAtLag(doubleTalk.output, fixture.nearEnd, convergenceSkip, lag);
  if (candidate > nearCorrelation) {
    nearCorrelation = candidate;
    nearBestLag = lag;
  }
}
const outputEnergy = energy(doubleTalk.output, 0, doubleTalk.output.length);
const totalSamples = fixture.reference.length * 2;
const totalProcessMs = farOnly.elapsedMs + doubleTalk.elapsedMs;
const throughput = (totalSamples / LOCALVQE_SMOKE_SAMPLE_RATE) / (totalProcessMs / 1_000);

console.log(`  measured far-end ERLE after 1 s convergence: ${erle.toFixed(2)} dB`);
console.log(`  measured near-end best-lag correlation after 1 s: ${nearCorrelation.toFixed(4)} at ${nearBestLag} samples`);
console.log(`  measured frame-wise throughput (${fixture.reference.length / LOCALVQE_SMOKE_SAMPLE_RATE} s far-only + ${fixture.reference.length / LOCALVQE_SMOKE_SAMPLE_RATE} s double-talk): ${throughput.toFixed(2)}x realtime`);

assert.ok(outputEnergy > 0, "double-talk output was zero");
assert.ok(nearCorrelation >= 0.95, `near-end best-lag correlation ${nearCorrelation.toFixed(4)} is below 0.95`);
assert.ok(Math.abs(nearBestLag + 256) <= 256, `near-end best lag ${nearBestLag} is more than one 256-sample hop from -256`);
assert.ok(throughput >= 2, `throughput ${throughput.toFixed(2)}x is below 2x realtime`);
freeContext(context);
console.log("PASS - pinned LocalVQE assets load and process bundled synthetic double-talk in the VM harness.");
