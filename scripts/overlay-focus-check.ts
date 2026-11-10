// The overlay's shortcuts must never take the desktop foreground.
//
// WHY THIS EXISTS
// ---------------
// Pressing Ctrl+\ (toggle_window) used to run `show()` + `unminimize()` +
// `set_focus()` on the main overlay. On Windows tauri's `show()` maps to
// `ShowWindow(SW_SHOW)` — which ACTIVATES the window — and `set_focus()` is
// an explicit `SetForegroundWindow`. Either one makes Hyperly the foreground
// window, which breaks the previously active app's fullscreen presentation
// (Chrome F11) and raises the taskbar over it. The fix is at the window
// lifecycle level: `win_activation::show_window_no_activate` uses
// `ShowWindow(SW_SHOWNOACTIVATE)` + `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE
// | SWP_SHOWWINDOW | NOMOVE | NOSIZE)` so the overlay surfaces above the
// fullscreen foreground app without ever becoming the foreground window.
//
// THIS SCRIPT asserts, on the real tree:
//   A. `show_main_window` (every shortcut that surfaces the overlay goes
//      through it) calls the no-activate show on the Windows path, has NO
//      activating call before it, and never calls set_focus on Windows —
//      code, not comments. A bare show() may appear only AFTER the
//      no-activate call (the emergency fallback when the raw Win32 path
//      errors: a degraded visible overlay beats an invisible one);
//   B. the history-wing restore (which runs on the same Ctrl+\ show path)
//      uses the no-activate show on Windows too;
//   C. `win_activation` is wired as a module and registered in the invoke
//      handler (the E2E surface-state probe must exist);
//   D. the `windows` crate dependency carries the two needed Win32 features;
//   E. exactly ONE global-shortcut handler exists (the plugin's with_handler
//      in lib.rs) — a second dispatcher would be an untracked focus path;
//   F. the overlay cursor: the default cursor type is a VISIBLE one (never
//      "invisible"), no load-path fallback coerces a missing setting to
//      "invisible", the one-time migration of the old persisted default
//      exists, and the Rust hide path hands the cursor back to the system
//      (SetCursor arrow) before every overlay/wing hide — the Win32 cursor
//      is a stateful shape and a hidden last-state otherwise stays stale
//      over the region after the hide.
//
// Run with:  node --experimental-strip-types scripts/overlay-focus-check.ts

import { readFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const readRel = (relPath: string): string => {
  try {
    return readFileSync(join(ROOT, relPath), "utf8");
  } catch {
    return "";
  }
};
/** Compare code, not prose: comments legitimately describe the old behavior. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Extract one top-level `fn NAME(...) { ... }` body by brace counting. */
const fnSource = (source: string, name: string): string => {
  const anchor = source.indexOf(`fn ${name}`);
  if (anchor === -1) return "";
  const open = source.indexOf("{", anchor);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(anchor, i + 1);
    }
  }
  return "";
};

const failures: string[] = [];
const assert = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

// --- A. show_main_window: Windows path is non-activating --------------------
{
  const shortcutsCode = code(readRel("src-tauri/src/shortcuts.rs"));
  const fn = fnSource(shortcutsCode, "show_main_window");
  assert(fn.length > 0, "shortcuts.rs: show_main_window not found");
  // The Windows-only block is everything before the not(windows) branch.
  const nonWindowsMarker = fn.indexOf('#[cfg(not(target_os = "windows"))]');
  assert(
    nonWindowsMarker > 0,
    "shortcuts.rs: show_main_window lost its non-Windows branch structure"
  );
  const windowsPart = nonWindowsMarker === -1 ? fn : fn.slice(0, nonWindowsMarker);
  assert(
    windowsPart.includes("show_window_no_activate"),
    "shortcuts.rs: show_main_window's Windows path must call win_activation::show_window_no_activate — a plain show() activates (SW_SHOW) and steals the foreground"
  );
  // The explicit steal is forbidden outright — there is no fallback excuse
  // for SetForegroundWindow on the shortcut path.
  assert(
    !windowsPart.includes("set_focus"),
    "shortcuts.rs: show_main_window's Windows path must not call set_focus — SetForegroundWindow breaks the foreground app's fullscreen"
  );
  // A bare show() is allowed ONLY as a fallback: it must come after the
  // no-activate call (primary path), never replace it.
  const primary = windowsPart.indexOf("show_window_no_activate");
  const plainShow = windowsPart.indexOf("window.show()");
  if (plainShow !== -1) {
    assert(
      plainShow > primary,
      "shortcuts.rs: a bare window.show() on the Windows path must come after show_window_no_activate (fallback only) — as primary it would activate the overlay on every shortcut"
    );
  }
}

