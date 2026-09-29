// Regression guard for `optimizeDeps.exclude` in vite.config.ts.
//
// WHY THIS EXISTS
// ---------------
// Vite pre-bundles dependencies with esbuild, which is what converts a
// CommonJS package into something a browser can run. `optimizeDeps.exclude`
// switches that off for the named packages — Vite serves the raw file
// instead. That is fine for a package that is already ESM, and fatal for one
// that is CommonJS: the browser is handed `exports` / `require`, which do not
// exist there, and the moment that module is evaluated it throws
//
//     exports is not defined
//
// which is exactly what happened to `@ricky0123/vad-web` (dist/index.js begins
// with `Object.defineProperty(exports, "__esModule", ...)`). It took down the
// lazy `ListenUserMic` chunk in the Listen room and the Ask panel's
// `AutoSpeechVad`, both of which import it. (It is a direct dependency now —
// Phase 4 R10 removed the unused `@ricky0123/vad-react` wrapper it used to
// arrive through.)
//
// So: an excluded dependency must be ESM. Anything else is the bug above.
//
// THE SECOND FAILURE MODE
// -----------------------
// Root-entry format is not enough. `onnxruntime-web` is ESM at its root
// (`exports["."].import` -> dist/ort.bundle.min.mjs) and passed that check, but
// its exports map also publishes CommonJS:
//
//     "./wasm": { "import": ".../ort.wasm.bundle.min.mjs",
//                 "require": ".../ort.wasm.min.js" }   <- CJS
//
// `@ricky0123/vad-web/dist/real-time-vad.js` — the module the Listen mic and
// the Ask panel's AutoSpeechVad actually load — does
// `require("onnxruntime-web/wasm")`. Because the package was excluded, esbuild
// marked it external, and a CJS require() of an external cannot be expressed in
// ESM output. esbuild therefore emitted its `__require` shim, which throws:
//
//     Dynamic require of "onnxruntime-web/wasm" is not supported
//
// So the check has to walk every leaf of the exports map, not just the root:
// one CJS leaf somewhere in the map is enough to take down whichever lazy
// import reaches it.
//
// Run with:  node scripts/dep-format-check.ts

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(ROOT, "node_modules");

type Failure = { pkg: string; entry: string; reason: string };

