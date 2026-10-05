// Run every regression guard in `scripts/*-check.ts`, and fail on the first
// non-zero exit.
//
// WHY THIS EXISTS
// ---------------
// The guards are the project's regression net: each one drives real modules or
// asserts real source and exits non-zero when the invariant it protects is
// broken. Until now they were run by hand. CI ran `npm run build` (tsc + vite)
// and `cargo check` and nothing else, so a guard could be silently neutered --
// or a real regression introduced -- and CI stayed green. That is exactly how
// D1 shipped half-fixed: `stopAndSend` and the quick-action path sent
// unlabelled text to the model and no guard noticed, because no guard
// referenced those call sites and no guard ran automatically.
//
// Running them here makes the net automatic, and makes a *new* guard
// automatically enforced: the list is discovered from the filesystem, never
// hardcoded, so a guard added later is picked up without editing this file.
//
// HOW IT RUNS THEM
// ----------------
// Each guard is plain TypeScript with no build step, run through Node's own
// type stripping -- there is deliberately no `tsx`/`ts-node` dependency:
//   node --experimental-strip-types scripts/<name>-check.ts
// Sequential, not parallel: `vad-asset-serve-check.ts` boots a real Vite dev
// server, and the SQLite guards write real database files. Serialising keeps
// their output readable and avoids racing on ports and temp files.
//
// Each guard gets a timeout so one that hangs (a dev server that never
// becomes ready, a database lock) fails the step instead of stalling CI until
// the job limit.
//
// EXIT CODES
// ----------
//   0  every guard passed
//   1  at least one guard failed
//   2  no guards were found -- a glob or discovery bug, never "vacuously OK".
//      This is deliberately NOT a pass: silently running zero guards is the
//      exact failure mode this script exists to prevent.
//
// Run with:  node scripts/run-guards.mjs   (or: npm run guards)

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");

/**
 * Per-guard ceiling. The vite-dev-server guard is the slow one (it boots Vite
 * and fetches the ORT runtime over HTTP); on CI a cold module graph it can take
 * tens of seconds. 300s is generous enough not to flake and short enough that a
 * genuine hang fails the step.
 */
const TIMEOUT_MS = 300_000;

const strip = (s) => `${s}`.replace(/\u001b\[[0-9;]*m/g, "");

/** Discovered, never hardcoded -- see the header. */
const guards = readdirSync(SCRIPTS_DIR)
  .filter((name) => name.endsWith("-check.ts"))
  .sort();

if (guards.length === 0) {
  console.error(
    "FAIL - no guards found in scripts/*-check.ts.\n" +
      "       Zero guards is never a pass: it means discovery is broken, and\n" +
      "       the regression net is empty."
  );
  process.exit(2);
}

console.log("=".repeat(72));
console.log(`regression guards - running ${guards.length} from scripts/`);
console.log("=".repeat(72));

const failed = [];

for (const name of guards) {
  // No explicit flush: `console.log` to a TTY or a pipe is ordered, and when
  // stdout is a plain file Node makes it synchronous anyway. (`process.stdout
  // .flush()` is not a function in that case -- it only exists on TTY/pipe
  // streams -- so calling it unconditionally would crash the runner the moment
  // CI redirected output to a file.)
  process.stdout.write(`\n--- ${name} ${"-".repeat(Math.max(0, 60 - name.length))}\n`);

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPTS_DIR, name)],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      // Guards print their own report; pass it through rather than swallowing it
      // so a CI log shows why a guard failed, not just that it did.
      stdio: ["ignore", "inherit", "inherit"],
    }
  );

  // A guard killed by the timeout reports `signal`, and `status` is then null.
  // Treat that as a failure -- never as a silent pass.
  const timedOut = result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT";
  const status = result.status;

  if (timedOut) {
    console.error(`    TIMED OUT after ${TIMEOUT_MS / 1000}s`);
    failed.push({ name, status: "timeout" });
    continue;
  }

  if (status !== 0) {
    const why = result.error ? strip(result.error.message) : `exit code ${status}`;
    failed.push({ name, status: why });
  }
}

console.log("\n" + "=".repeat(72));

if (failed.length === 0) {
  console.log(
    `PASS - all ${guards.length} guards passed.\n` +
      "       These guards encode the fixes for the Phase 4 remediation and\n" +
      "       the D1-D9 defects. Do not weaken or delete one to make this green."
  );
  process.exit(0);
}

console.log(`FAIL - ${failed.length} of ${guards.length} guards failed:`);
for (const f of failed) console.log(`  ${f.name} - ${f.status}`);
console.log("\n  A failing guard is a real regression, not a flake to be ignored.");
process.exit(1);