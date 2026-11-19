import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CameraIcon,
  HistoryIcon,
  LibraryIcon,
  Loader2,
  MousePointer2Icon,
  PaperclipIcon,
} from "lucide-react";
import { UseCompletionReturn } from "@/types";
import { MAX_FILES } from "@/config";
import { useApp } from "@/contexts";
import { cn } from "@/lib/utils";
import { PushToTalk } from "./PushToTalk";

type Props = UseCompletionReturn;

// The Ask action row: the Library wing button at the far LEFT (the history
// wing's twin opens top-left and owns folder picking + the file list), then
// Push to talk, full-screen Capture, region Selection, and image Attach —
// with the History button at the far RIGHT (Ask's chat history lives on the
// dashboard, which opens straight onto the chats page). The old folder
// dropdown is gone — the wing replaces it.
//
// History is gone — it duplicated what the overlay header's conversation
// control does. The "Use image" toggle is gone too: captured images land in the
// composer strip automatically and are sent unless removed there.
export const ActionRow = (props: Props) => {
  const {
    attachedFiles,
    isLoading,
    isScreenshotLoading,
    captureFullScreen,
    captureRegion,
    handleFileSelect,
    enableVAD,
    setEnableVAD,
  } = props;

  const { supportsImages } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The library wing's open state, mirroring the Listen toolbar's history/
  // library buttons: lit while the wing is open, un-lit when it closes itself.
  const [showLibrary, setShowLibrary] = useState(false);
  useEffect(() => {
    const unlisten = listen("library-wing-closed", () => {
      setShowLibrary(false);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const captureDisabled =
    !supportsImages ||
    isLoading ||
    isScreenshotLoading ||
    (attachedFiles?.length ?? 0) >= MAX_FILES;

  return (
    <div className="hyperly-action-row">
      <button
        type="button"
        className={cn("hyperly-action", showLibrary && "hyperly-action-active")}
        data-testid="ask-library-toggle"
        title={
          showLibrary
            ? "Hide the knowledge library"
            : "Show the knowledge library"
        }
        onClick={() => {
          if (showLibrary) {
            void invoke("close_library_wing");
            setShowLibrary(false);
          } else {
            void invoke("open_library_wing");
            setShowLibrary(true);
          }
        }}
      >
        <LibraryIcon className="h-3 w-3" />
      </button>
      <PushToTalk enableVAD={enableVAD} setEnableVAD={setEnableVAD} />

      <button
        type="button"
        className="hyperly-action"
        disabled={captureDisabled}
        onClick={() => void captureFullScreen()}
        title="Capture the full screen"
      >
        {isScreenshotLoading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <CameraIcon className="h-3 w-3" />
        )}
        Capture
      </button>
      <button
        type="button"
        className="hyperly-action"
        disabled={captureDisabled}
        onClick={() => void captureRegion()}
        title="Drag to capture a screen region"
      >
        <MousePointer2Icon className="h-3 w-3" />
        Selection
      </button>
      <button
        type="button"
        className="hyperly-action"
        disabled={isLoading || !supportsImages}
        onClick={() => fileInputRef.current?.click()}
        title={
          supportsImages
            ? "Attach images"
            : "Image upload not supported by current AI provider"
        }
      >
        <PaperclipIcon className="h-3 w-3" />
        Attach
        {(attachedFiles?.length ?? 0) > 0 && (
          <span className="hyperly-action-badge">
            {attachedFiles?.length ?? 0}
          </span>
        )}
      </button>
      <button
        type="button"
        className="hyperly-action ml-auto"
        onClick={() => void invoke("open_dashboard")}
        title="Open chat history"
      >
        <HistoryIcon className="h-3 w-3" />
        History
      </button>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />
    </div>
  );
};