// Pull the package names out of the `exclude: [...]` array in vite.config.ts.
// A regex rather than an import so the check runs without a TS toolchain.
const readExcludedPackages = (): string[] => {
  const config = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
  const block = config.match(/exclude\s*:\s*\[([^\]]*)\]/s);
  if (!block) return [];
  return [...block[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
};

// Which file would Vite actually serve for the browser (the `import`
// condition)? Mirrors the resolution order node/Vite use.
const resolveEntry = (pkgDir: string): string | null => {
  const pkgPath = join(pkgDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  const fromExports = (): string | null => {
    const root = pkg.exports?.["."];
    if (!root) return null;
    if (typeof root === "string") return root;
    const branch = root.import ?? root.browser ?? root.default;
    if (typeof branch === "string") return branch;
    if (branch && typeof branch === "object") {
      const inner = branch.default ?? branch.import;
      if (typeof inner === "string") return inner;
    }
    return null;
  };

  const rel = fromExports() ?? pkg.module ?? pkg.main ?? "index.js";
  return isAbsolute(rel) ? rel : resolve(pkgDir, rel);
};

// A file is browser-safe when it is unambiguously ESM.
const inspectEntry = (pkgDir: string, entry: string): string | null => {
  if (!existsSync(entry) || !statSync(entry).isFile()) {
    return `entry file does not exist: ${entry}`;
  }
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const source = readFileSync(entry, "utf8");

  if (entry.endsWith(".mjs")) return null;
  if (pkg.type === "module") return null;

  // `.js` in a non-"module" package: decide by content. A minifier renames the
  // module-scope bindings — `Object.defineProperty(exports, ...)` comes out as
  // `Je(exports, ...)` — so the only markers worth trusting are the ones that
  // cannot be renamed: the `module.exports` assignment and the UMD
  // `typeof exports` guard. That is literally how
  // `onnxruntime-web/dist/ort.wasm.min.js` signs off, in its final line:
  //   typeof exports=="object"&&typeof module=="object"&&(module.exports=ort);
  const looksCjs =
    /Object\.defineProperty\(\s*exports\s*,/.test(source) ||
    /\bmodule\.exports\s*=/.test(source) ||
    /typeof\s+exports\s*[=!]==?\s*["']object["']/.test(source) ||
    /^\s*"use strict";\s*\n\s*Object\.defineProperty\(\s*exports/m.test(source);
  if (looksCjs) {
    return "CommonJS served raw — the browser will throw `exports is not defined`";
  }
  return null;
};

type Leaf = { subpath: string; cond: string; file: string };

// Every file the exports map can hand out, keyed by the subpath that reaches
// it. The root (".") is excluded because `resolveEntry` already covers it.
// `cond` records which condition the leaf hangs off (`import`, `require`,
// `default`, ...) — that, not the filename, is what decides the format a
// consumer receives.
const collectExportLeaves = (pkgDir: string): Leaf[] => {
  const pkgPath = join(pkgDir, "package.json");
  if (!existsSync(pkgPath)) return [];
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!pkg.exports) return [];

  const leaves: Leaf[] = [];

  const walk = (node: unknown, subpath: string, cond: string): void => {
    if (typeof node === "string") {
      leaves.push({ subpath, cond, file: resolve(pkgDir, node) });
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) walk(value, subpath, key);
    }
  };

  for (const [key, value] of Object.entries(pkg.exports)) {
    if (key === ".") continue;
    walk(value, key.replace(/^\.\//, ""), "");
  }
  return leaves;
};

// The condition is the precise signal: in a package that is not `type:
// module`, a `require` branch is CommonJS by contract whatever the file is
// called. Content sniffing is only the fallback, for bare-string and `default`
// leaves where no condition names the format.
const leafIsCjs = (pkgDir: string, leaf: Leaf): boolean => {
  if (leaf.file.endsWith(".mjs")) return false;
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  if (pkg.type === "module") return false;
  if (leaf.cond === "import") return false;
  if (leaf.cond === "require") return true;
  return inspectEntry(pkgDir, leaf.file) !== null;
};

const excluded = readExcludedPackages();

console.log("=".repeat(72));
console.log("optimizeDeps.exclude — every excluded dependency must be ESM");
console.log("=".repeat(72));
console.log(`  vite.config.ts excludes: ${JSON.stringify(excluded)}`);

const failures: Failure[] = [];

for (const name of excluded) {
  const pkgDir = join(NODE_MODULES, name);
  if (!existsSync(pkgDir)) {
    console.log(`\n  ${name}\n    not installed — skipped`);
    continue;
  }
  const entry = resolveEntry(pkgDir);
  if (!entry) {
    failures.push({ pkg: name, entry: "<unresolved>", reason: "cannot resolve an entry" });
    console.log(`\n  ${name}\n    FAIL — cannot resolve an entry`);
    continue;
  }
  const reason = inspectEntry(pkgDir, entry);
  const shown = entry.startsWith(ROOT) ? entry.slice(ROOT.length + 1) : entry;
  if (reason) {
    failures.push({ pkg: name, entry: shown, reason });
    console.log(`\n  ${name}\n    FAIL — ${shown}\n    ${reason}`);
    continue;
  }

  // The root is ESM. Now every leaf of the exports map, because one CJS leaf
  // is enough to break whichever pre-bundled consumer require()s it. Binary
  // and declarative leaves (.wasm, .d.ts) are not code and cannot be CJS.
  const leaves = collectExportLeaves(pkgDir).filter(
    (leaf) => /\.(?:js|cjs|mjs)$/.test(leaf.file) && leaf.file !== entry
  );
  const cjsLeaves = leaves.filter((leaf) => leafIsCjs(pkgDir, leaf));

  if (cjsLeaves.length === 0) {
    console.log(`\n  ${name}\n    ok — ${shown} is ESM (${leaves.length} leaf(s) also ESM)`);
    continue;
  }

  for (const leaf of cjsLeaves) {
    const leafShown = leaf.file.startsWith(ROOT)
      ? leaf.file.slice(ROOT.length + 1)
      : leaf.file;
    const where = leaf.cond ? `the "${leaf.cond}" condition` : "a bare string";
    const spec = `${name}/${leaf.subpath}`;
    failures.push({
      pkg: name,
      entry: spec,
      reason:
        `exports["./${leaf.subpath}"] resolves to CommonJS under ${where} ` +
        `(${leafShown}) — a CJS consumer that require()s "${spec}" throws ` +
        `\`Dynamic require of "${spec}" is not supported\``,
    });
    console.log(
      `\n  ${name}\n    FAIL — exports["./${leaf.subpath}"] is CommonJS under ${where}\n    ${leafShown}`
    );
  }
}

console.log("\n" + "=".repeat(72));
if (failures.length === 0) {
  console.log("PASS — no CommonJS package is excluded from pre-bundling.");
  process.exit(0);
}
console.log(`FAIL — ${failures.length} CommonJS package(s) excluded from pre-bundling:`);
for (const f of failures) {
  console.log(`  ${f.pkg}  (${f.entry})`);
  console.log(`    ${f.reason}`);
}
console.log(
  "\n  Fix: remove the package from optimizeDeps.exclude so Vite converts it,\n" +
    "  or serve it another way. Then reload the page — Vite re-optimizes deps."
);
process.exit(1);
