import { HeadphonesIcon, RadioIcon } from "lucide-react";
import { TranscriptSegment } from "@/types";

type Props = {
  segments: TranscriptSegment[];
  livePartial?: string;
};

const formatTimestamp = (seconds: number) => {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
};

export const TranscriptThread = ({ segments, livePartial }: Props) => {
  const visibleSegments = segments.length
    ? segments
    : livePartial
    ? [
        {
          id: "live",
          timestamp: 0,
          speaker: "Speaker 1",
          text: livePartial,
          isPartial: true,
        },
      ]
    : [];

  if (!visibleSegments.length) return null;

  return (
    <section className="hyperly-thread" aria-label="Current transcript thread">
      <div className="hyperly-thread-heading">
        <div className="flex items-center gap-1.5">
          <HeadphonesIcon className="size-3.5" />
          <span>TRANSCRIPT · CURRENT THREAD</span>
        </div>
        <span className="hyperly-thread-source">
          <RadioIcon className="size-3" />
          Mic + system audio
        </span>
      </div>
      <div className="hyperly-thread-list">
        {visibleSegments.map((segment) => (
          <div className="hyperly-transcript-row" key={segment.id}>
            <time className="hyperly-transcript-time">
              {formatTimestamp(segment.timestamp)}
            </time>
            <span className="hyperly-transcript-speaker">{segment.speaker}</span>
            <span className={segment.isPartial ? "hyperly-transcript-live" : ""}>
              {segment.text}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
};
