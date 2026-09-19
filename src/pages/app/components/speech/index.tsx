import { useState, useCallback, useEffect } from "react";
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  ScrollArea,
} from "@/components";
import {
  HeadphonesIcon,
  AlertCircleIcon,
  LoaderIcon,
  AudioLinesIcon,
  CameraIcon,
  PlusIcon,
  XIcon,
  SunIcon,
  MoonIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ModeSwitcher } from "./ModeSwitcher";
import { RecordingPanel } from "./RecordingPanel";
import { ResultsSection } from "./ResultsSection";
import { PermissionFlow } from "./PermissionFlow";
import { ConversationHistory } from "./ConversationHistory";
import { useSystemAudioType } from "@/hooks";
import { useApp } from "@/contexts";
import { useTheme } from "@/contexts/theme.context";
import { cn } from "@/lib/utils";
import { TranscriptThread } from "./TranscriptThread";
import { ListenControls } from "./ListenControls";

export const SystemAudio = (
  props: useSystemAudioType & { panelVisible?: boolean }
) => {
  const {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    error,
    setupRequired,
    startCapture,
    stopCapture,
    isPopoverOpen,
    setIsPopoverOpen,
    startNewConversation,
    loadConversation,
    conversation,
    resizeWindow,
    vadConfig,
    updateVadConfiguration,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    scrollAreaRef,
    setPendingScreenshot,
    livePartial,
    transcriptSegments,
    listenMode,
    setListenMode,
  } = props;

  // While the user is on the Ask tab, the listen panel stays mounted (so the
  // capture, transcript, and scroll position survive the switch) but its
  // popover content is hidden with CSS. The DOM node remains, which also keeps
  // the window-resize observer from collapsing the overlay mid-capture.
  const panelVisible = props.panelVisible ?? true;

  const { supportsImages } = useApp();
  const { theme, setTheme } = useTheme();

  // Cycle through light -> dark -> system on each click.
  const cycleTheme = useCallback(() => {
    const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    setTheme(next);
  }, [theme, setTheme]);

  // View mode toggle
  const [conversationMode, setConversationMode] = useState(false);

  // Screenshot state — local copy drives the preview UI; the actual base64 is forwarded to
  // the hook via setPendingScreenshot so the next AI call can attach it.
  const [screenshotImage, setScreenshotImage] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  // Conversation-history sidebar visibility. Defaults off so the panel stays compact.
  const [showHistory, setShowHistory] = useState(false);

  const isVadMode = vadConfig.enabled;

  // Keyboard shortcut for Cmd+K to toggle view mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      // Cmd+K or Ctrl+K to toggle view mode
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setConversationMode((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen]);

  // Mirror the local preview into the hook so the next AI call can attach it.
  useEffect(() => {
    setPendingScreenshot(screenshotImage);
  }, [screenshotImage, setPendingScreenshot]);

  // Reset local preview when the hook consumed the pending screenshot (processing started).
  useEffect(() => {
    if (isProcessing && screenshotImage) {
      setScreenshotImage(null);
    }
  }, [isProcessing, screenshotImage]);

  const handleToggleCapture = async () => {
    if (capturing) {
      await stopCapture();
    } else {
      await startCapture();
    }
  };

  const handleModeChange = (vadEnabled: boolean) => {
    updateVadConfiguration({
      ...vadConfig,
      enabled: vadEnabled,
    });

    // Switching to Auto-detect engages listening immediately. Switching back to
    // Manual leaves any in-flight capture alone so the user keeps control.
    if (vadEnabled && !capturing) {
      void startCapture();
    }
  };

  // Capture screenshot functionality
  const handleCaptureScreenshot = useCallback(async () => {
    if (isCapturingScreenshot) return;

    setIsCapturingScreenshot(true);
    try {
      

      // Capture full-screen screenshot. The Rust command is `capture_to_base64`.
      const base64: string = await invoke("capture_to_base64");

      setScreenshotImage(base64);
    } catch (err) {
      console.error("Failed to capture screenshot:", err);
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, [isCapturingScreenshot]);

  const handleRemoveScreenshot = useCallback(() => {
    setScreenshotImage(null);
  }, []);

  const getButtonIcon = () => {
    if (setupRequired) return <AlertCircleIcon className="text-orange-500" />;
    if (error && !setupRequired)
      return <AlertCircleIcon className="text-red-500" />;
    if (isProcessing) return <LoaderIcon className="animate-spin" />;
    if (capturing)
      return <AudioLinesIcon className="text-green-500 animate-pulse" />;
    return <HeadphonesIcon />;
  };

  const getButtonTitle = () => {
    if (setupRequired) return "Setup required - Click for instructions";
    if (error && !setupRequired) return `Error: ${error}`;
    if (isProcessing) return "Transcribing audio...";
    if (capturing) return "Stop system audio capture";
    return "Start system audio capture";
  };

  return (
    <Popover
      open={isPopoverOpen}
      onOpenChange={(open) => {
        if (capturing && !open) {
          return;
        }
        setIsPopoverOpen(open);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="icon"
          title={getButtonTitle()}
          onClick={handleToggleCapture}
          className={cn(
            capturing && "bg-green-50 hover:bg-green-100",
            error && "bg-red-100 hover:bg-red-200"
          )}
        >
          {getButtonIcon()}
        </Button>
      </PopoverTrigger>

      {(capturing || setupRequired || error) && (
        <PopoverContent
          align="end"
          side="bottom"
          className={cn(
            "select-none w-full max-w-[calc(100vw-2rem)] p-0 border shadow-lg overflow-hidden border-input/50",
            !panelVisible && "hidden"
          )}
          sideOffset={8}
        >
          <div className="flex flex-col max-h-[calc(100vh-6rem)] overflow-hidden">
            {/* Header - Mode Switcher + Actions */}
            <div className="flex-shrink-0 p-3 border-b border-border/50">
              <div className="flex items-center justify-between gap-2">
                {/* Mode Switcher */}
                {!setupRequired && (
                  <ModeSwitcher
                    isVadMode={isVadMode}
                    onModeChange={handleModeChange}
                    disabled={
                      isRecordingInContinuousMode ||
                      isProcessing ||
                      isAIProcessing
                    }
                  />
                )}
                {setupRequired && (
                  <h2 className="font-semibold text-sm">Setup Required</h2>
                )}

                {/* Action Buttons */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* Screenshot Button */}
                  {!setupRequired && supportsImages && (
                    <Button
                      size="sm"
                      variant={screenshotImage ? "default" : "outline"}
                      onClick={handleCaptureScreenshot}
                      disabled={isCapturingScreenshot}
                      className={cn(
                        "h-6 text-[10px] gap-1 px-2",
                        screenshotImage && "bg-primary text-primary-foreground"
                      )}
                      title="Capture screenshot to include with transcription"
                    >
                      {isCapturingScreenshot ? (
                        <LoaderIcon className="w-3 h-3 animate-spin" />
                      ) : (
                        <CameraIcon className="w-3 h-3" />
                      )}
                      Screenshot
                    </Button>
                  )}

                  {/* Theme Switcher */}
                  {!setupRequired && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      title={`Theme: ${theme} (click to change)`}
                      onClick={cycleTheme}
                    >
                      {theme === "dark" ? (
                        <MoonIcon className="h-3.5 w-3.5" />
                      ) : theme === "light" ? (
                        <SunIcon className="h-3.5 w-3.5" />
                      ) : (
                        <SunIcon className="h-3.5 w-3.5 opacity-60" />
                      )}
                    </Button>
                  )}

                  {/* History Sidebar Toggle */}
                  {!setupRequired && (
                    <Button
                      size="icon"
                      variant={showHistory ? "default" : "ghost"}
                      className="h-6 w-6"
                      title={
                        showHistory
                          ? "Hide conversation history"
                          : "Show conversation history"
                      }
                      onClick={() => setShowHistory((v) => !v)}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 12h18M3 6h18M3 18h12" />
                      </svg>
                    </Button>
                  )}

                  {/* New Conversation Button */}
                  {!setupRequired && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={startNewConversation}
                      className="h-6 text-[10px] gap-1 px-2"
                      title="Start a new conversation"
                    >
                      <PlusIcon className="w-3 h-3" />
                      New
                    </Button>
                  )}

                  {/* Close Button */}
                  {!capturing && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      title="Close"
                      onClick={() => {
                        setIsPopoverOpen(false);
                        resizeWindow(false);
                      }}
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-1 min-h-0">
              {showHistory && (
                <ConversationHistory
                  loadConversation={loadConversation}
                  activeConversationId={conversation.id}
                />
              )}

              <ScrollArea className="flex-1 min-h-0" ref={scrollAreaRef}>
              <div className="p-2 space-y-2">
                <ListenControls
                  mode={listenMode}
                  onModeChange={setListenMode}
                />
                {/* Screenshot Preview */}
                {screenshotImage && (
                  <div className="flex items-center gap-2 p-2 rounded-lg bg-primary/5 border border-primary/20">
                    <img
                      src={`data:image/png;base64,${screenshotImage}`}
                      alt="Screenshot"
                      className="h-12 w-20 object-cover rounded"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-medium">
                        Screenshot attached
                      </p>
                      <p className="text-[9px] text-muted-foreground">
                        Will be sent with next transcription
                      </p>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5"
                      onClick={handleRemoveScreenshot}
                    >
                      <XIcon className="h-3 w-3" />
                    </Button>
                  </div>
                )}

                <TranscriptThread segments={transcriptSegments} livePartial={livePartial} />

                {/* Error Display */}
                {error && !setupRequired && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 border border-red-200">
                    <AlertCircleIcon className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[10px] font-medium text-red-800">
                        Error
                      </p>
                      <p className="text-[10px] text-red-700">{error}</p>
                    </div>
                  </div>
                )}

                {/* Setup Required - Permission Flow */}
                {setupRequired ? (
                  <PermissionFlow
                    onPermissionGranted={() => {
                      startCapture();
                    }}
                    onPermissionDenied={() => {
                      // Keep showing setup instructions
                    }}
                  />
                ) : (
                  <>
                    {/* Recording Panel */}
                    <RecordingPanel
                      isVadMode={isVadMode}
                      isRecording={isRecordingInContinuousMode}
                      isProcessing={isProcessing}
                      isAIProcessing={isAIProcessing}
                      recordingProgress={recordingProgress}
                      maxDuration={vadConfig.max_recording_duration_secs}
                      onStartRecording={startContinuousRecording}
                      onStopAndSend={manualStopAndSend}
                      onIgnore={ignoreContinuousRecording}
                    />

                    {/* Live running transcript (shown while audio is still being captured
                        and no final transcript has arrived yet). */}
                    {capturing && livePartial && !lastTranscription && (
                      <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                        <div className="flex items-center gap-1.5">
                          <HeadphonesIcon className="w-3.5 h-3.5 text-primary" />
                          <h4 className="text-xs font-medium text-primary">
                            Listening...
                          </h4>
                          <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse ml-1" />
                        </div>
                        <p className="text-xs text-foreground/90 whitespace-pre-wrap leading-relaxed">
                          {livePartial}
                        </p>
                      </div>
                    )}

                    {/* AI Response */}
                    <ResultsSection
                      lastTranscription={lastTranscription}
                      lastAIResponse={lastAIResponse}
                      isAIProcessing={isAIProcessing}
                      conversation={conversation}
                      conversationMode={conversationMode}
                      setConversationMode={setConversationMode}
                    />

                  </>
                )}
              </div>
              </ScrollArea>
            </div>


          </div>
        </PopoverContent>
      )}
    </Popover>
  );
};
export * from "./TranscriptThread";
export * from "./ListenControls";
