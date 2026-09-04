import { useEffect, useState } from "react";
import { useHistory } from "@/hooks";
import { ChatConversation } from "@/types";
import { Input } from "@/components";
import { cn } from "@/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon, Search } from "lucide-react";
import moment from "moment";

interface ConversationHistoryProps {
  loadConversation: (id: string) => Promise<void>;
  activeConversationId?: string;
  onClose?: () => void;
  className?: string;
}

/**
 * Collapsible sidebar that lists past listen-mode conversations. When a conversation is
 * selected, the listen panel loads it via the hook's `loadConversation` callback.
 */
export const ConversationHistory = ({
  loadConversation,
  activeConversationId,
  onClose,
  className,
}: ConversationHistoryProps) => {
  const history = useHistory();
  const [collapsed, setCollapsed] = useState(false);

  // Refresh whenever the sidebar opens.
  useEffect(() => {
    history.refreshConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        title="Show conversation history"
        className={cn(
          "flex items-center justify-center w-7 h-7 rounded-md border border-border/50 bg-background/60 hover:bg-background text-muted-foreground hover:text-foreground transition-colors",
          className
        )}
      >
        <ChevronRightIcon className="w-3.5 h-3.5" />
      </button>
    );
  }

  const filtered = history.conversations.filter((doc: ChatConversation) =>
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
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Hide conversation history"
            className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
          >
            <ChevronLeftIcon className="w-3.5 h-3.5" />
          </button>
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
            {history.conversations.length === 0
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
                  }}
                  className={cn(
                    "w-full text-left px-2 py-1.5 hover:bg-muted/70 transition-colors border-b border-border/30",
                    activeConversationId === doc.id && "bg-primary/10"
                  )}
                >
                  <p className="text-xs line-clamp-1">{doc.title}</p>
                  <p className="text-[9px] text-muted-foreground mt-0.5">
                    {moment(doc.updatedAt).format("MMM D · hh:mm A")} ·{" "}
                    {doc.messages.length} msgs
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
