/**
 * How a transcript row and a model utterance are labelled (Phase 4 R8, issue #20).
 *
 * THE DEFECT
 * ----------
 * A transcript row carried `speaker: string`, filled with "User" or "Speaker"
 * purely from the capture source — and the orphan-restore path derived the label
 * from `event.source` the same way. The field name claimed an identity the app
 * never establishes: there is no diarization, no embedding, no clustering (and by
 * design there will not be — Glass stops at Me/Them too). Room audio from several
 * people was labelled as if it were one known person.
 *
 * THE FIX
 * -------
 *   * a row now says where the words came from (`source`) and nothing more;
 *   * a label is shown for the CHANNEL, and a real speaker label is used only when
 *     one is actually known (`speakerLabel`, still null in this build);
 *   * the model still receives a source tag, because it has to be able to tell the
 *     user's own words from the room — but that tag is a prompt input, never part
 *     of the persisted record (`modelSourceTag`).
 *
 * No imports, so `scripts/transcript-label-check.ts` drives the real helpers.
 */

export type LabelledSource = "microphone" | "system";

export interface LabelledSegment {
  source: LabelledSource;
  /** Only set when identity is genuinely known. Null/absent otherwise. */
  speakerLabel?: string | null;
}

/**
 * The display label for a capture channel. Deliberately a channel name, not a
 * person: "Mic" is the device the user speaks into, "Room" is whatever the system
 * capture heard.
 */
export const transcriptSourceLabel = (source: LabelledSource): string =>
  source === "microphone" ? "Mic" : "Room";

/**
 * The label a transcript row renders: the real speaker label when one exists,
 * otherwise the channel label. It never invents an identity from the source.
 */
export const transcriptLabel = (segment: LabelledSegment): string =>
  segment.speakerLabel?.trim() || transcriptSourceLabel(segment.source);

/**
 * What the MODEL sees for an utterance. The tag exists so the model can tell the
 * user's own words apart from the room; it is passed to the request only and must
 * never be written into the stored message (Phase 4 R8).
 */
export const modelSourceTag = (
  source: LabelledSource,
  text: string
): string => (source === "microphone" ? `User (microphone): ${text}` : text);
