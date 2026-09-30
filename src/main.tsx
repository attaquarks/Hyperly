import React from "react";
import ReactDOM from "react-dom/client";
import Overlay from "./components/Overlay";
import { AppProvider, ThemeProvider } from "./contexts";
import "./global.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AppRoutes from "./routes";
import { MicConsentDialog } from "./components/mic-consent/MicConsentDialog";
import { syncMicConsentToBackend } from "./lib/mic-consent";

const logFrontend = (level: string, message: string) => {
  console.log(`[hyperly] ${level}: ${message}`);
  void invoke("log_frontend", { level, message }).catch(() => {});
};

const paintBootFailure = (message: string) => {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="box-sizing:border-box;width:100%;height:100%;padding:18px 20px;color:#f8f8f8;background:rgba(16,16,18,0.96);border:1px solid rgba(255,255,255,0.12);border-radius:14px;font:13px/1.45 Segoe UI,system-ui,sans-serif;">
      <strong style="display:block;margin-bottom:8px;">Hyperly failed to start</strong>
      <span>${message.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string))}</span>
    </div>
  `;
};

window.addEventListener("error", (event) => {
  const where = event.filename
    ? ` @ ${event.filename}:${event.lineno}:${event.colno}`
    : "";
  logFrontend("error", `${event.message}${where}`);
});

window.addEventListener("unhandledrejection", (event) => {
  logFrontend("error", `unhandledrejection ${String(event.reason)}`);
});

try {
  const currentWindow = getCurrentWindow();
  const windowLabel = currentWindow.label;
  logFrontend("info", `webview boot ${windowLabel}`);

  // The Rust consent gate is process state; re-assert the stored decision so
  // the WebView2 handler matches what the user chose in a previous run (R7).
  void syncMicConsentToBackend();

  const rootEl = document.getElementById("root");
  if (!rootEl) {
    throw new Error("#root is missing");
  }

  if (windowLabel.startsWith("capture-overlay-")) {
    const monitorIndex = parseInt(windowLabel.split("-")[2], 10) || 0;
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <Overlay monitorIndex={monitorIndex} />
      </React.StrictMode>
    );
  } else {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <ThemeProvider>
          <AppProvider>
            <AppRoutes />
            <MicConsentDialog />
          </AppProvider>
        </ThemeProvider>
      </React.StrictMode>
    );
  }
} catch (err) {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  logFrontend("error", `boot failed: ${message}`);
  paintBootFailure(message);
}
