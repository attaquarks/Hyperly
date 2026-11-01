import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { XIcon } from "lucide-react";
import { ConversationHistory } from "./app/components/speech/ConversationHistory";

/**
 * The Listen history "wing": a separate always-on-top bubble window docked to
 * the main overlay's top-right (Rust owns the geometry and move sync), so the
 * history never covers the live transcript again. Picking a conversation
 * hands it to the main window over an event and closes the wing; the header
 * is a drag region for nudging it if the docked spot needs adjusting.
 */
export const HistoryWing = () => {
  return (
    <div className="hyperly-wing-shell">
      <div className="hyperly-wing-bubble" data-tauri-drag-region={true}>
        <header
          className="hyperly-wing-header"
          data-tauri-drag-region={true}
          aria-label="History wing"
        >
          <span className="hyperly-wing-title" data-tauri-drag-region={true}>
            History
          </span>
          <button
            type="button"
            className="hyperly-wing-close"
            title="Close history"
            onClick={() => void invoke("close_history_wing")}
          >
            <XIcon className="size-3.5" />
          </button>
        </header>
        <div className="hyperly-wing-body">
          <ConversationHistory
            loadConversation={async (id) => {
              await emit("history-wing-pick", id);
              await invoke("close_history_wing");
            }}
            className="w-full flex-1 min-h-0 border-0 bg-transparent"
          />
        </div>
      </div>
    </div>
  );
};
