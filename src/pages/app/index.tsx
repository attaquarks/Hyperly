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
import { useEffect, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { ErrorLayout } from "@/layouts";
import { getPlatform } from "@/lib";

const App = () => {
  const { isHidden, systemAudio } = useApp();
  const { customizable } = useAppContext();
  const platform = getPlatform();
  const [mode, setMode] = useState<OverlayMode>("ask");

  useEffect(() => {
    if (systemAudio?.capturing) {
      setMode("listen");
    }
  }, [systemAudio?.capturing]);

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
        <Card className="w-full border-0 bg-transparent p-0 shadow-none overflow-hidden">
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
            <div className="flex flex-row items-center gap-2 p-2">
              {mode === "listen" ? <SystemAudio {...systemAudio} /> : null}
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
                className={`${
                  systemAudio?.capturing
                    ? "hidden w-full fade-out transition-all duration-300"
                    : "w-full flex flex-row gap-2 items-center"
                }`}
              >
                {mode === "ask" ? <Completion isHidden={isHidden} /> : null}
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
