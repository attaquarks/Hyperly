import {
  ChevronDownIcon,
  LoaderIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components";
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
};

// Capture control under the prompt tabs: EQ, Start/Stop, and the three-way
// behavior dropdown (Auto / Manual / questions). Switching behavior works
// live — the capture engine keeps running untouched and the new mode only
// changes how utterances reach the AI.
export const ListeningBar = ({
  capturing,
  isProcessing,
  behavior,
  onBehaviorChange,
  onToggleCapture,
}: Props) => {
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
    </div>
  );
};
