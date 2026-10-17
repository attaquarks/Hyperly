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

const workletPath = join(DIST, "aec", "mic-aec-worklet.js");
assert.ok(statSync(workletPath).isFile(), "dist/aec/mic-aec-worklet.js is missing");
const workletText = readFileSync(workletPath, "utf8");
assert.match(
  workletText,
  /registerProcessor\(\s*["']hyperly-mic-aec-bridge["']/,
  "built AudioWorklet asset does not register hyperly-mic-aec-bridge"
);

const appChunkText = chunks
  .filter((name) => /\.m?js$/i.test(name))
  .map((name) => readFileSync(join(ASSETS, name), "utf8"))
  .join("\n");
assert.ok(
  !appChunkText.includes("data:video/mp2t"),
  "an emitted app chunk contains a raw TypeScript data:video/mp2t worklet"
);
assert.ok(
  !/\.addModule\s*\(\s*["'`]data:/i.test(appChunkText),
  "an emitted app chunk passes a data: URL to AudioWorklet.addModule"
);
const workletUrlVariable = appChunkText.match(
  /(?:const|let|var)\s+([\w$]+)=new URL\(["']\/aec\/mic-aec-worklet\.js["'],\s*location\.origin\)/
);
assert.ok(
  workletUrlVariable &&
    new RegExp(`audioWorklet\\.addModule\\(\\s*${workletUrlVariable[1]}\\.href\\s*\\)`).test(appChunkText),
  "built app does not load the AudioWorklet from the same-origin /aec/ asset"
);

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
console.log("  ok    AudioWorklet JS asset registers the bridge and app loads it from same-origin /aec/");
console.log("  ok    no emitted app chunk embeds or loads a data:video/mp2t worklet");
console.log("PASS - production LocalVQE worker assets are reachable from the built app.");
