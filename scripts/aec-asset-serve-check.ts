// Verify Vite serves the bundled LocalVQE artifacts and transforms the real
// worker factory into a module-worker URL during development.

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_DIR = join(ROOT, "public", "localvqe");
const ASSETS = [
  { name: "localvqe.js", mime: "javascript" },
  { name: "localvqe-glue.mjs", mime: "javascript" },
  { name: "localvqe.wasm", mime: "application/wasm" },
  { name: "localvqe-pi-aec-v1-49k-f32.gguf", mime: "" },
];

const server = await createServer({
  root: ROOT,
  server: { port: 0, strictPort: false, hmr: false, host: "127.0.0.1" },
  logLevel: "error",
});
const failures: string[] = [];
const checkAsset = async (base: string, name: string, mime: string): Promise<void> => {
  const path = join(ASSET_DIR, name);
  const expected = readFileSync(path);
  const response = await fetch(`${base}/localvqe/${name}`);
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  let problem: string | null = null;
  if (response.status !== 200) problem = `status ${response.status}, expected 200`;
  else if (body.length !== statSync(path).size) problem = `served ${body.length} bytes, expected ${expected.length}`;
  else if (!body.equals(expected)) problem = "served bytes differ from the bundled file";
  else if (mime && !contentType.includes(mime)) problem = `content-type "${contentType}" does not include "${mime}"`;
  if (problem) failures.push(`${name}: ${problem}`);
  console.log(`  ${problem ? "FAIL" : "ok  "} GET /localvqe/${name} -> ${response.status}${mime ? ` (${contentType})` : ""}`);
};

try {
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Vite did not bind a TCP port");
  const base = `http://127.0.0.1:${address.port}`;

  console.log("=".repeat(72));
  console.log("Vite dev - LocalVQE assets + module worker bundling");
  console.log("=".repeat(72));
  console.log(`  dev server on ${base}`);

  for (const asset of ASSETS) {
    try {
      await checkAsset(base, asset.name, asset.mime);
    } catch (error) {
      failures.push(`${asset.name}: ${(error as Error).message}`);
      console.log(`  FAIL GET /localvqe/${asset.name}: ${(error as Error).message}`);
    }
  }

  const gluePath = join(ASSET_DIR, "localvqe-glue.mjs");
  const expectedGlue = readFileSync(gluePath);
  const importUrl = `${base}/localvqe/localvqe-glue.mjs?import`;
  try {
    const response = await fetch(importUrl);
    const body = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    let problem: string | null = null;
    if (response.status !== 200) problem = `status ${response.status}, expected 200`;
    else if (!contentType.includes("javascript")) {
      problem = `content-type "${contentType}" does not include javascript`;
    } else if (body.length !== expectedGlue.length) {
      problem = `served ${body.length} bytes, expected ${expectedGlue.length}`;
    } else if (!body.equals(expectedGlue)) {
      problem = "served bytes differ from public/localvqe/localvqe-glue.mjs";
    }
    if (problem) failures.push(`glue ?import: ${problem}`);
    console.log(
      `  ${problem ? "FAIL" : "ok  "} GET /localvqe/localvqe-glue.mjs?import -> ${response.status} (${contentType})${problem ? `: ${problem}` : ", byte-identical"}`
    );
  } catch (error) {
    const problem = (error as Error).message;
    failures.push(`glue ?import: ${problem}`);
    console.log(`  FAIL GET /localvqe/localvqe-glue.mjs?import: ${problem}`);
  }

  const factoryResponse = await fetch(`${base}/src/lib/aec/localvqe-worker-factory.ts`);
  const factoryText = await factoryResponse.text();
  const workerMatch = factoryText.match(/(["'])([^"']*localvqe-worker\.ts\?worker_file&type=module)\1/);
  if (factoryResponse.status !== 200 || !workerMatch) {
    failures.push("Vite did not transform the factory into a module worker-file URL");
    console.log("  FAIL Vite module-worker factory transform");
  } else {
    const workerUrl = workerMatch[2];
    const workerResponse = await fetch(`${base}${workerUrl}`);
    const workerText = await workerResponse.text();
    const validWorker =
      workerResponse.status === 200 &&
      (workerResponse.headers.get("content-type") ?? "").includes("javascript") &&
      workerText.includes("localvqe-glue.mjs?url") &&
      workerText.includes("localvqe-glue.mjs") &&
      !workerText.includes("createObjectURL") &&
      !workerText.includes("new Blob") &&
      workerText.includes("localvqe_new_with_options") &&
      workerText.includes("localvqe_process_frame_f32");
    if (!validWorker) failures.push(`Vite worker module did not compile at ${workerUrl}`);
    console.log(`  ${validWorker ? "ok  " : "FAIL"} Vite module worker ${workerUrl} -> ${workerResponse.status}`);
  }

  // Fetch after the worker: this matches the browser's real ?url module-graph order.
  try {
    const response = await fetch(`${base}/localvqe/localvqe-glue.mjs?url`);
    const body = Buffer.from(await response.arrayBuffer());
    const bodyText = body.toString("utf8");
    const contentType = response.headers.get("content-type") ?? "";
    let problem: string | null = null;
    if (response.status !== 200) problem = `status ${response.status}, expected 200`;
    else if (!contentType.includes("javascript")) {
      problem = `content-type "${contentType}" does not include javascript`;
    } else if (body.equals(expectedGlue)) {
      problem = "?url was intercepted and served as raw glue instead of a URL module";
    } else if (!bodyText.includes('export default "/localvqe/localvqe-glue.mjs"')) {
      problem = "body does not export the expected /localvqe/localvqe-glue.mjs URL";
    }
    if (problem) failures.push(`glue ?url: ${problem}`);
    console.log(
      `  ${problem ? "FAIL" : "ok  "} GET /localvqe/localvqe-glue.mjs?url -> ${response.status} (${contentType})${problem ? `: ${problem}` : "; URL module, not raw glue"}`
    );
  } catch (error) {
    const problem = (error as Error).message;
    failures.push(`glue ?url: ${problem}`);
    console.log(`  FAIL GET /localvqe/localvqe-glue.mjs?url: ${problem}`);
  }
} finally {
  await server.close();
}

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log("PASS - LocalVQE files are served intact and the module worker is transformed by Vite.");
  process.exit(0);
}
console.log(`FAIL - ${failures.length} serve/bundling check(s):`);
for (const failure of failures) console.log(`  ${failure}`);
process.exit(1);
