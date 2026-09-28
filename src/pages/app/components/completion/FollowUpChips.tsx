import { UseCompletionReturn } from "@/types";

// Static follow-up presets — deliberately not AI-generated, so a chip never
// costs a second API call. Clicking one sends it as the next message in the
// current conversation.
const FOLLOW_UPS = ["Explain more", "Summarize", "Show code"];

export const FollowUpChips = ({
  submit,
  isLoading,
}: Pick<UseCompletionReturn, "submit" | "isLoading">) => (
  <div>
    <div className="hyperly-section-heading">
      <span>Follow-ups</span>
    </div>
    <div className="hyperly-action-row" aria-label="Follow-up suggestions">
      {FOLLOW_UPS.map((chip) => (
        <button
          key={chip}
          type="button"
          className="hyperly-action"
          disabled={isLoading}
          onClick={() => void submit(chip)}
        >
          {chip}
        </button>
      ))}
    </div>
  </div>
);
