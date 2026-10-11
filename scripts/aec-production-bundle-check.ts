// Run after `npx vite build`: verify the worker is reachable from the shipped
// app graph and retains the same-origin asset paths required by LocalVQE.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const ASSETS = join(DIST, "assets");

assert.ok(statSync(ASSETS).isDirectory(), "dist/assets is missing; run `npx vite build` first");

const chunks = readdirSync(ASSETS).filter((name) => /\.m?js$/i.test(name));
const workerChunks = chunks.filter((name) => /worker/i.test(name));
assert.ok(workerChunks.length > 0, "Vite did not emit a worker chunk under dist/assets/");

const workerContents = workerChunks.map((name) => ({
  name,
  text: readFileSync(join(ASSETS, name), "utf8"),
}));
const localVqeWorker = workerContents.find(({ text }) =>
  text.includes("localvqe_process_frame_f32")
);
assert.ok(
  localVqeWorker,
  `no emitted worker chunk references localvqe_process_frame_f32: ${workerChunks.join(", ")}`
);
assert.ok(
  localVqeWorker.text.includes("/localvqe/localvqe-glue.mjs"),
  `${localVqeWorker.name} does not reference the bundled LocalVQE glue URL`
);

const wasmPath = join(DIST, "localvqe", "localvqe.wasm");
assert.ok(statSync(wasmPath).isFile(), "dist/localvqe/localvqe.wasm is missing");

assert.ok(
  /new URL\([^)]*"\/localvqe\/"/.test(localVqeWorker.text) &&
    localVqeWorker.text.includes("location.origin"),
  `${localVqeWorker.name} must resolve locateFile against the absolute /localvqe/ base`
);
assert.ok(
  !/new URL\([^)]*(?:import\.meta\.url|location\.href)[^)]*localvqe\.wasm/.test(localVqeWorker.text),
  `${localVqeWorker.name} appears to resolve WASM relative to its script location`
);

console.log("AEC production bundle - ship-proof gate");
console.log(`  ok    worker chunk emitted: ${localVqeWorker.name}`);
console.log("  ok    worker references localvqe_process_frame_f32 and /localvqe/localvqe-glue.mjs");
console.log("  ok    dist/localvqe/localvqe.wasm exists");
console.log("  ok    locateFile uses absolute /localvqe/ with the app origin");
console.log("PASS - production LocalVQE worker assets are reachable from the built app.");
