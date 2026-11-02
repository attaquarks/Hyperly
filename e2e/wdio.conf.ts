import type { Options } from "@wdio/types";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactsDir = process.env.E2E_ARTIFACTS_DIR
  ? path.resolve(process.env.E2E_ARTIFACTS_DIR)
  : path.join(here, "artifacts");
fs.mkdirSync(artifactsDir, { recursive: true });

// Binary under test: override with HYPERLY_BIN (CI builds release; local runs
// use the existing debug binary). Relative paths resolve against this file.
const appBinary = process.env.HYPERLY_BIN
  ? path.resolve(process.env.HYPERLY_BIN)
  : path.join(here, "..", "src-tauri", "target", "debug", "hyperly.exe");

if (!fs.existsSync(appBinary)) {
  throw new Error(
    `Hyperly binary not found at ${appBinary}. Build it first: cargo build --manifest-path src-tauri/Cargo.toml`
  );
}

export const config: Options.Testrunner = {
  //
  // ================== Testrunner configuration ==================
  //
  specs: [path.join(here, "test", "**", "*.spec.ts")],
  exclude: [],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinary,
      },
    } as never,
  ],
  logLevel: "info",
  bail: 0,
  baseUrl: "",
  waitforTimeout: 15_000,
  connectionRetryTimeout: 180_000,
  connectionRetryCount: 3,
  services: [
    [
      "@wdio/tauri-service",
      {
        // Embedded provider (the service's default): the WebDriver server
        // runs inside the app via tauri-plugin-wdio-webdriver, compiled in
        // through the `wdio` cargo feature. This bypasses msedgedriver and
        // the DevToolsActivePort attach handshake entirely — which failed on
        // GitHub's Windows runners with the external tauri-driver flow while
        // working locally. E2E builds enable the feature; production never
        // does.
        driverProvider: "embedded",
        captureBackendLogs: true,
        captureFrontendLogs: true,
        startTimeout: 90_000,
        commandTimeout: 60_000,
      },
    ],
  ],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },

  reporters: [
    "spec",
    [
      "junit",
      {
        outputDir: artifactsDir,
        outputFileFormat: () => `junit-e2e.xml`,
      },
    ],
  ],

  onPrepare: () => {
    fs.mkdirSync(artifactsDir, { recursive: true });
  },

  // Diagnostics on failure: full-page screenshot + the page's HTML, saved
  // per-spec so CI artifacts always explain a red run.
  afterTest: async function (test, _context, result) {
    if (result.passed) return;
    const safe = `${test.parent}`.replace(/[^\w.-]+/g, "_") + "--" + `${test.title}`.replace(/[^\w.-]+/g, "_");
    try {
      await browser.saveScreenshot(path.join(artifactsDir, `failure-${safe}.png`));
      const html = await browser.execute(() => document.documentElement.outerHTML);
      fs.writeFileSync(path.join(artifactsDir, `failure-${safe}.html`), String(html));
    } catch (error) {
      // The webview may be dead at this point (crash tests); that fact is
      // itself diagnostic — record it instead of failing the hook.
      fs.writeFileSync(
        path.join(artifactsDir, `failure-${safe}.txt`),
        `diagnostic capture failed: ${String(error)}\n`
      );
    }
  },
};
