import { ListenMode } from "@/types";
import { cn } from "@/lib/utils";

type Props = {
  mode: ListenMode;
  onModeChange: (mode: ListenMode) => void;
};

const modes: Array<[ListenMode, string]> = [
  ["auto", "AUTO"],
  ["general", "General"],
  ["interview", "Interview"],
  ["coding", "<> Coding"],
  ["translate", "文A Translate"],
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

