import type { CaptureBehavior } from "@/types";

// The response policy for a finalized utterance, lifted out of the
// `speech-detected` listener so it is a pure, directly testable function. The
// listener used to inline this branch inside a React effect closure, which made
// it impossible to exercise without real audio.

// "Auto · On questions" gate: an utterance reaches the AI only when it reads
// as a question — a trailing question mark or a question opener.
const QUESTION_OPENER =
  /^(what|why|how|when|where|who|whom|whose|which|can|could|would|should|is|are|was|were|do|does|did|may|might|shall|will)\b/i;

export const looksLikeQuestion = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.endsWith("?") || QUESTION_OPENER.test(trimmed);
};

/**
 * What the handler should do with one finalized utterance.
 *
 * - `send`          — call processWithAI now with `text`.
 * - `hold`          — buffer, call nothing; `pending` is the new buffer.
 * - `stop-and-send` — a stop was requested while this utterance was
 *                     transcribing: send `text` and stop the engine.
 */
export type UtterancePlan =
  | { kind: "send"; text: string; pending: "" }
  | { kind: "hold"; pending: string }
  | { kind: "stop-and-send"; text: string; pending: "" };

export const planUtterance = (
  behavior: CaptureBehavior,
  transcript: string,
  pending: string,
  stopRequested: boolean
): UtterancePlan => {
  // A stop pressed while this utterance was transcribing is applied here, once,
  // so a fast press still sends it. Any text already held rides along.
  if (stopRequested) {
    return {
      kind: "stop-and-send",
      text: pending ? `${pending} ${transcript}` : transcript,
      pending: "",
    };
  }

  // Manual holds every utterance, and "Auto · On questions" holds everything
  // that does not read as a question — a question does not flush what is
  // already held.
  if (
    behavior === "manual" ||
    (behavior === "questions" && !looksLikeQuestion(transcript))
  ) {
    return {
      kind: "hold",
      pending: pending ? `${pending} ${transcript}` : transcript,
    };
  }

  // Auto sends every utterance. Text held from a Manual or "On questions"
  // stretch of the same session rides along on the first send rather than
  // being fired at the switch.
  return {
    kind: "send",
    text: behavior === "auto" && pending ? `${pending} ${transcript}` : transcript,
    pending: "",
  };
};
