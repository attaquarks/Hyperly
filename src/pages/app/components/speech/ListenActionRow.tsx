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
import { useApp } from "@/contexts";
import type { LibraryEntry } from "@/hooks/useKnowledge";

type Props = {
  isCapturing: boolean;
  onCapture: () => void;
  onCaptureRegion: () => void;
  onAttach: (files: FileList | null) => void;
  folderName: string;
  folderFiles: LibraryEntry[];
  selectedFileName?: string;
  isReading: boolean;
  onPickFolder: (files: FileList | null) => void;
  onSelectFile: (name: string) => void;
};

// The action row the Listen window shares with Ask: full-screen Capture,
// region Selection, image Attach — plus the real Library: pick a folder,
// then pick one of its files from the right-side dropdown (folder name and
// model name on the trigger) to ride the next prompt as knowledge.
export const ListenActionRow = ({
  isCapturing,
  onCapture,
  onCaptureRegion,
  onAttach,
  folderName,
  folderFiles,
  selectedFileName,
  isReading,
  onPickFolder,
  onSelectFile,
}: Props) => {
  const { supportsImages, selectedAIProvider } = useApp();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const modelName =
    selectedAIProvider.variables?.MODEL ??
    selectedAIProvider.variables?.model ??
    selectedAIProvider.provider ??
    "";

  return (
    <div className="hyperly-action-row">
      <button
        type="button"
        className="hyperly-action"
        disabled={!supportsImages || isCapturing}
        onClick={onCapture}
        title="Capture the full screen"
      >
        {isCapturing ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <CameraIcon className="h-3 w-3" />
        )}
        Capture
      </button>
      <button
        type="button"
        className="hyperly-action"
        disabled={!supportsImages}
        onClick={onCaptureRegion}
        title="Drag to capture a screen region"
      >
        <MousePointer2Icon className="h-3 w-3" />
        Selection
      </button>
      <button
        type="button"
        className="hyperly-action"
        disabled={!supportsImages}
        onClick={() => attachInputRef.current?.click()}
        title={
          supportsImages
            ? "Attach an image"
            : "Image upload not supported by current AI provider"
        }
      >
        <PaperclipIcon className="h-3 w-3" />
        Attach
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
          disabled={isReading}
          title="Pick a file from the library folder"
        >
          {isReading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <span className="truncate max-w-28">
              {folderName || "No folder"}
            </span>
          )}
          {modelName && <span className="opacity-60">· {modelName}</span>}
          <ChevronDownIcon className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>
            {folderName ? `${folderName} files` : "Pick a folder with Library"}
          </DropdownMenuLabel>
          {(folderFiles ?? []).map((entry, index) => (
            <DropdownMenuItem
              key={`${entry.name}-${index}`}
              onSelect={() => onSelectFile(entry.name)}
            >
              {entry.name}
              {selectedFileName === entry.name ? " ✓" : ""}
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
          onPickFolder(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={attachInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          onAttach(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
};
