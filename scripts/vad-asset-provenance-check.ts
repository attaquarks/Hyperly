// Provenance guard: the /vad runtime assets in `public/vad` must match the
// installed packages they were copied from, and the package that owns them
// must be declared directly.
//
// WHY THIS EXISTS
// ---------------
// onnxruntime-web loads its .wasm/.mjs by URL and vad-web loads the Silero
// models and the audio worklet, all from `public/vad` (Hyperly's CSP forbids
// CDN assets). The files are copied from node_modules rather than fetched at
// runtime, so an `npm update` can silently move the JS to a newer version
// while the assets on disk stay behind. Pluely has exactly that skew (JS
// 0.0.30, CDN assets 0.0.31); Phase 3 section 10 warned that nothing here
// detects it. This script is that detector.
//
// The assets are pinned to:
//   @ricky0123/vad-web@0.0.30   silero_vad_legacy.onnx, silero_vad_v5.onnx,
//                               vad.worklet.bundle.min.js
//   onnxruntime-web@1.29.0      ort-wasm-simd-threaded.mjs,
//                               ort-wasm-simd-threaded.wasm
//
// `@ricky0123/vad-web` must also be a DIRECT dependency: the app imports it
// (src/hooks/useVoiceInput.ts) and previously got it only transitively through
// `@ricky0123/vad-react`, which nothing imported (Phase 4 R10).
//
// Run with:  node scripts/vad-asset-provenance-check.ts

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_VAD = join(ROOT, "public", "vad");

const PROVENANCE: Record<string, { pkg: string; rel: string }> = {
  "ort-wasm-simd-threaded.mjs": { pkg: "onnxruntime-web", rel: "dist/ort-wasm-simd-threaded.mjs" },
  "ort-wasm-simd-threaded.wasm": { pkg: "onnxruntime-web", rel: "dist/ort-wasm-simd-threaded.wasm" },
  "silero_vad_legacy.onnx": { pkg: "@ricky0123/vad-web", rel: "dist/silero_vad_legacy.onnx" },
  "silero_vad_v5.onnx": { pkg: "@ricky0123/vad-web", rel: "dist/silero_vad_v5.onnx" },
  "vad.worklet.bundle.min.js": { pkg: "@ricky0123/vad-web", rel: "dist/vad.worklet.bundle.min.js" },
};

const OWNER = "@ricky0123/vad-web";
const REMOVED = "@ricky0123/vad-react";

const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));

const sha256 = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

const pkg = readJson(join(ROOT, "package.json"));
const declared: Record<string, string> = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
};

const failures: string[] = [];

console.log("=".repeat(72));
console.log("public/vad provenance - assets must match the installed packages");
console.log("=".repeat(72));

// 1. The imported package must be declared directly, at the installed version.
if (!declared[OWNER]) {
  failures.push(
    `${OWNER} is not declared in package.json, but it is imported at runtime ` +
      `(src/hooks/useVoiceInput.ts) and owns the model/worklet assets`
  );
  console.log(`\n  FAIL  ${OWNER} is not a direct dependency`);
} else {
  const installedPath = join(ROOT, "node_modules", OWNER, "package.json");
  if (!existsSync(installedPath)) {
    failures.push(`${OWNER} is declared but not installed`);
    console.log(`\n  FAIL  ${OWNER} declared but missing from node_modules`);
  } else {
    const installed = readJson(installedPath).version as string;
    if (declared[OWNER] === installed) {
      console.log(`\n  ok    ${OWNER} declared as ${declared[OWNER]} (installed ${installed})`);
    } else {
      failures.push(
        `${OWNER} is declared "${declared[OWNER]}" but node_modules has ${installed} - ` +
          `the pinned assets were copied from ${installed}`
      );
      console.log(`\n  FAIL  ${OWNER} declared "${declared[OWNER]}" but installed ${installed}`);
    }
  }
}

// 2. The removed transitive package must not come back.
if (declared[REMOVED]) {
  failures.push(`${REMOVED} is declared but unused - nothing imports it (removed in Phase 4 R10)`);
  console.log(`\n  FAIL  ${REMOVED} is declared but nothing imports it`);
} else {
  console.log(`\n  ok    ${REMOVED} is not declared`);
}

// 3. Every asset must be mapped, present and byte-identical to its source.
const onDisk = readdirSync(PUBLIC_VAD).filter((f) => statSync(join(PUBLIC_VAD, f)).isFile());

for (const name of onDisk) {
  if (!PROVENANCE[name]) {
    failures.push(
      `public/vad/${name} has no provenance entry - add it to PROVENANCE with its source package`
    );
    console.log(`\n  FAIL  public/vad/${name} is unmapped`);
  }
}

let compared = 0;
for (const [name, src] of Object.entries(PROVENANCE)) {
  const assetPath = join(PUBLIC_VAD, name);
  const sourcePath = join(ROOT, "node_modules", src.pkg, src.rel);
  if (!existsSync(assetPath)) {
    failures.push(`public/vad/${name} is missing (source: ${src.pkg}/${src.rel})`);
    console.log(`\n  FAIL  public/vad/${name} is missing`);
    continue;
  }
  if (!existsSync(sourcePath)) {
    failures.push(`node_modules/${src.pkg}/${src.rel} is missing - cannot verify ${name}`);
    console.log(`\n  FAIL  ${src.pkg}/${src.rel} not installed`);
    continue;
  }
  const a = sha256(assetPath);
  const b = sha256(sourcePath);
  if (a === b) {
    compared++;
    console.log(`\n  ok    ${name} == ${src.pkg}/${src.rel} (sha256 ${a.slice(0, 12)}...)`);
  } else {
    failures.push(
      `public/vad/${name} differs from ${src.pkg}/${src.rel} - re-copy the asset or pin the package`
    );
    console.log(
      `\n  FAIL  ${name} differs from ${src.pkg}/${src.rel}\n` +
        `        public/vad: ${a}\n        node_modules: ${b}`
    );
  }
}

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log(`PASS - ${compared} asset(s) byte-identical to their installed sources.`);
  process.exit(0);
}
console.log(`FAIL - ${failures.length} provenance problem(s):`);
for (const f of failures) console.log(`  ${f}`);
console.log(
  "\n  Fix: declare the owning package exactly as installed, re-copy the assets\n" +
    "  from node_modules, or update both together when bumping the package."
);
process.exit(1);

