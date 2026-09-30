// Regression guard for the /vad runtime assets under `vite dev`.
//
// WHY THIS EXISTS
// ---------------
// onnxruntime-web loads its runtime by URL. With `onnxWASMBasePath: "/vad/"`
// it fetches /vad/ort-wasm-simd-threaded.wasm and then dynamically imports
// /vad/ort-wasm-simd-threaded.mjs. That second request reaches the dev server
// shaped like an import, and Vite's own public-file handler steps aside for
// anything that looks like one (see `servePublicMiddleware` in
// vite/dist/node/chunks/config.js), so the module falls through to the
// transform pipeline, which resolves it to a file in /public and throws:
//
//   Failed to load url /vad/ort-wasm-simd-threaded.mjs (resolved id: ...).
//   This file is in /public and will be copied as-is during build without
//   going through the plugin transforms ...
//
// The `serveVadRuntime` plugin in vite.config.ts registers a middleware ahead
// of that pipeline and serves the .mjs byte-for-byte. This script boots a real
// dev server and asserts the behaviours that fix depends on.
//
// The .wasm and the worklet are checked too: they are *fetched* rather than
// imported, Vite serves them correctly on its own, and the plugin must not
// have disturbed that.
//
// This is a dev-server bug, so the check has to start one. It listens on its
// own port and never touches the app's 1420.
//
// Run with:  node scripts/vad-asset-serve-check.ts

import { createServer } from "vite";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.VAD_CHECK_PORT ?? "14997");

type Check = { label: string; url: string; assert: (res: Response, body: Buffer) => string | null };

const onDisk = (name: string): Buffer => readFileSync(join(ROOT, "public/vad", name));

const sameBytesAs = (name: string) => (res: Response, body: Buffer): string | null => {
  const expected = onDisk(name);
  if (body.length !== expected.length) {
    return `body is ${body.length} bytes, expected ${expected.length} (the file on disk)`;
  }
  if (!body.equals(expected)) return "body differs from the file on disk";
  return null;
};

const CHECKS: Check[] = [
  {
    label: "the module ORT imports, in import shape (the reported failure)",
    url: "/vad/ort-wasm-simd-threaded.mjs?import",
    assert: (res, body) => {
      if (res.status !== 200) return `status ${res.status}, expected 200`;
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("javascript")) return `content-type is "${type}", expected a JS type`;
      return sameBytesAs("ort-wasm-simd-threaded.mjs")(res, body);
    },
  },
  {
    label: "the same module without the import query",
    url: "/vad/ort-wasm-simd-threaded.mjs",
    assert: (res, body) => {
      if (res.status !== 200) return `status ${res.status}, expected 200`;
      return sameBytesAs("ort-wasm-simd-threaded.mjs")(res, body);
    },
  },
  {
    label: "the wasm binary, which Vite serves itself and must stay untouched",
    url: "/vad/ort-wasm-simd-threaded.wasm",
    assert: (res) => {
      if (res.status !== 200) return `status ${res.status}, expected 200`;
      const expected = statSync(join(ROOT, "public/vad", "ort-wasm-simd-threaded.wasm")).size;
      const len = Number(res.headers.get("content-length") ?? "-1");
      if (len !== -1 && len !== expected) return `content-length ${len}, expected ${expected}`;
      return null;
    },
  },
  {
    label: "the audio worklet",
    url: "/vad/vad.worklet.bundle.min.js",
    assert: (res, body) => {
      if (res.status !== 200) return `status ${res.status}, expected 200`;
      return sameBytesAs("vad.worklet.bundle.min.js")(res, body);
    },
  },
];

const server = await createServer({
  root: ROOT,
  // Own port, own life. `hmr: false` keeps this from opening a websocket or
  // reacting to the files the developer is editing next to it.
  server: { port: PORT, strictPort: false, hmr: false, host: "127.0.0.1" },
  logLevel: "warn",
});

const failures: string[] = [];

try {
  await server.listen();
  const actualPort = server.config.server.port ?? PORT;
  const base = `http://127.0.0.1:${actualPort}`;

  console.log("=".repeat(72));
  console.log("vite dev — /vad runtime assets");
  console.log("=".repeat(72));
  console.log(`  dev server on ${base} (leaving the app's 1420 alone)`);

  for (const check of CHECKS) {
    let status = "?";
    let problem: string | null = null;
    try {
      const res = await fetch(base + check.url);
      status = String(res.status);
      // Reading as a buffer keeps the byte-for-byte comparison honest for the
      // 14 MB wasm too, though only the small files are compared.
      const body = Buffer.from(await res.arrayBuffer());
      problem = check.assert(res, body);
    } catch (e) {
      problem = `request failed: ${(e as Error).message}`;
    }
    if (problem) failures.push(`${check.url} — ${problem}`);
    console.log(`\n  ${problem ? "FAIL" : "ok  "}  ${check.label}`);
    console.log(`        GET ${check.url}  ->  ${status}`);
    if (problem) console.log(`        ${problem}`);
  }
} finally {
  await server.close();
}

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log("PASS — every /vad runtime asset is served intact under vite dev.");
  process.exit(0);
}
console.log(`FAIL — ${failures.length} asset(s) not served correctly:`);
for (const f of failures) console.log(`  ${f}`);
console.log(
  "\n  The .mjs is the one that matters: ORT imports it after loading the\n" +
    "  wasm, so if it 500s the Ask panel and the Listen mic never start."
);
process.exit(1);
