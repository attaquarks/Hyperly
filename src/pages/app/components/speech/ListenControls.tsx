import { ListenMode } from "@/types";
import { cn } from "@/lib/utils";

type Props = {
  mode: ListenMode;
  onModeChange: (mode: ListenMode) => void;
};

// The three modes the room actually ships. Coding/Translate/Auto remain valid
// stored modes (a previously selected one stays active in state) but the row
// shows only these — the toolbar stays minimal and centered.
const modes: Array<[ListenMode, string]> = [
  ["general", "General"],
  ["interview", "Interview"],
  ["meeting", "Meeting"],
];

export const ListenControls = ({ mode, onModeChange }: Props) => (
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
    </div>
  </div>
);