// --- B. history wing restore is non-activating on Windows -------------------
{
  const windowCode = code(readRel("src-tauri/src/window.rs"));
  const fn = fnSource(windowCode, "restore_history_wing_with_main");
  assert(fn.length > 0, "window.rs: restore_history_wing_with_main not found");
  const nonWindowsMarker = fn.indexOf('#[cfg(not(target_os = "windows"))]');
  const windowsPart = nonWindowsMarker === -1 ? fn : fn.slice(0, nonWindowsMarker);
  assert(
    windowsPart.includes("show_window_no_activate"),
    "window.rs: restore_history_wing_with_main must surface the wing via show_window_no_activate on Windows — it runs on the Ctrl+\\ show path"
  );
  assert(
    !windowsPart.includes("set_focus"),
    "window.rs: restore_history_wing_with_main must not call set_focus on the Windows path (SetForegroundWindow)"
  );
  const primary = windowsPart.indexOf("show_window_no_activate");
  const plainShow = windowsPart.indexOf("wing.show()");
  if (plainShow !== -1) {
    assert(
      plainShow > primary,
      "window.rs: wing.show() on the Windows path must come after show_window_no_activate (fallback only)"
    );
  }
}

// --- C. module + command wiring ----------------------------------------------
{
  const libCode = code(readRel("src-tauri/src/lib.rs"));
  assert(
    libCode.includes("mod win_activation;"),
    "lib.rs: the win_activation module is not registered"
  );
  assert(
    libCode.includes("win_activation::overlay_surface_state"),
    "lib.rs: overlay_surface_state (the E2E focus/visibility probe) is not registered in the invoke handler"
  );
}

// --- D. windows crate features -----------------------------------------------
{
  const cargo = readRel("src-tauri/Cargo.toml");
  const depMatch = cargo.match(/windows\s*=\s*\{[^}]*\}/);
  assert(
    depMatch !== null,
    "Cargo.toml: the windows crate dependency (win_activation's Win32 calls) is missing"
  );
  const dep = depMatch ? depMatch[0] : "";
  assert(
    dep.includes("Win32_Foundation") && dep.includes("Win32_UI_WindowsAndMessaging"),
    "Cargo.toml: the windows dependency must enable Win32_Foundation + Win32_UI_WindowsAndMessaging (ShowWindow/SetWindowPos/GetForegroundWindow)"
  );
}

// --- E. single global-shortcut dispatcher ------------------------------------
{
  const libCode = code(readRel("src-tauri/src/lib.rs"));
  const handlerCount = (libCode.match(/with_handler/g) ?? []).length;
  assert(
    handlerCount === 1,
    `lib.rs: expected exactly one global-shortcut with_handler, found ${handlerCount} — a second dispatcher would be an untracked shortcut path`
  );
}

// --- F. overlay cursor: visible default, migration, hide-path handoff --------
{
  // The default cursor type must be a VISIBLE one; "invisible" is opt-in.
  const storage = code(readRel("src/lib/storage/customizable.storage.ts"));
  assert(
    /cursor:\s*\{\s*type:\s*"default"\s*\}/.test(storage),
    'customizable.storage.ts: DEFAULT_CUSTOMIZABLE_STATE.cursor.type must be "default" — the "invisible" default set cursor:none in the overlay webview and left a stale hidden cursor over the overlay\'s region after it was hidden'
  );
  assert(
    storage.includes("CURSOR_VISIBLE_DEFAULT_MIGRATION_KEY"),
    "customizable.storage.ts: the one-time migration of the old persisted \"invisible\" default is missing — machines with the old default persisted would keep the hidden cursor"
  );

  // No load-path fallback may coerce a missing setting to "invisible".
  const context = code(readRel("src/contexts/app.context.tsx"));
  assert(
    !context.includes('|| "invisible"'),
    'app.context.tsx: a fallback still coerces the cursor setting to "invisible" — an unset setting must mean the visible default'
  );
  assert(
    context.includes('|| "default"'),
    'app.context.tsx: the unset-setting fallback must resolve to the visible "default" cursor'
  );

  // The hide paths must hand the cursor back to the system before hiding.
  const shortcuts = code(readRel("src-tauri/src/shortcuts.rs"));
  const toggle = fnSource(shortcuts, "handle_toggle_window");
  assert(
    toggle.includes("restore_system_cursor_before_hide"),
    "shortcuts.rs: handle_toggle_window's hide branch must call restore_system_cursor_before_hide — hiding with a hidden last cursor state leaves it stale over the overlay's region"
  );
  const windowRust = code(readRel("src-tauri/src/window.rs"));
  assert(
    fnSource(windowRust, "hide_history_wing_with_main").includes("restore_system_cursor_before_hide") &&
      fnSource(windowRust, "close_history_wing").includes("restore_system_cursor_before_hide"),
    "window.rs: both wing-hide paths must call restore_system_cursor_before_hide"
  );
}

if (failures.length > 0) {
  console.error(`FAIL - overlay focus invariants broken (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  "PASS - overlay shortcuts surface windows without taking the desktop foreground:\n" +
    "       show_main_window + wing restore use SW_SHOWNOACTIVATE/SWP_NOACTIVATE on Windows;\n" +
    "       no activating call survives on the Windows path; one shortcut dispatcher."
);
