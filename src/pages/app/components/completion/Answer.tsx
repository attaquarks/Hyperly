import { Loader2, XIcon } from "lucide-react";
import { Button, Markdown, Switch, CopyButton } from "@/components";
import { UseCompletionReturn } from "@/types";
import { FollowUpChips } from "./FollowUpChips";

// The Ask answer, rendered inline in the panel body. Visible whenever there
// is something to show (loading, response, error, or an engaged conversation)
// and gone otherwise — an empty Ask room is just the composer and action row.
//
// The answer does not scroll itself. It flows inside `.hyperly-overlay-body`,
// which is the Ask room's one scrolling authority; a second nested scroller
// here would fight it for the wheel and split the arrow-key target.
export const Answer = ({
  isLoading,
  response,
  error,
  cancel,
  reset,
  keepEngaged,
  setKeepEngaged,
  startNewConversation,
  conversationHistory,
  inputRef,
  submit,
}: UseCompletionReturn) => {
  const show = isLoading || response !== "" || error !== null || keepEngaged;
  if (!show) return null;

  const isMac = (navigator.platform || navigator.userAgent || "")
    .toLowerCase()
    .includes("mac");
  const modKey = isMac ? "⌘" : "Ctrl";

  return (
    <section className="hyperly-answer" aria-label="AI response">
      <div className="hyperly-answer-header">
        <span className="hyperly-answer-title">
          {keepEngaged ? "Conversation" : "Hyperly"}
        </span>
        <div className="flex items-center gap-2 select-none">
          <span className="text-[9px] text-muted-foreground/60">
            {modKey}+K conversation
          </span>
          <Switch
            checked={keepEngaged}
            onCheckedChange={(checked) => {
              setKeepEngaged(checked);
              setTimeout(() => {
                inputRef?.current?.focus();
              }, 100);
            }}
            className="scale-75"
          />
          {response && <CopyButton content={response} />}
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              if (isLoading) {
                cancel();
              } else if (keepEngaged) {
                setKeepEngaged(false);
                startNewConversation();
              } else {
                reset();
              }
            }}
            className="cursor-pointer h-5 w-5"
            title={
              isLoading
                ? "Cancel loading"
                : keepEngaged
                ? "Close and start new conversation"
                : "Clear conversation"
            }
          >
            <XIcon className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {error && (
        <div className="hyperly-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      <div className="hyperly-answer-body">
        {isLoading && !response && (
          <div className="flex items-center gap-2 text-muted-foreground animate-pulse select-none">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-[11px]">Generating response...</span>
          </div>
        )}
        {response && (
          <>
            <Markdown>{response}</Markdown>
            {isLoading && (
              <span className="inline-block w-1.5 h-3.5 bg-emerald-300 animate-pulse ml-0.5 align-middle" />
            )}
          </>
        )}

        {/* Conversation history (engaged mode) */}
        {keepEngaged && (conversationHistory?.length ?? 0) > 1 && (
          <div className="space-y-3 pt-3">
            {(conversationHistory ?? [])
              .sort((a, b) => b?.timestamp - a?.timestamp)
              .map((message, index) => {
                if (!isLoading && index === 0) {
                  return null;
                }
                return (
                  <div
                    key={message.id}
                    className={`p-3 rounded-lg text-sm ${
                      message.role === "user"
                        ? "bg-primary/10 border border-primary/20"
                        : "bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-medium text-muted-foreground uppercase">
                        {message.role === "user" ? "You" : "AI"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(message.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <Markdown>{message.content}</Markdown>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {response && !isLoading && (
        <FollowUpChips submit={submit} isLoading={isLoading} />
      )}
    </section>
  );
};
