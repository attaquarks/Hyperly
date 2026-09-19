import { Card, Updater, CustomCursor } from "@/components";
import {
  SystemAudio,
  Completion,
  AudioVisualizer,
  StatusIndicator,
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

const App = () => {
  const { isHidden, systemAudio } = useApp();
  const { customizable } = useAppContext();
  const platform = getPlatform();
  const [mode, setMode] = useState<OverlayMode>("ask");

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
  // never starts). The exception is focus-text-input mid-capture:
  // toggle-window emits it on every show, and it must not yank the user off
  // the live transcript.
  useEffect(() => {
    const modeForEvent: Array<[string, OverlayMode]> = [
      ["start-audio-recording", "ask"],
      ["trigger-screenshot", "ask"],
      ["toggle-system-audio", "listen"],
      ["focus-text-input", "ask"],
    ];
    const unlistens = modeForEvent.map(([event, nextMode]) =>
      listen(event, () => {
        if (event === "focus-text-input" && capturingRef.current) return;
        setMode(nextMode);
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
      fallbackRender={() => {
        return <ErrorLayout isCompact />;
      }}
      resetKeys={["app-error"]}
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
            <div className="flex flex-row items-start gap-2 p-2 min-h-0 flex-1 overflow-hidden">
              {/* Both panels stay MOUNTED in every mode — tab switches only hide
                  them with CSS. Unmounting the listen panel on a tab switch used
                  to destroy its popover, which the window-resize observer read as
                  "nothing open" and snapped the overlay back to the top bar while
                  the capture kept running invisibly. */}
              <div className={mode === "listen" ? "" : "hidden"}>
                <SystemAudio {...systemAudio} panelVisible={mode === "listen"} />
              </div>
              {systemAudio?.capturing ? (
                <div className="flex flex-row items-center gap-2 justify-between w-full">
                  <div className="flex flex-1 items-center gap-2">
                    <AudioVisualizer isRecording={systemAudio?.capturing} />
                  </div>
                  <div className="flex !w-fit items-center gap-2">
                    <StatusIndicator
                      setupRequired={systemAudio.setupRequired}
                      error={systemAudio.error}
                      isProcessing={systemAudio.isProcessing}
                      isAIProcessing={systemAudio.isAIProcessing}
                      capturing={systemAudio.capturing}
                    />
                  </div>
                </div>
              ) : null}

              <div
                className={`w-full flex flex-row gap-2 items-center transition-opacity duration-200 ${
                  mode !== "ask" ? "hidden" : ""
                }`}
              >
                <Completion
                  isHidden={isHidden || mode !== "ask"}
                  capturing={!!systemAudio?.capturing}
                />
              </div>
            </div>
          </OverlayChrome>
          <Updater />
        </Card>
        {customizable.cursor.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
