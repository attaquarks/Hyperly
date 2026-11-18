import { useEffect, useRef, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon, MicIcon, RadioIcon } from "lucide-react";
import { TranscriptSegment } from "@/types";
import { cn } from "@/lib/utils";
import {
  transcriptLabel,
  transcriptSourceLabel,
} from "@/lib/transcript-label";

type Props = {
  segments: TranscriptSegment[];
  livePartial?: string;
  /** In-progress text from the browser-side "User" mic, before it is finalized
      into a segment. Rendered as a trailing live row. */
  userPartial?: string;
  /** Whether the browser mic is captured alongside system audio. */
  micWithSystem?: boolean;
  onToggleMic?: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  children?: ReactNode;
};

const formatTimestamp = (seconds: number) => {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
};

// The transcript window. Auto-scrolls with new speech but yields as soon as
// the user scrolls up, and re-engages when they scroll back to the bottom.
// The header arrow collapses the body. When children are present (chat
// history) they take over the transcript slot entirely rather than stacking
// over it — one scrolling surface at a time.
export const TranscriptThread = ({
  segments,
  livePartial,
  userPartial,
  micWithSystem = false,
  onToggleMic,
  collapsed,
  onToggleCollapsed,
  children,
}: Props) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether auto-scroll is currently pinned to the latest line.
  const pinnedRef = useRef(true);

  // The hook already emits the in-progress utterance as its own segment with
  // isPartial set; synthesizing a second row here duplicated the live line.
  const visibleSegments = segments ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current && !collapsed) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visibleSegments.length, livePartial, userPartial, collapsed]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <section
      className="hyperly-section hyperly-transcript-section"
      aria-label="Transcript · current thread"
    >
      <div className="hyperly-section-heading">
        <span>Transcript · Current thread</span>
        <div className="flex items-center gap-1">
          {/* Source toggle. Off: system audio only, labelled "Speaker". On: the
              browser mic is captured too and labelled "User". The two streams
              stay separate end to end, so this adds one rather than mixing. */}
          <button
            type="button"
            className={cn(
              "hyperly-thread-source",
              micWithSystem && "hyperly-thread-source-on"
            )}
            onClick={onToggleMic}
            aria-pressed={micWithSystem}
            title={
              micWithSystem
                ? "Switch to system audio only"
                : "Also capture your microphone"
            }
          >
            {micWithSystem ? (
              <MicIcon className="size-3" />
            ) : (
              <RadioIcon className="size-3" />
            )}
            {micWithSystem ? "Mic + system audio" : "System audio"}
          </button>
          <button
            type="button"
            className="hyperly-icon-btn"
            onClick={onToggleCollapsed}
            title={collapsed ? "Show transcript" : "Hide transcript"}
          >
            {collapsed ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronUpIcon className="size-3" />
            )}
          </button>
        </div>
      </div>
      {children ? (
        children
      ) : (
        !collapsed && (
          <div
            className="hyperly-section-scroll flex-1"
            ref={scrollRef}
            onScroll={handleScroll}
          >
            {visibleSegments.length === 0 ? (
              <p className="hyperly-empty-hint">
                Start listening to transcribe the room's audio. Hyperly suggests
                answers as the conversation unfolds.
              </p>
            ) : (
              <div className="hyperly-thread-list">
                {/* ROUND MODEL: one System block for the whole round — every
                    room utterance of this capture stacks under the same label,
                    pauses included — and one User block below it. The mic's
                    words only appear here AFTER the echo strip validated them
                    (never as a live partial), so the User label never shows
                    room audio. */}
                {(() => {
                  const systemSegments = visibleSegments.filter(
                    (segment) => segment.source !== "microphone"
                  );
                  const userSegments = visibleSegments.filter(
                    (segment) => segment.source === "microphone"
                  );
                  const systemLive = livePartial?.trim();
                  const firstTime = systemSegments[0]?.timestamp ?? 0;
                  return (
                    <>
                      {systemSegments.length > 0 || systemLive ? (
                        <div className="hyperly-transcript-block">
                          <div className="hyperly-transcript-block-head">
                            <span className="hyperly-transcript-speaker">
                              {systemSegments[0]
                                ? transcriptLabel(systemSegments[0])
                                : transcriptSourceLabel("system")}
                            </span>
                            <time className="hyperly-transcript-time">
                              {formatTimestamp(firstTime)}
                              {systemSegments.length > 1
                                ? ` · ${systemSegments.length} lines`
                                : ""}
                            </time>
                          </div>
                          <div className="hyperly-transcript-block-body">
                            {systemSegments.map((segment) => (
                              <p
                                key={segment.id}
                                className={
                                  segment.isPartial
                                    ? "hyperly-transcript-live"
                                    : ""
                                }
                              >
                                {segment.text}
                              </p>
                            ))}
                            {systemLive && (
                              <p className="hyperly-transcript-live">
                                {systemLive}
                              </p>
                            )}
                          </div>
                        </div>
                      ) : null}
                      {userSegments.length > 0 ? (
                        <div className="hyperly-transcript-block hyperly-transcript-block-user">
                          <div className="hyperly-transcript-block-head">
                            <span className="hyperly-transcript-speaker">
                              {transcriptLabel(userSegments[0])}
                            </span>
                            <time className="hyperly-transcript-time">
                              {formatTimestamp(userSegments[0]?.timestamp ?? 0)}
                              {userSegments.length > 1
                                ? ` · ${userSegments.length} lines`
                                : ""}
                            </time>
                          </div>
                          <div className="hyperly-transcript-block-body">
                            {userSegments.map((segment) => (
                              <p key={segment.id}>{segment.text}</p>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        )
      )}
    </section>
  );
};
