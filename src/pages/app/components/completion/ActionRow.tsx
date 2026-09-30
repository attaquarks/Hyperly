import { useRef } from "react";
import {
  CameraIcon,
  ChevronDownIcon,
  LibraryIcon,
  Loader2,
  MousePointer2Icon,
  PaperclipIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components";
import { UseCompletionReturn } from "@/types";
import { MAX_FILES } from "@/config";
import { useApp } from "@/contexts";
import { PushToTalk } from "./PushToTalk";

type Props = UseCompletionReturn;

// The Ask action row: Push to talk first, then full-screen Capture, region
// Selection, image Attach, and the Library (pick a folder, then pick one file
// from it to ride the next prompt as knowledge), followed by the knowledge
// folder/model dropdown.
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
    knowledgeFolderName,
    knowledgeFolderFiles,
    knowledgeFile,
    isKnowledgeReading,
    pickKnowledgeFolder,
    selectKnowledgeFile,
  } = props;

  const { supportsImages, selectedAIProvider } = useApp();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const modelName =
    selectedAIProvider.variables?.MODEL ??
    selectedAIProvider.variables?.model ??
    selectedAIProvider.provider ??
    "";

  const captureDisabled =
    !supportsImages ||
    isLoading ||
    isScreenshotLoading ||
    (attachedFiles?.length ?? 0) >= MAX_FILES;

  return (
    <div className="hyperly-action-row">
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
        className="hyperly-action"
        onClick={() => folderInputRef.current?.click()}
        title="Pick a knowledge folder"
      >
        <LibraryIcon className="h-3 w-3" />
        Library
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          className="hyperly-action ml-auto"
          disabled={isKnowledgeReading}
          title="Pick a file from the library folder"
        >
          {isKnowledgeReading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <span className="truncate max-w-28">
              {knowledgeFolderName || "No folder"}
            </span>
          )}
          {modelName && <span className="opacity-60">· {modelName}</span>}
          <ChevronDownIcon className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>
            {knowledgeFolderName
              ? `${knowledgeFolderName} files`
              : "Pick a folder with Library"}
          </DropdownMenuLabel>
          {(knowledgeFolderFiles ?? []).map((entry, index) => (
            <DropdownMenuItem
              key={`${entry.name}-${index}`}
              onSelect={() => void selectKnowledgeFile(entry.name)}
            >
              {entry.name}
              {knowledgeFile?.name === entry.name ? " ✓" : ""}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        {...({ webkitdirectory: "" } as any)}
        onChange={(e) => {
          pickKnowledgeFolder(e.target.files);
          e.target.value = "";
        }}
      />
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
