// Tauri wrapper that ensures cargo / rustc are findable on Windows
// even when the user's shell PATH is not yet refreshed, AND configures
// the correct toolchain (MSVC or MinGW/GNU) so `link.exe` is available
// during compilation.
//
// Why this exists:
//   * rustup installs .cargo/bin but does not always add it to PATH on
//     user machines. The Tauri CLI then fails with:
//         failed to get cargo metadata: program not found
//   * The active rustup toolchain on Windows is typically
//     x86_64-pc-windows-msvc, which requires Visual Studio Build Tools
//     to be installed (it provides `link.exe`). If VS Build Tools are
//     not installed, the build fails with:
//         linker `link.exe` not found
//     The same machine usually has MinGW64 (e.g. C:\mingw64\bin) with
//     its own `link.exe`, which works with the
//     x86_64-pc-windows-gnu toolchain.
//
// This wrapper:
//   1. Detects cargo install directory (.cargo/bin or common alternatives).
//   2. Prepends it to PATH for the spawned process.
//   3. If the MSVC toolchain is active but link.exe is missing, checks
//      for MinGW64 and switches to the GNU toolchain automatically.
//   4. Sets CC/CXX/AR env vars to the MinGW equivalents when GNU is used.
//   5. Forwards all arguments to the real `tauri` CLI.

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const isWin = process.platform === "win32";

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (_e) {
    return false;
  }
}

function findOnPath(exe) {
  const sep = isWin ? ";" : ":";
  const dirs = (process.env.PATH || process.env.Path || "").split(sep);
  for (const d of dirs) {
    if (!d) continue;
    if (exists(path.join(d, exe))) return d;
  }
  return null;
}

function findCargoBinDir() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".cargo", "bin"),
    isWin ? "C:\\Program Files\\Rust\\bin" : "/usr/local/cargo/bin",
    isWin ? "C:\\Program Files (x86)\\Rust\\bin" : null,
  ].filter(Boolean);
  for (const dir of candidates) {
    if (exists(path.join(dir, isWin ? "cargo.exe" : "cargo"))) {
      return dir;
    }
  }
  // Fall back: cargo on PATH
  const onPath = findOnPath(isWin ? "cargo.exe" : "cargo");
  return onPath;
}

function findMingwBinDir() {
  if (!isWin) return null;
  const candidates = [
    "C:\\mingw64\\bin",
    "C:\\msys64\\mingw64\\bin",
    "C:\\msys64\\usr\\bin",
    "C:\\MinGW\\bin",
  ];
  for (const d of candidates) {
    if (
      exists(path.join(d, "gcc.exe")) &&
      exists(path.join(d, "link.exe"))
    ) {
      return d;
    }
  }
  return null;
}

function getDefaultToolchain() {
  const r = spawnSync("rustup", ["show", "active-toolchain"], {
    encoding: "utf-8",
    env: process.env,
  });
  if (r.status === 0) {
    const out = (r.stdout || "").trim();
    // Output looks like: "stable-x86_64-pc-windows-msvc (default)"
    const m = out.match(/^([\w.-]+-x86_64-pc-windows-(?:msvc|gnu))/);
    if (m) return m[1];
  }
  return null;
}

function getInstalledToolchains() {
  const r = spawnSync("rustup", ["toolchain", "list"], {
    encoding: "utf-8",
    env: process.env,
  });
  if (r.status !== 0) return [];
  return (r.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("stable") || l.startsWith("beta") || l.startsWith("nightly") || /^\d/.test(l))
    .map((l) => l.split(" ")[0])
    .map((l) => l.replace(/-x86_64-pc-windows-(msvc|gnu).*$/, ""));
}

// --- PATH bootstrap ---
const cargoBin = findCargoBinDir();
if (cargoBin) {
  const sep = isWin ? ";" : ":";
  const cur = process.env.PATH || process.env.Path || "";
  if (!cur.split(sep).includes(cargoBin)) {
    process.env.PATH = cargoBin + sep + cur;
    process.env.Path = process.env.PATH;
  }
}

// --- Toolchain selection: prefer GNU if MSVC has no linker ---
const tc = getDefaultToolchain();
const msvcNoLinker =
  tc && tc.endsWith("-msvc") && !findOnPath("link.exe") && !exists("C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC");

if (msvcNoLinker) {
  // Try to switch to GNU toolchain automatically.
  const mingwBin = findMingwBinDir();
  if (mingwBin) {
    const sep = isWin ? ";" : ":";
    process.env.PATH = mingwBin + sep + process.env.PATH;
    process.env.Path = process.env.PATH;
    process.env.CC = path.join(mingwBin, "gcc.exe");
    process.env.CXX = path.join(mingwBin, "g++.exe");
    process.env.AR = path.join(mingwBin, "ar.exe");

    // Tell rustup to use the GNU toolchain for the spawned processes.
    // We do this by exporting RUSTUP_TOOLCHAIN, which both cargo and
    // rustup honor.
    const r = spawnSync("rustup", ["toolchain", "list"], {
      encoding: "utf-8",
      env: process.env,
    });
    if (r.status === 0) {
      const hasGnu = (r.stdout || "").includes("-x86_64-pc-windows-gnu");
      if (hasGnu) {
        process.env.RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu";
        console.log(
          "[tauri-with-path] MSVC toolchain active but `link.exe` not found.\n" +
            "                 Switching to stable-x86_64-pc-windows-gnu (MinGW64 at " +
            mingwBin +
            ")."
        );
      } else {
        console.warn(
          "[tauri-with-path] MSVC toolchain is active and `link.exe` is missing,\n" +
            "                 and the GNU toolchain is not installed. Install\n" +
            "                 Visual Studio Build Tools (C++ workload) OR run\n" +
            "                 `rustup toolchain install stable-x86_64-pc-windows-gnu`."
        );
      }
    }
  } else {
    console.warn(
      "[tauri-with-path] MSVC toolchain is active but `link.exe` is missing.\n" +
        "                 Install Visual Studio Build Tools (C++ workload) or MinGW64."
    );
  }
}

// --- Spawn the real Tauri CLI ---
let cliBin;
try {
  // The @tauri-apps/cli package exposes its CLI as `tauri.js`, not main.js.
  cliBin = require.resolve("@tauri-apps/cli/tauri.js");
} catch (e) {
  // Fallback to main.js
  try {
    cliBin = require.resolve("@tauri-apps/cli");
  } catch (e2) {
    console.error(
      "Could not locate @tauri-apps/cli. Did you run `npm install`?"
    );
    process.exit(1);
  }
}

const child = spawn(process.execPath, [cliBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to launch Tauri CLI:", err);
  process.exit(1);
});
