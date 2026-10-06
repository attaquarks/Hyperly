import { lazy, Suspense, useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { HistoryIcon, PlusIcon, XIcon } from "lucide-react";
import { ErrorBoundary } from "react-error-boundary";
import { ResultsSection } from "./ResultsSection";
import { PermissionFlow } from "./PermissionFlow";
import { ConversationHistory } from "./ConversationHistory";
import { TranscriptThread } from "./TranscriptThread";
import { ListenControls } from "./ListenControls";
import { FollowUps } from "./FollowUps";
import { ListenActionRow } from "./ListenActionRow";
import { ListeningBar } from "./ListeningBar";
import { ListenFooter } from "./ListenFooter";
import {
  useSystemAudioType,
  useVoiceSensitivity,
  useGlobalShortcuts,
} from "@/hooks";
import { useApp } from "@/contexts";
import { cn } from "@/lib/utils";

// Keep onnxruntime / vad-web off the overlay's first-paint graph. A failed
// VAD module used to take the entire React tree down before the shell painted.
const ListenUserMic = lazy(() =>
  import("./ListenUserMic").then((mod) => ({ default: mod.ListenUserMic }))
);

// The Listen room: a fixed stack of hairline-separated sections, each with
// its own scroll — mode toolbar, capture control, transcript (with the
// history overlay), suggested answer, follow-ups, the
// Capture/Selection/Attach/Library action row, and the footer with the two
// sizes. No card blocks, no global scroll.
export const SystemAudio = (props: useSystemAudioType) => {
  const {
    capturing,
    isProcessing,
    isAIProcessing,
    lastAIResponse,
    error,
    setupRequired,
    startCapture,
    startSessionCapture,
    manualStopAndSend,
    startNewConversation,
    loadConversation,
    conversation,
    setPendingScreenshots,
    livePartial,
    userMicPartial,
    setUserMicPartial,
    micWithSystem,
    setMicWithSystem,
    // Labels the transcript row AND routes the words to the AI, so this is the
    // handler the browser mic's `onUtterance` must use.
    submitUserUtterance,
    setError,
    transcriptSegments,
    listenMode,
    setListenMode,
    quickActions,
    handleQuickActionClick,
    addQuickAction,
    captureBehavior,
    setCaptureBehavior,
    suggestedFollowUps,
    knowledgeFolderName,
    knowledgeFolderFiles,
    knowledgeFile,
    isKnowledgeReading,
    knowledgeReadError,
    pickKnowledgeFolder,
    selectKnowledgeFile,
    clearKnowledgeFile,
  } = props;

  const { selectedAudioDevices } = useApp();
  // Drives the mic remount key below, so a sensitivity change made on the Audio
  // Settings page reaches the VAD (see `useVoiceSensitivity`).
  const voiceSensitivity = useVoiceSensitivity();
  // D10: Listen registers its own screenshot callback for the global shortcut
  // (see the effect after `handleCapture` below).
  const globalShortcuts = useGlobalShortcuts();

  // Chat history overlays the transcript area; the transcript keeps running
  // behind it and the overlay closes on pick or re-click.
  const [showHistory, setShowHistory] = useState(false);
  const [transcriptCollapsed, setTranscriptCollapsed] = useState(false);

  // Screenshot state — the local previews mirror into the hook so the next
  // AI call attaches them. D11: an ARRAY, same behaviour as the Ask panel's
  // attached files — each capture appends, so a second screenshot no longer
  // replaces the first; every thumbnail stays visible with its own remove
  // button, and the whole batch rides on the next AI call.
  const [screenshotImages, setScreenshotImages] = useState<string[]>([]);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  // One-shot listener for region captures, so a cancelled selection can't
  // swallow a later Ask-side capture.
  const regionUnlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setPendingScreenshots(screenshotImages);
  }, [screenshotImages, setPendingScreenshots]);

  // Clear the local previews once the hook consumed the shots.
  useEffect(() => {
    if (isProcessing && screenshotImages.length > 0) {
      setScreenshotImages([]);
    }
  }, [isProcessing, screenshotImages]);

  useEffect(
    () => () => {
      regionUnlistenRef.current?.();
    },
    []
  );

  // Start/Stop toggle. Deliberately the same two calls the spacebar listener
  // makes, so the button and the key are interchangeable and neither wipes the
  // session: `startSessionCapture` joins the conversation already on screen and
  // `manualStopAndSend` stops without tearing down. The full reset lives behind
  // the separate "New" button in the toolbar.
  const handleToggleCapture = async () => {
    if (!capturing) {
      await startSessionCapture();
      return;
    }
    await manualStopAndSend();
  };

  const handleCapture = useCallback(async () => {
    if (isCapturingScreenshot) return;
    setIsCapturingScreenshot(true);
    try {
      const base64: string = await invoke("capture_to_base64");
      setScreenshotImages((prev) => [...prev, base64]);
    } catch (err) {
      console.error("Failed to capture screenshot:", err);
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, [isCapturingScreenshot]);

  // D10: Listen's own callback for the global screenshot shortcut. The old code
  // registered Ask's `captureScreenshot` for every `trigger-screenshot`, so a
  // shot taken while Listen was visible ran Ask's pipeline and landed on Ask —
  // Listen's action row was the only way to reach this path. Register Listen's
  // full-screen capture (`capture_to_base64` -> `setScreenshotImages` -> the
  // `pendingScreenshot` flow the thumbnail strip shows at the bottom) so the
  // shot attaches to the room that was visible. Re-registered whenever
  // `handleCapture` changes identity, so the slot always points at the live
  // handler. Ask keeps its own gate (`screenshotInitiatedByThisContext`), so a
  // capture started by one room cannot be swallowed by the other.
  useEffect(() => {
    globalShortcuts.registerListenScreenshotCallback(handleCapture);
  }, [globalShortcuts.registerListenScreenshotCallback, handleCapture]);

  const handleCaptureRegion = useCallback(async () => {
    try {
      const unlisten = await listen<string>("captured-selection", (event) => {
        setScreenshotImages((prev) => [...prev, event.payload]);
        regionUnlistenRef.current?.();
        regionUnlistenRef.current = null;
      });
      regionUnlistenRef.current = unlisten;
      // A cancelled selection never fires the event — expire the listener so
      // it can't consume a later capture from the Ask room.
      setTimeout(() => {
        if (regionUnlistenRef.current === unlisten) {
          unlisten();
          regionUnlistenRef.current = null;
        }
      }, 60000);
      await invoke("start_screen_capture");
    } catch (err) {
      console.error("Failed to start region capture:", err);
      regionUnlistenRef.current?.();
      regionUnlistenRef.current = null;
    }
  }, []);

  // Listen-side Attach: the first picked image rides the pending-screenshot
  // path, same as a capture.
  const handleAttach = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setScreenshotImages((prev) => [...prev, result.split(",")[1] ?? ""]);
    };
    reader.readAsDataURL(file);
  }, []);

  return (
    <div className="hyperly-listen-body">
      <ErrorBoundary
        fallbackRender={() => null}
        onError={(micError) => {
          const message =
            micError instanceof Error ? micError.message : String(micError);
          console.error("[hyperly] listen mic failed to load", micError);
          void invoke("log_frontend", {
            level: "error",
            message: `listen mic failed to load: ${message}`,
          }).catch(() => {});
        }}
      >
        <Suspense fallback={null}>
          <ListenUserMic
            key={selectedAudioDevices.input?.id ?? "default"}
            capturing={capturing && micWithSystem}
            sensitivity={voiceSensitivity}
            onPartial={setUserMicPartial}
            onUtterance={submitUserUtterance}
            onError={setError}
          />
        </Suspense>
      </ErrorBoundary>
      {setupRequired ? (
        <div className="hyperly-section">
          <PermissionFlow
            onPermissionGranted={() => {
              startCapture();
            }}
            onPermissionDenied={() => {
              // Keep showing setup instructions
            }}
          />
        </div>
      ) : (
        <>
          {/* Mode toolbar: prompt pills + history/new chat on the right */}
          <div className="hyperly-section">
            <div className="hyperly-listen-toolbar">
              <div className="flex-1 min-w-0">
                <ListenControls mode={listenMode} onModeChange={setListenMode} />
              </div>
              <div className="hyperly-listen-toolbar-actions">
                <button
                  type="button"
                  className={cn(
                    "hyperly-action",
                    showHistory && "hyperly-action-active"
                  )}
                  title={
                    showHistory
                      ? "Hide conversation history"
                      : "Show conversation history"
                  }
                  onClick={() => {
                    setTranscriptCollapsed(false);
                    setShowHistory((v) => !v);
                  }}
                >
                  <HistoryIcon className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className="hyperly-action"
                  onClick={startNewConversation}
                  title="Start a new conversation"
                >
                  <PlusIcon className="h-3 w-3" />
                  New
                </button>
              </div>
            </div>
          </div>

          <ListeningBar
            capturing={capturing}
            isProcessing={isProcessing}
            behavior={captureBehavior}
            onBehaviorChange={setCaptureBehavior}
            onToggleCapture={() => void handleToggleCapture()}
          />

          {/* Transcript, with chat history overlaid on top */}
          <TranscriptThread
            segments={transcriptSegments}
            livePartial={livePartial}
            userPartial={userMicPartial}
            micWithSystem={micWithSystem}
            onToggleMic={() => setMicWithSystem(!micWithSystem)}
            collapsed={transcriptCollapsed}
            onToggleCollapsed={() => setTranscriptCollapsed((v) => !v)}
          >
            {showHistory && (
              <div className="hyperly-history-overlay">
                <ConversationHistory
                  loadConversation={loadConversation}
                  activeConversationId={conversation.id}
                  onClose={() => setShowHistory(false)}
                  className="w-full flex-1 border-r-0 bg-transparent"
                />
              </div>
            )}
          </TranscriptThread>

          {error && (
            <div className="hyperly-section">
              <div className="hyperly-error">
                <strong>Error:</strong> {error}
              </div>
            </div>
          )}

          <ResultsSection
            lastAIResponse={lastAIResponse}
            isAIProcessing={isAIProcessing}
            conversation={conversation}
          />

          <FollowUps
            quickActions={quickActions}
            suggestions={suggestedFollowUps}
            disabled={isProcessing || isAIProcessing}
            onAction={(action) => void handleQuickActionClick(action)}
            onAddCustom={addQuickAction}
          />

          {/* Action row: Capture / Selection / Attach / Library + file dropdown */}
          <div className="hyperly-section">
            <ListenActionRow
              isCapturing={isCapturingScreenshot}
              onCapture={() => void handleCapture()}
              onCaptureRegion={() => void handleCaptureRegion()}
              onAttach={handleAttach}
              folderName={knowledgeFolderName}
              folderFiles={knowledgeFolderFiles}
              selectedFileName={knowledgeFile?.name}
              isReading={isKnowledgeReading}
              onPickFolder={pickKnowledgeFolder}
              onSelectFile={(name) => void selectKnowledgeFile(name)}
            />
            {screenshotImages.length > 0 && (
              <div className="hyperly-thumb-strip mt-2">
                {screenshotImages.map((image, index) => (
                  <span className="relative" key={`${index}:${image.length}`}>
                    <img
                      src={`data:image/png;base64,${image}`}
                      alt="Screenshot"
                      className="hyperly-thumb"
                    />
                    <button
                      type="button"
                      className="hyperly-thumb-remove"
                      onClick={() =>
                        setScreenshotImages((prev) =>
                          prev.filter((_, i) => i !== index)
                        )
                      }
                      title="Remove screenshot"
                    >
                      <XIcon className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
                <span className="text-[9px] text-muted-foreground">
                  Sent with the next prompt
                </span>
              </div>
            )}
            {knowledgeFile && (
              <p className="hyperly-knowledge-note flex items-center gap-1 px-0">
                <span className="truncate">
                  {knowledgeFile.name} · knowledge in this prompt
                  {knowledgeFile.truncated ? " (truncated)" : ""}
                </span>
                <button
                  type="button"
                  className="hyperly-icon-btn"
                  onClick={clearKnowledgeFile}
                  title="Remove knowledge file"
                >
                  <XIcon className="size-3" />
                </button>
              </p>
            )}
            {knowledgeReadError && (
              <p className="hyperly-knowledge-note px-0">{knowledgeReadError}</p>
            )}
          </div>

          <ListenFooter />
        </>
      )}
    </div>
  );
};
export * from "./TranscriptThread";
export * from "./ListenControls";
