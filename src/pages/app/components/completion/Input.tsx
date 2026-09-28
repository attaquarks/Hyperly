import { Loader2 } from "lucide-react";
import { Input as InputComponent } from "@/components";
import { UseCompletionReturn } from "@/types";
import { MessageHistory } from "./MessageHistory";

// The Ask composer: a bare text field inside the panel's composer row. The
// response no longer lives in a popover hanging off this input — it renders
// inline in <Answer /> below the action row, so typing and reading share one
// always-visible surface.
export const Input = ({
  isLoading,
  input,
  setInput,
  handleKeyPress,
  handlePaste,
  currentConversationId,
  conversationHistory,
  startNewConversation,
  messageHistoryOpen,
  setMessageHistoryOpen,
  inputRef,
  isHidden,
}: UseCompletionReturn & { isHidden: boolean }) => {
  return (
    <div className="relative flex-1 min-w-0 select-none">
      <InputComponent
        ref={inputRef}
        placeholder="Ask me anything..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyPress={handleKeyPress}
        onPaste={handlePaste}
        disabled={isLoading || isHidden}
        className="hyperly-composer-input border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 h-8"
      />

      {/* Conversation thread indicator */}
      {currentConversationId &&
        (conversationHistory?.length ?? 0) > 0 &&
        !isLoading && (
          <div className="absolute select-none right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <MessageHistory
              conversationHistory={conversationHistory}
              currentConversationId={currentConversationId}
              onStartNewConversation={startNewConversation}
              messageHistoryOpen={messageHistoryOpen}
              setMessageHistoryOpen={setMessageHistoryOpen}
            />
          </div>
        )}

      {/* Loading indicator */}
      {isLoading && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 animate-pulse">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
};
