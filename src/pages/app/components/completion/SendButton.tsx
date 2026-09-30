import { ArrowUpIcon, Loader2 } from "lucide-react";
import { UseCompletionReturn } from "@/types";
import { cn } from "@/lib/utils";

type Props = Pick<UseCompletionReturn, "input" | "isLoading" | "submit">;

/**
 * The composer's send arrow, where the mic button used to be. It stays dull
 * until there is something to send and brightens once the input has content,
 * so the row reads as "type or paste, then send" rather than offering a control
 * that does nothing.
 */
export const SendButton = ({ input, isLoading, submit }: Props) => {
  const hasContent = input.trim().length > 0;

  return (
    <button
      type="button"
      className={cn(
        "hyperly-send",
        hasContent && !isLoading && "hyperly-send-ready"
      )}
      disabled={!hasContent || isLoading}
      onClick={() => void submit()}
      title="Send"
      aria-label="Send"
    >
      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <ArrowUpIcon className="h-3.5 w-3.5" />
      )}
    </button>
  );
};
