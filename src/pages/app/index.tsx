import { Card, Updater, CustomCursor } from "@/components";
import {
  SystemAudio,
  Completion,
  OverlayChrome,
  OverlayMode,
} from "./components";
import { useApp } from "@/hooks";
import { useApp as useAppContext } from "@/contexts";
import { useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform } from "@/lib";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const App = () => {
  // Declared before `useApp` so the active panel can be passed into it: Listen
  // binds Space for capture, Ask binds it for push-to-talk, and the two must
  // not cross-trigger.
  const [mode, setMode] = useState<OverlayMode>("ask");
  const { isHidden, systemAudio } = useApp({ listenActive: mode === "listen" });
  const { customizable } = useAppContext();
  const platform = getPlatform();

  // Mode is user-controlled via the header tabs. The only automatic switch is
  // INTO listen mode the moment a capture starts (e.g. via the global
  // shortcut), so the transcript panel becomes visible. Nothing ever switches
  // back out automatically, and both panels stay mounted in every mode, so
  // switching tabs mid-capture neither collapses the overlay nor interrupts
  // the capture.
  const prevCapturingRef = useRef(false);
  useEffect(() => {
    const capturing = !!systemAudio?.capturing;
    if (capturing && !prevCapturingRef.current) {
      setMode("listen");
    }
    prevCapturingRef.current = capturing;
  }, [systemAudio?.capturing]);

  // Mirror of the capture state for the shortcut listener below — event
  // callbacks registered once on mount can't read fresh state directly.
  const capturingRef = useRef(false);
  useEffect(() => {
    capturingRef.current = !!systemAudio?.capturing;
  }, [systemAudio?.capturing]);

  // Global-shortcut events pull the overlay onto the tab they act on, so a
  // shortcut fired while the other tab is active never takes effect
  // invisibly: the mic and the screenshot flow are Ask-side actions, and the
  // system-audio toggle belongs to Listen (capture start also switches via
  // the effect above — this covers the setup-required path where capture
  // never starts). focus-text-input is the one event that deliberately does
  // NOT switch rooms: its whole job is landing on Ask's composer (D5), so it
  // fires a dedicated DOM event the Ask panel listens for instead of going
  // through the room switch. The mid-capture exception stays: toggle-window
  // emits focus-text-input on every show, and it must not yank the user off
  // the live transcript — a running capture keeps its transcript.
  useEffect(() => {
    const modeForEvent: Array<[string, OverlayMode]> = [
      ["start-audio-recording", "ask"],
      ["trigger-screenshot", "ask"],
      ["toggle-system-audio", "listen"],
    ];
    const unlistens = modeForEvent.map(([event, nextMode]) =>
      listen(event, () => {
        setMode(nextMode);
      })
    );
    unlistens.push(
      listen("focus-text-input", () => {
        if (capturingRef.current) return;
        setMode("ask");
        // Fire after the room switch commits, so the composer exists when
        // the Ask panel's listener runs. Retried a few times: the panel may
        // still be mounting on a cold switch.
        let attempts = 0;
        const tick = () => {
          attempts += 1;
          window.dispatchEvent(new CustomEvent("hyperly:focus-ask-input"));
          if (attempts < 5) setTimeout(tick, 60);
        };
        setTimeout(tick, 60);
      })
    );
    return () => {
      unlistens.forEach((unlisten) => {
        unlisten.then((fn) => fn());
      });
    };
  }, []);

  return (
    <ErrorBoundary
      fallbackRender={({ error }) => {
        return <ErrorLayout isCompact error={error} />;
      }}
      resetKeys={["app-error", mode]}
      onError={(error, info) => {
        const message = `${error?.message || error}\n${error?.stack || ""}\n${info?.componentStack || ""}`;
        console.error("[hyperly] overlay render failed", error, info);
        void invoke("log_frontend", {
          level: "error",
          message: `overlay render failed: ${message}`,
        }).catch(() => {});
      }}
      onReset={() => {
        // no-op
      }}
    >
      <div
        className={`w-screen h-screen flex overflow-hidden justify-center items-start ${
          isHidden ? "hidden pointer-events-none" : ""
        }`}
      >
        <Card className="w-full max-h-screen border-0 bg-transparent p-0 shadow-none overflow-hidden flex flex-col">
          <OverlayChrome
            mode={mode}
            onModeChange={setMode}
            status={
              systemAudio?.isAIProcessing
                ? "Answering..."
                : systemAudio?.capturing
                ? "Listening"
                : "Ready"
            }
            statusTone={
              systemAudio?.isAIProcessing
                ? "working"
                : systemAudio?.capturing
                ? "active"
                : "ready"
            }
          >
            <div className="flex flex-col min-h-0 flex-1 overflow-hidden">
              {/* Both panels stay MOUNTED in every mode — tab switches only hide
                  them with CSS, so switching tabs mid-capture neither unmounts
                  the listen panel nor interrupts the capture. Capture status
                  lives in the header status dot, so no separate visualizer row
                  is needed in the body. */}
              <div
                className={
                  mode === "listen"
                    ? "flex flex-col min-h-0 flex-1 overflow-hidden"
                    : "hidden"
                }
              >
                <ErrorBoundary
                  fallbackRender={({ error }) => (
                    <ErrorLayout isCompact error={error} />
                  )}
                  onError={(error, info) => {
                    void invoke("log_frontend", {
                      level: "error",
                      message: `listen panel failed: ${error?.message || error}\n${info?.componentStack || ""}`,
                    }).catch(() => {});
                  }}
                >
                  <SystemAudio {...systemAudio} />
                </ErrorBoundary>
              </div>
              <div
                className={
                  mode === "ask"
                    ? "flex flex-col min-h-0 flex-1 overflow-hidden"
                    : "hidden"
                }
              >
                <ErrorBoundary
                  fallbackRender={({ error }) => (
                    <ErrorLayout isCompact error={error} />
                  )}
                  onError={(error, info) => {
                    void invoke("log_frontend", {
                      level: "error",
                      message: `ask panel failed: ${error?.message || error}\n${info?.componentStack || ""}`,
                    }).catch(() => {});
                  }}
                >
                  <Completion
                    isHidden={isHidden || mode !== "ask"}
                    capturing={!!systemAudio?.capturing}
                  />
                </ErrorBoundary>
              </div>
            </div>
          </OverlayChrome>
          <Updater />
        </Card>
        {customizable?.cursor?.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
