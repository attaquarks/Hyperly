import path from "node:path";
import fs from "node:fs";

/**
 * Startup health (the highest-priority check, per the testing mandate):
 * a spawned process proves nothing — these tests assert the REAL readiness
 * condition: the actual interface renders, the webview's JS is alive, and
 * navigation works. Every captured screenshot lands in the artifacts dir.
 */
const artifactsDir = process.env.E2E_ARTIFACTS_DIR
  ? path.resolve(process.env.E2E_ARTIFACTS_DIR)
  : path.resolve(import.meta.dirname ?? ".", "..", "artifacts");

const shot = async (name: string): Promise<void> => {
  fs.mkdirSync(artifactsDir, { recursive: true });
  await browser.saveScreenshot(path.join(artifactsDir, `${name}.png`));
};

/**
 * The app pre-creates the dashboard window at startup, and the WebView2
 * driver can attach to either webview. Route the session to the main overlay
 * by URL: it loads index.html at the origin root; the dashboard loads /chats.
 */
const focusMainWindow = async (): Promise<void> => {
  const handles = await browser.getWindowHandles();
  for (const handle of handles) {
    await browser.switchToWindow(handle);
    const url = await browser.getUrl();
    if (!url.includes("/chats")) return;
  }
  throw new Error(
    `main overlay window not found among ${handles.length} webview handle(s)`
  );
};

describe("Hyperly startup health", () => {
  it("launches into the real interface, not a boot failure or blank shell", async () => {
    await focusMainWindow();
    // The overlay chrome is the app's root component. If the WebView booted
    // but React crashed, main.tsx paints "Hyperly failed to start" instead —
    // both conditions must be distinguishable.
    const shell = await $(".hyperly-overlay-shell");
    await shell.waitForExist({ timeout: 60_000, timeoutMsg:
      "the overlay shell never rendered — startup hang, crash, or boot-failure paint" });

    const pageSource = await browser.execute(() => document.documentElement.outerHTML);
    if (/Hyperly failed to start/.test(pageSource)) {
      const text = await browser.execute(() => document.body.innerText);
      throw new Error(`boot-failure paint is present: ${String(text).slice(0, 500)}`);
    }

    const wordmark = await $(".hyperly-wordmark");
    await expect(wordmark).toHaveText(expect.stringContaining("Hyperly"));

    // The shell must actually occupy the window — a zero-size shell is a
    // blank screen in disguise.
    const size = await shell.getSize();
    if (!size.width || !size.height) {
      throw new Error(`overlay shell rendered with zero size: ${JSON.stringify(size)}`);
    }

    await shot("01-startup-main");
  });

  it("has a live webview JS runtime after initialization", async () => {
    // A hung event loop renders fine but stops answering — execute() would
    // time out. Timestamps differ between two calls, proving the loop runs.
    const first = await browser.execute(() => performance.now());
    await browser.pause(150);
    const second = await browser.execute(() => performance.now());
    if (!(second > first)) {
      throw new Error("webview JS event loop is not advancing — unresponsive WebView");
    }
  });

  it("navigates Ask to Listen and reaches the Listen room ready state", async () => {
    // The header nav is a static two-button group: [Ask, Listen].
    await $(".hyperly-tab:nth-child(2)").click();

    // The Listen room is the real work surface: transcript sections, toolbar,
    // footer. Its presence is the "usable and ready" condition for Listen.
    const listenBody = await $(".hyperly-listen-body");
    await listenBody.waitForExist({ timeout: 20_000, timeoutMsg:
      "Listen tab opened but the Listen room never rendered" });
    await shot("02-listen-room");

    await $(".hyperly-tab:first-child").click();
    await $(".hyperly-overlay-content").waitForExist({ timeout: 10_000 });
    await shot("03-ask-view");
  });

  it("stays responsive after navigation (no post-init hang)", async () => {
    // Round-trip once more and re-verify the JS runtime; this is the check
    // that catches "opens fine, then freezes" regressions.
    await $(".hyperly-tab:nth-child(2)").click();
    await $(".hyperly-listen-body").waitForExist({ timeout: 20_000 });
    await $(".hyperly-tab:first-child").click();
    const probe = await browser.execute(() => document.title.length);
    if (typeof probe !== "number") {
      throw new Error("webview stopped answering commands after navigation");
    }
    await shot("04-post-navigation");
  });
});
