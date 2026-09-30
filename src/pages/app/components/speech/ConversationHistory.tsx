import { useEffect } from "react";
import { useHistory } from "@/hooks";
import { ChatConversation } from "@/types";
import { Input } from "@/components";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";
import moment from "moment";

interface ConversationHistoryProps {
  loadConversation: (id: string) => Promise<void>;
  activeConversationId?: string;
  onClose?: () => void;
  className?: string;
}

/**
 * Past listen-mode conversations. In the Listen window it renders as an
 * overlay on top of the transcript area — picking a conversation loads it and
 * closes the overlay, while the transcript keeps capturing behind it.
 */
export const ConversationHistory = ({
  loadConversation,
  activeConversationId,
  onClose,
  className,
}: ConversationHistoryProps) => {
  const history = useHistory();

  // Refresh whenever the panel opens.
  useEffect(() => {
    history.refreshConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = (history.conversations ?? []).filter((doc: ChatConversation) =>
    history.search
      ? doc.title?.toLowerCase().includes(history.search.toLowerCase())
      : true
  );

  return (
    <div
      className={cn(
        "w-56 flex-shrink-0 flex flex-col border-r border-border/50 bg-background/40",
        className
      )}
    >
      <div className="flex items-center justify-between p-2 border-b border-border/50">
        <p className="text-xs font-medium select-none">History</p>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        )}
      </div>

      <div className="relative p-2 border-b border-border/50">
        <Search className="absolute left-4 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search..."
          className="h-7 pl-7 text-xs focus-visible:ring-0 focus-visible:ring-offset-0"
          value={history.search}
          onChange={(e) => history.setSearch(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {history.isLoading ? (
          <p className="text-[10px] text-muted-foreground p-3">Loading...</p>
        ) : filtered.length === 0 ? (
          <p className="text-[10px] text-muted-foreground p-3 select-none">
            {(history.conversations?.length ?? 0) === 0
              ? "No conversations yet"
              : "No matches"}
          </p>
        ) : (
          <ul className="flex flex-col">
            {filtered.map((doc: ChatConversation) => (
              <li key={doc.id}>
                <button
                  type="button"
                  onClick={() => {
                    void loadConversation(doc.id);
                    onClose?.();
                  }}
                  className={cn(
                    "w-full text-left px-2 py-1.5 hover:bg-muted/70 transition-colors border-b border-border/30",
                    activeConversationId === doc.id && "bg-primary/10"
                  )}
                >
                  <p className="text-xs line-clamp-1">{doc.title}</p>
                  <p className="text-[9px] text-muted-foreground mt-0.5">
                    {moment(doc.updatedAt).format("MMM D · hh:mm A")} ·{" "}
                    {(doc.messages?.length ?? 0)} msgs
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default ConversationHistory;
