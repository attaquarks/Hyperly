import { XIcon } from "lucide-react";
import { useCompletion } from "@/hooks";
import { Input } from "./Input";
import { SendButton } from "./SendButton";
import { MicDriver } from "./MicDriver";
import { Answer } from "./Answer";
import { ActionRow } from "./ActionRow";
import { AskPushToTalkKey } from "./AskPushToTalkKey";

// The Ask room: composer (text + send arrow), action row, then whatever the
// room has to show — live voice transcript, attached-image thumbnails, a
// knowledge note, and the streamed answer with follow-up chips. Everything
// renders inline in the always-expanded panel; nothing here is a popover.
//
// The mic is headless (MicDriver) and driven by the Push to talk button, the
// spacebar, or the global Voice Input shortcut — all three flip the same
// enableVAD flag. Space is the primary control here: press once to record,
// press again to stop and send. The Library button is file knowledge (a picked
// folder + one file), not chat history.
export const Completion = ({
  isHidden,
  capturing = false,
}: {
  isHidden: boolean;
  capturing?: boolean;
}) => {
  const completion = useCompletion(capturing);

  return (
    <div className="hyperly-overlay-body" ref={completion.scrollAreaRef}>
      <MicDriver {...completion} />
      <AskPushToTalkKey
        active={!isHidden}
        setEnableVAD={completion.setEnableVAD}
      />

      <div className="hyperly-composer">
        <Input {...completion} isHidden={isHidden} />
        <SendButton {...completion} />
      </div>

      <ActionRow {...completion} />

      {/* Live voice transcript while the mic is on */}
      {(completion.enableVAD || completion.micTranscript) && (
        <div className="hyperly-mic-live">
          <span className="hyperly-mic-live-label">User</span>
          <span>{completion.micTranscript || "Listening… speak now"}</span>
        </div>
      )}

      {/* Attached images */}
      {(completion.attachedFiles?.length ?? 0) > 0 && (
        <div className="hyperly-thumb-strip">
          {(completion.attachedFiles ?? []).map((file) => (
            <span key={file.id} className="relative">
              <img
                src={`data:${file.type};base64,${file.base64}`}
                alt={file.name}
                className="hyperly-thumb"
              />
              <button
                type="button"
                className="hyperly-thumb-remove"
                title="Remove image"
                onClick={() => completion.removeFile(file.id)}
              >
                <XIcon className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {completion.knowledgeFile && (
        <p className="hyperly-knowledge-note flex items-center gap-1 px-0">
          <span className="truncate">
            {completion.knowledgeFile.name} · knowledge in this prompt
            {completion.knowledgeFile.truncated ? " (truncated)" : ""}
          </span>
          <button
            type="button"
            className="hyperly-icon-btn"
            onClick={completion.clearKnowledgeFile}
            title="Remove knowledge file"
          >
            <XIcon className="size-3" />
          </button>
        </p>
      )}
      {completion.knowledgeReadError && (
        <p className="hyperly-knowledge-note px-0">
          {completion.knowledgeReadError}
        </p>
      )}

      <Answer {...completion} />
    </div>
  );
};
