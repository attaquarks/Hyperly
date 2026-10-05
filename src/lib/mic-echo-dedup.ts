/**
 * Phrase-level transcript dedup for mic bleed-through (D1 Gap 3, dedup half).
 *
 * Windows WebView2 frequently denies the echoCancellation the mic requests,
 * so room audio played through speakers lands in the mic stream and is
 * transcribed a second time as "User". The fix here is NOT more capture
 * plumbing: if a mic utterance closely matches a system utterance in the
 * same time window, the mic copy is almost certainly that bleed-through and
 * is suppressed. (Voxtype's `echo_cancel` pairs exactly this with a neural
 * enhancer; the dedup ships first and is measured before GTCRN is even
 * considered. No dependency, no model — normalize + token overlap only.)
 */
export interface DedupCandidate {
  /** Seconds since session start, same clock as TranscriptSegment.timestamp. */
  atSeconds: number;
  text: string;
}

const STOPWORDS = new Set(
  "a,an,the,and,or,but,of,to,in,on,at,for,with,is,are,was,were,be,been,it,its,this,that,these,those,i,you,he,she,we,they,my,your,his,her,our,their,me,him,us,them,do,does,did,can,could,would,should,will,what,when,where,who,which,how,why,not,no,yes,please,thanks,thank,ok,okay,yeah,yep,uh,um,er,ah,hmm".split(
    ","
  )
);

export const normalizeUtterance = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^'+|'+$/g, ""))
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));

/**
 * Whether the mic utterance is a near-duplicate of a recent system
 * utterance. Content overlap is the Jaccard index of the two normalized
 * token sets; the mic side must also not carry much the room didn't say
 * (bounded novelty), and it must fall inside the time window.
 */
export const isMicEchoOfSystem = (
  micText: string,
  systemHistory: DedupCandidate[],
  micAtSeconds: number,
  options?: { windowSeconds?: number; minOverlap?: number; maxNovelty?: number }
): boolean => {
  const windowSeconds = options?.windowSeconds ?? 8;
  const minOverlap = options?.minOverlap ?? 0.6;
  const maxNovelty = options?.maxNovelty ?? 0.35;
  const micTokens = new Set(normalizeUtterance(micText));
  if (micTokens.size === 0) return false;
  return systemHistory.some((candidate) => {
    if (Math.abs(micAtSeconds - candidate.atSeconds) > windowSeconds) {
      return false;
    }
    const sysTokens = new Set(normalizeUtterance(candidate.text));
    if (sysTokens.size === 0) return false;
    let shared = 0;
    for (const token of micTokens) {
      if (sysTokens.has(token)) shared++;
    }
    const overlap = shared / new Set([...micTokens, ...sysTokens]).size;
    const novelty = (micTokens.size - shared) / micTokens.size;
    return overlap >= minOverlap && novelty <= maxNovelty;
  });
};