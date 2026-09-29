// Regression guard against build-time secret embedding in the Rust half.
//
// WHY THIS EXISTS
// ---------------
// `src-tauri/build.rs` used to read `PAYMENT_ENDPOINT`, `API_ACCESS_KEY`,
// `APP_ENDPOINT` and `POSTHOG_API_KEY` from the environment (after loading
// `.env` with dotenv) and emit each as a `cargo:rustc-env=...` line. That
// alone does not put a value into the binary, but it is the arming step: the
// moment any Rust source adds `env!("API_ACCESS_KEY")` or `option_env!(...)`,
// whatever is in the environment at build time is compiled into the shipped
// artifact and recoverable with `strings`. Phase 2C section 7 found a
// `ghp_`-prefixed 40-character token sitting in `Hyperly/.env` while that
// mechanism was armed.
//
// Phase 4 R12 removed the emissions and the dotenv plumbing. This guard keeps
// them out, and catches the first half of any re-introduction:
//
//   1. `build.rs` must not emit `cargo:rustc-env=` for anything.
//   2. No Rust source may read a compile-time environment value with
//      `env!(...)` / `option_env!(...)` unless it is cargo-provided build
//      metadata (`CARGO_*`). Runtime reads (`std::env::var`) are the
//      sanctioned pattern: secrets belong to the OS environment or the app's
//      settings store, never to the compiler.
//   3. The four purged names must not appear in `src-tauri` code at all.
//
// Run with:  node scripts/secret-embedding-check.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_TAURI = join(ROOT, "src-tauri");

const PURGED_NAMES = [
  "API_ACCESS_KEY",
  "POSTHOG_API_KEY",
  "PAYMENT_ENDPOINT",
  "APP_ENDPOINT",
];

type Failure = { where: string; problem: string };

const walk = (dir: string, filter: (path: string) => boolean): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "target" || entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
};

const rel = (p: string): string => relative(ROOT, p).replaceAll("\\", "/");

const isCommentLine = (line: string): boolean => {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*");
};

const codeLines = (path: string): { n: number; text: string }[] =>
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => !isCommentLine(l.text));

const failures: Failure[] = [];

// 1. build.rs must not arm the compiler with environment values.
const buildRs = join(SRC_TAURI, "build.rs");
const buildLines = codeLines(buildRs);
for (const { n, text } of buildLines) {
  if (/cargo:rustc-env\s*=/.test(text)) {
    failures.push({
      where: `${rel(buildRs)}:${n}`,
      problem: "emits cargo:rustc-env=... (build-time environment value reaches the compiler)",
    });
  }
}

// 2. No compile-time env reads except cargo metadata (CARGO_*).
const rustFiles = [
  ...walk(join(SRC_TAURI, "src"), (p) => p.endsWith(".rs")),
  buildRs,
];
for (const file of rustFiles) {
  for (const { n, text } of codeLines(file)) {
    for (const m of text.matchAll(/(?:^|[^\w:])(env!|option_env!)\s*\(\s*"([^"]*)"/g)) {
      const name = m[2];
      if (!name.startsWith("CARGO_")) {
        failures.push({
          where: `${rel(file)}:${n}`,
          problem: `${m[1]}("${name}") compiles a build-time value into the binary`,
        });
      }
    }
  }
}

// 3. The purged names must not come back into src-tauri code.
const textFiles = [
  ...walk(join(SRC_TAURI, "src"), (p) => /\.(rs|toml|json)$/.test(p)),
  buildRs,
  join(SRC_TAURI, "Cargo.toml"),
  join(SRC_TAURI, "tauri.conf.json"),
].filter((p) => statSync(p).isFile());
for (const file of textFiles) {
  for (const { n, text } of codeLines(file)) {
    for (const name of PURGED_NAMES) {
      if (text.includes(name)) {
        failures.push({
          where: `${rel(file)}:${n}`,
          problem: `purged build-time name "${name}" appears in code`,
        });
      }
    }
  }
}

console.log("=".repeat(72));
console.log("secret embedding - the Rust build must not compile env values in");
console.log("=".repeat(72));

if (failures.length === 0) {
  console.log("\n  ok    build.rs emits no cargo:rustc-env= lines");
  console.log("  ok    no compile-time env!/option_env! reads beyond CARGO_* metadata");
  console.log(`  ok    ${PURGED_NAMES.length} purged names absent from src-tauri code`);
  console.log("\n" + "=".repeat(72));
  console.log("PASS - nothing from the environment can reach the shipped binary.");
  process.exit(0);
}

console.log(`\n  FAIL  ${failures.length} finding(s):`);
for (const f of failures) console.log(`        ${f.where} - ${f.problem}`);
console.log("\n" + "=".repeat(72));
console.log("FAIL - build-time environment values can reach the shipped binary:");
for (const f of failures) console.log(`  ${f.where}  ${f.problem}`);
console.log(
  "\n  Fix: emit nothing via cargo:rustc-env, and read secrets at runtime\n" +
    "  (std::env::var or the app settings store) instead of env!()/option_env!()."
);
process.exit(1);
