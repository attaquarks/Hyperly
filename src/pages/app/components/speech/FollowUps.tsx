import { useState } from "react";
import { PlusIcon } from "lucide-react";

type Props = {
  /** The four fixed follow-ups, plus any custom ones the user added. */
  quickActions: string[];
  /** AI-suggested follow-ups relevant to the current conversation. */
  suggestions: string[];
  disabled?: boolean;
  onAction: (action: string) => void;
  onAddCustom: (action: string) => void;
};

// The follow-ups window: fixed chips first, then conversation-specific
// suggestions, and a small + that adds a custom chip (persisted with the
// existing quick-actions storage).
export const FollowUps = ({
  quickActions,
  suggestions,
  disabled,
  onAction,
  onAddCustom,
}: Props) => {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const value = draft.trim();
    if (value) onAddCustom(value);
    setDraft("");
    setAdding(false);
  };

  const extras = (suggestions ?? []).filter(
    (s) => !(quickActions ?? []).includes(s)
  );

  return (
    <section className="hyperly-section" aria-label="Follow-ups">
      <div className="hyperly-section-heading">
        <span>Follow-ups</span>
        <button
          type="button"
          className="hyperly-icon-btn"
          onClick={() => setAdding((v) => !v)}
          title="Add a custom follow-up"
        >
          <PlusIcon className="size-3" />
        </button>
      </div>
      <div className="hyperly-action-row">
        {(quickActions ?? []).map((action) => (
          <button
            key={action}
            type="button"
            className="hyperly-action"
            disabled={disabled}
            onClick={() => onAction(action)}
          >
            {action}
          </button>
        ))}
        {extras.map((action) => (
          <button
            key={action}
            type="button"
            className="hyperly-action"
            disabled={disabled}
            onClick={() => onAction(action)}
          >
            {action}
          </button>
        ))}
      </div>
      {adding && (
        <input
          className="hyperly-followup-input mt-1.5"
          placeholder="Custom follow-up…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          autoFocus
        />
      )}
    </section>
  );
};
