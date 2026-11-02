# Hyperly desktop E2E tests

Drives the **actual Windows Tauri binary** (WebView2) through WebDriver —
not a browser stand-in. Built on [WebdriverIO](https://webdriver.io) with
[`@wdio/tauri-service`](https://www.npmjs.com/package/@wdio/tauri-service),
which spawns the app, manages `tauri-driver` (auto-installed via cargo) and
keeps the WebView2 Edge driver version-matched automatically.

## Run locally

```powershell
# 1. Build the app (debug profile is enough for E2E)
npm run build                                  # frontend -> dist/ (embedded at compile time)
cargo build --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol

# 2. Run the suite
npm run test:e2e                # full suite
npm run test:e2e:smoke          # startup-health smoke only
```

Environment overrides (set by CI, optional locally):

- `HYPERLY_BIN` — path to the binary under test (default: `src-tauri/target/debug/hyperly.exe`). The binary must be built
  with `--features tauri/custom-protocol`, or it serves the dev-server URL
  and the webview shows ERR_CONNECTION_REFUSED.
- `E2E_ARTIFACTS_DIR` — where screenshots/failure diagnostics/JUnit XML land (default: `e2e/artifacts`).

## What the smoke suite asserts (startup health)

A spawned process proves nothing. The spec asserts the real readiness
condition:

1. The overlay shell (`.hyperly-overlay-shell`) renders within 60 s.
2. The boot-failure paint ("Hyperly failed to start") is **absent**.
3. The shell occupies non-zero space (not a blank screen).
4. The WebView's JS event loop is advancing (two `performance.now()` probes).
5. Ask → Listen navigation reaches the Listen room (`.hyperly-listen-body`).
6. The app stays responsive after navigation.

Screenshots (`01-startup-main.png` … `04-post-navigation.png`) are saved for
every run; failing tests additionally capture screenshot + page HTML.

## CI

`.github/workflows/desktop-e2e.yml` runs the same suite on `windows-latest`
on every relevant push/PR and manually (`gh workflow run desktop-e2e`).
Artifacts (screenshots, driver + app logs, JUnit XML) upload on **every** run,
green or red.

## Design rules

- Real binary, real WebView2 — browser-based runs are never a substitute.
- No arbitrary sleeps: explicit element waits and readiness conditions only.
- Test code lives entirely in this folder; the app's `package.json` gains no
  E2E dependencies, and no test-only instrumentation ships in production
  builds. (Stage 4's IPC tests will use a cargo feature gate for the
  `tauri-plugin-wdio` pair.)
- The service's log capture (`captureBackendLogs`/`captureFrontendLogs`)
  forwards Rust and frontend logs into the WDIO report — a red run explains
  itself.
