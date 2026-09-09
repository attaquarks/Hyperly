import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components";
import { AutoResponseMode, ListenMode } from "@/types";
import { cn } from "@/lib/utils";

type Props = {
  mode: ListenMode;
  onModeChange: (mode: ListenMode) => void;
  autoResponseMode: AutoResponseMode;
  onAutoResponseModeChange: (mode: AutoResponseMode) => void;
  confidence: number | null;
  isPaused: boolean;
  onPause: () => void;
  onStop: () => void;
};

const modes: Array<[ListenMode, string]> = [
  ["auto", "AUTO"],
  ["general", "General"],
  ["interview", "Interview"],
  ["coding", "<> Coding"],
  ["translate", "文A Translate"],
  ["meeting", "Meeting"],
];

export const ListenControls = ({
  mode,
  onModeChange,
  autoResponseMode,
  onAutoResponseModeChange,
  confidence,
  isPaused,
  onPause,
  onStop,
}: Props) => (
  <div className="hyperly-listen-controls">
    <div className="hyperly-mode-row" role="tablist" aria-label="Listen mode">
      {modes.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          onClick={() => onModeChange(value)}
          className={cn("hyperly-mode-pill", mode === value && "hyperly-mode-pill-active")}
        >
          {label}
        </button>
      ))}
      {confidence !== null && (
        <span className="hyperly-detection-confidence">detected · {Math.round(confidence * 100)}%</span>
      )}
    </div>
    <div className="hyperly-listen-actions">
      <label className="hyperly-auto-response">
        <span>Auto responses</span>
        <select
          aria-label="Automatic response mode"
          value={autoResponseMode}
          onChange={(event) => onAutoResponseModeChange(event.target.value as AutoResponseMode)}
        >
          <option value="on-question">On questions</option>
          <option value="manual">Manual</option>
          <option value="off">Off</option>
        </select>
      </label>
      <Button size="sm" variant="ghost" className="hyperly-listen-action" onClick={onPause}>
        {isPaused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
        {isPaused ? "Resume" : "Pause"}
      </Button>
      <Button size="sm" variant="ghost" className="hyperly-listen-action hyperly-listen-stop" onClick={onStop}>
        <SquareIcon className="size-3" />
        Stop
      </Button>
    </div>
  </div>
);
