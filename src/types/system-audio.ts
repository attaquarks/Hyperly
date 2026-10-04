/**
 * Where a transcript row's words came from. It is NOT who said them: this app
 * does no diarization, and nothing here infers an identity from the channel
 * (Phase 4 R8, issue #20). A real speaker label lives in `speakerLabel`, which
 * stays empty until identity is genuinely known.
 */
export type TranscriptSource = "microphone" | "system";

export type TranscriptSegment = {
  id: string;
  /** Seconds elapsed since the current listen session started. */
  timestamp: number;
  /** The capture channel the words arrived on. Never an identity. */
  source: TranscriptSource;
  /**
   * A label for the speaker, ONLY when identity is actually known. Nothing in
   * this build produces one (no diarization by design), so it is null and the UI
   * falls back to the channel label — see `@/lib/transcript-label`.
   */
  speakerLabel?: string | null;
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

/** The listening bar's send behavior. */
export type CaptureBehavior =
  /** VAD on: every utterance is transcribed and sent to the AI. */
  | "auto"
  /** Continuous capture; nothing is sent until the user stops and sends. */
  | "manual"
  /** VAD on, but only question-shaped utterances are sent to the AI. */
  | "questions";

/** A file picked from the Library folder, injected as prompt knowledge. */
export type KnowledgeFile = {
  name: string;
  folderName: string;
  text: string;
  truncated: boolean;
};
