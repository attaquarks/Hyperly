export type TranscriptSegment = {
  id: string;
  /** Seconds elapsed since the current listen session started. */
  timestamp: number;
  /** Source-based label: "User" for typed input and the browser-side mic,
      "Speaker" for captured system audio. True multi-voice diarization depends
      on the STT provider. */
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
