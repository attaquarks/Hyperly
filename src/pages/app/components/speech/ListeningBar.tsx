import { useRef } from "react";
import {
  CameraIcon,
  ChevronDownIcon,
  Loader2,
  LoaderIcon,
  MousePointer2Icon,
  PaperclipIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components";
import { useApp } from "@/contexts";
import { CaptureBehavior } from "@/types";
import { cn } from "@/lib/utils";

const BEHAVIORS: { value: CaptureBehavior; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Send every utterance" },
  { value: "manual", label: "Manual", hint: "Send when you stop" },
  { value: "questions", label: "Auto · On questions", hint: "Send questions only" },
];

type Props = {
  capturing: boolean;
  isProcessing: boolean;
  behavior: CaptureBehavior;
  onBehaviorChange: (behavior: CaptureBehavior) => void;
  onToggleCapture: () => void;
  /** Screenshot capture (full screen + region) and image attach, relocated
      from the old action row so the Start bar is the one control strip. */
  isCapturingScreenshot: boolean;
  onCapture: () => void;
  onCaptureRegion: () => void;
  onAttach: (files: FileList | null) => void;
  onNewConversation: () => void;
};

// The Start bar: EQ, Start/Stop, then Capture / Selection / Attach side by
// side with it, and on the far right the behavior dropdown plus the New
// conversation button (moved up from the toolbar so the whole control strip
// lives in one predictable row).
export const ListeningBar = ({
  capturing,
  isProcessing,
  behavior,
  onBehaviorChange,
  onToggleCapture,
  isCapturingScreenshot,
  onCapture,
  onCaptureRegion,
  onAttach,
  onNewConversation,
}: Props) => {
  const { supportsImages } = useApp();
  const attachInputRef = useRef<HTMLInputElement>(null);
  const active = BEHAVIORS.find((b) => b.value === behavior) ?? BEHAVIORS[1];

  return (
    <div className="hyperly-listening-bar">
      <span
        className={cn(
          "hyperly-listening-eq",
          !capturing && "hyperly-listening-eq-idle"
        )}
        aria-hidden="true"
      >
        <span />
        <span />
        <span />
        <span />
      </span>
      <button
        type="button"
        className={cn("hyperly-action", capturing && "hyperly-action-active")}
        onClick={onToggleCapture}
        disabled={isProcessing}
        title={capturing ? "Stop listening" : "Start listening"}
      >
        {isProcessing ? (
          <LoaderIcon className="h-3 w-3 animate-spin" />
        ) : capturing ? (
          <SquareIcon className="h-3 w-3" />
        ) : (
          <PlayIcon className="h-3 w-3" />
        )}
        {capturing ? "Stop" : "Start"}
      </button>
      <button
        type="button"
        className="hyperly-action"
        disabled={!supportsImages || isCapturingScreenshot}
        onClick={onCapture}
        title="Capture the full screen"
      >
        {isCapturingScreenshot ? (
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

      <DropdownMenu>
        <DropdownMenuTrigger
          className="hyperly-action ml-auto"
          title="Listening behavior"
        >
          {active.label}
          <ChevronDownIcon className="h-3 w-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom">
          {BEHAVIORS.map((b) => (
            <DropdownMenuItem
              key={b.value}
              onSelect={() => onBehaviorChange(b.value)}
            >
              <span className="flex flex-col">
                <span>{b.label}</span>
                <span className="text-[9px] text-muted-foreground">
                  {b.hint}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        className="hyperly-action"
        onClick={onNewConversation}
        title="Start a new conversation"
      >
        <PlusIcon className="h-3 w-3" />
        New
      </button>
    </div>
  );
};
