export type TranscriptSegment = {
  id: string;
  /** Seconds elapsed since the current listen session started. */
  timestamp: number;
  /** Provider-independent fallback until diarization metadata is available. */
  speaker: string;
  text: string;
  isPartial?: boolean;
};

export type ListenMode =
  | "auto"
  | "general"
  | "interview"
  | "coding"
  | "translate"
  | "meeting";
