import { useState } from "react";
import { ChatConversation } from "@/types";
import { Markdown, CopyButton } from "@/components";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  lastAIResponse: string;
  isAIProcessing: boolean;
  conversation: ChatConversation;
};

// The suggested-answer window. "Latest" shows only the newest answer; "All"
// shows the full prompt/answer thread. Scrolling is manual only — the view
// never yanks the user back down while a new answer streams in.
export const ResultsSection = ({
  lastAIResponse,
  isAIProcessing,
  conversation,
}: Props) => {
  const [showAll, setShowAll] = useState(false);

  // Messages arrive newest-first; the All view reads oldest-first.
  const messages = [...(conversation?.messages ?? [])].sort(
    (a, b) => a.timestamp - b.timestamp
  );
  const hasResponse = !!lastAIResponse || isAIProcessing;

  const copyContent = showAll
    ? messages
        .map(
          (m) => `${m.role === "user" ? "Prompt" : "Answer"}:\n${m.content}`
        )
        .join("\n\n")
    : lastAIResponse;

  const emptyHint = (
    <p className="hyperly-empty-hint">
      Answers appear here as the conversation unfolds.
    </p>
  );

  return (
    <section
      className="hyperly-section hyperly-answer-section"
      aria-label="Suggested answer"
    >
      <div className="hyperly-section-heading">
        <span>Suggested answer</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={cn("hyperly-icon-btn", !showAll && "text-emerald-300")}
            onClick={() => setShowAll(false)}
          >
            Latest
          </button>
          <button
            type="button"
            className={cn("hyperly-icon-btn", showAll && "text-emerald-300")}
            onClick={() => setShowAll(true)}
          >
            All
          </button>
          {(hasResponse || (showAll && messages.length > 0)) && (
            <CopyButton content={copyContent} />
          )}
        </div>
      </div>
      <div className="hyperly-section-scroll">
        {showAll ? (
          messages.length === 0 && !hasResponse ? (
            emptyHint
          ) : (
            <div className="flex flex-col gap-2 pb-1">
              {messages.map((message, index) => (
                <div key={message.id || index}>
                  <span className="hyperly-answer-title">
                    {message.role === "user" ? "Prompt" : "Answer"}
                  </span>
                  <div className="hyperly-answer-body prose prose-sm max-w-none dark:prose-invert">
                    <Markdown>{message.content}</Markdown>
                  </div>
                </div>
              ))}
              {isAIProcessing && lastAIResponse && (
                <div>
                  <span className="hyperly-answer-title">Answer</span>
                  <div className="hyperly-answer-body prose prose-sm max-w-none dark:prose-invert">
                    <Markdown>{lastAIResponse}</Markdown>
                    <span className="inline-block w-1.5 h-3.5 bg-emerald-300 animate-pulse ml-1 align-middle" />
                  </div>
                </div>
              )}
            </div>
          )
        ) : !hasResponse ? (
          emptyHint
        ) : isAIProcessing && !lastAIResponse ? (
          <div className="flex items-center gap-2 py-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-[11px] text-muted-foreground">
              Generating answer…
            </span>
          </div>
        ) : (
          <div className="hyperly-answer-body prose prose-sm max-w-none dark:prose-invert pb-1">
            <Markdown>{lastAIResponse}</Markdown>
            {isAIProcessing && (
              <span className="inline-block w-1.5 h-3.5 bg-emerald-300 animate-pulse ml-1 align-middle" />
            )}
          </div>
        )}
      </div>
    </section>
  );
};
