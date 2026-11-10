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

  it("toggles the overlay visible WITHOUT taking the desktop foreground", async () => {
    // Regression net for the Windows focus bug: the Ctrl+\ show path used to
    // run show() (SW_SHOW — activates) + unminimize() + set_focus()
    // (SetForegroundWindow), making Hyperly the foreground window — Chrome's
    // fullscreen presentation broke and the taskbar popped back over it.
    // The fix surfaces the overlay via SW_SHOWNOACTIVATE +
    // SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE), so after a toggle-show the
    // overlay MUST be visible while NOT being the foreground window.
    //
    // The toggle is driven through `toggle_main_window`, the same Rust path
    // the shortcut dispatches to (the in-app Hide button shares it on
    // purpose). No synthetic input is used anywhere in this suite.
    //
    // focusMainWindow() is called once BEFORE the toggles and no further
    // handle switching happens afterwards, so the driver cannot interfere
    // with the foreground state the assertions read.
    await focusMainWindow();

    // The overlay must not present a hidden OS cursor: the webview-wide
    // `cursor: none` styling (the old "invisible" DEFAULT) is what left a
    // stale hidden cursor over the overlay's screen region after the overlay
    // was hidden — the Win32 cursor shape is stateful and the foreground app
    // only re-sets it via its own WM_SETCURSOR. A visible default also means
    // the cursor "properly shows up on the overlay" when it is surfaced.
    const computedCursor = await browser.execute(
      () => getComputedStyle(document.body).cursor
    );
    if (computedCursor === "none") {
      throw new Error(
        'overlay webview computes cursor: none — the hidden-cursor default (or its persisted "invisible" state) is back'
      );
    }

    const invokeCommand = (command: string): Promise<unknown> =>
      browser.execute((cmd) => {
        const tauri = (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__;
        return tauri.invoke(cmd);
      }, command);

    // Hide (first press), then show (second press) — exactly one show cycle.
    await invokeCommand("toggle_main_window");
    await browser.pause(400);
    await invokeCommand("toggle_main_window");

    // The show must really have surfaced the window — poll because the
    // command returns after an async dispatch.
    const state = await browser.waitUntil(
      async () => {
        const surface = (await invokeCommand("overlay_surface_state")) as {
          visible: boolean;
          focused: boolean;
        };
        return surface.visible ? surface : false;
      },
      {
        timeout: 10_000,
        timeoutMsg:
          "overlay never became visible after the toggle-show — the no-activate Win32 path failed",
      }
    );
    if (!state || typeof state !== "object") {
      throw new Error("overlay_surface_state returned no state object");
    }

    // THE regression assertion: with the old code this was true — the toggle
    // explicitly stole the foreground. It must now stay with whatever the
    // runner had in the foreground (after the hide, Windows re-activates it;
    // the non-activating show must not take it back).
    if (state.focused) {
      throw new Error(
        "overlay became the foreground window on toggle-show — focus steal is back (SW_SHOW/set_focus on the shortcut path)"
      );
    }

    // The webview must still answer after the hide/show cycle.
    const probe = await browser.execute(() => document.title.length);
    if (typeof probe !== "number") {
      throw new Error("main overlay stopped answering after the toggle cycle");
    }
    await shot("07-toggle-no-focus-steal");
  });

  it("opens and closes the history wing without freezing the app", async () => {
    // Regression net for the Windows deadlock: `open_history_wing` used to be
    // a *synchronous* command that created the wing webview window inline,
    // which deadlocks the Rust main thread on Windows (window creation must
    // pump the event loop that the sync command is blocking). Symptom: the
    // first history click froze the whole overlay. If it regresses, the wing
    // window never appears AND the main overlay stops answering — the waits
    // below catch both facts.
    await focusMainWindow();
    await $(".hyperly-tab:nth-child(2)").click();
    await $(".hyperly-listen-body").waitForExist({ timeout: 20_000 });
    // useTitles() strips every `title` attribute from the DOM ~100 ms after
    // mount (moves it to data-original-title), so title-based selectors can
    // never match. The button carries a data-testid that survives, and its
    // React-controlled `hyperly-action-active` class is the open-state proof.
    const historyToggle = () => $('[data-testid="listen-history-toggle"]');
    await historyToggle().waitForExist({
      // Generous: each Listen remount re-probes the audio stack, and on a
      // runner with no audio devices that path is slow.
      timeout: 60_000,
      timeoutMsg: "Listen room rendered but the history toolbar button did not",
    });

    const mainHandle = await browser.getWindowHandle();
    await historyToggle().click();
    // The click handler flips this React class synchronously — the wing
    // window appearing is the Rust-side proof, this is the JS-side one.
    const activeAfterOpen = await browser.execute(
      () => document.querySelector('[data-testid="listen-history-toggle"]')?.classList.contains("hyperly-action-active") ?? false
    );
    if (!activeAfterOpen) {
      throw new Error("history toggle did not light up after opening the wing");
    }

    // The wing is its own webview window loading index.html; the dashboard
    // (the other non-main handle) loads /chats, so filter it out.
    const wingHandle = await browser.waitUntil(
      async () => {
        for (const handle of await browser.getWindowHandles()) {
          if (handle === mainHandle) continue;
          await browser.switchToWindow(handle);
          if (!(await browser.getUrl()).includes("/chats")) return handle;
        }
        return false;
      },
      {
        timeout: 20_000,
        timeoutMsg:
          "history wing window never appeared — open_history_wing deadlocked or failed",
      }
    );
    if (typeof wingHandle !== "string") {
      throw new Error("history wing handle missing");
    }

    await $(".hyperly-wing-shell").waitForExist({
      timeout: 20_000,
      timeoutMsg: "wing window opened but the history UI never rendered",
    });
    const aliveFirst = await browser.execute(() => performance.now());
    await browser.pause(150);
    const aliveSecond = await browser.execute(() => performance.now());
    if (!(aliveSecond > aliveFirst)) {
      throw new Error("history wing webview is not responsive");
    }
    await shot("05-history-wing");

    // Close from the wing's own button: it hides the wing and emits
    // "history-wing-closed", which clears the Listen toggle's React class —
    // asserting that clears proves the Rust→JS event round-trip.
    await $(".hyperly-wing-close").click();
    await browser.switchToWindow(mainHandle);
    await browser.waitUntil(
      async () =>
        !(await browser.execute(
          () => document.querySelector('[data-testid="listen-history-toggle"]')?.classList.contains("hyperly-action-active") ?? true
        )),
      {
        timeout: 10_000,
        timeoutMsg:
          "main overlay never acknowledged the wing closing (history-wing-closed event lost)",
      }
    );

    // And the main overlay must still be alive after the whole dance.
    const probe = await browser.execute(() => document.title.length);
    if (typeof probe !== "number") {
      throw new Error("main overlay stopped answering after the history wing round-trip");
    }
    await shot("06-history-wing-closed");
  });
});
