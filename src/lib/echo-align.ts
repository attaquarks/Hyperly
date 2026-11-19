/**
 * Sub-segment echo cancellation — the text-level residual canceller.
 *
 * WHY THIS EXISTS
 * ---------------
 * The mic path has two echo layers and both leave residue: the GTCRN neural
 * canceller (src/lib/aec) subtracts the loopback reference at audio level
 * (21.7 dB ERLE at its best operating point — good, never perfect), and the
 * whole-utterance dedup (mic-echo-dedup) only suppresses a mic transcript
 * when it overlaps a system utterance as a WHOLE. A user utterance that
 * mixes echoed room text with genuinely new words fails that check in both
 * directions: overlap high → the user's own new words are thrown away with
 * the echo; overlap low → the room's words display under the User label.
 *
 * THE FIX (user spec, 2026-11-18): align the mic transcript against the
 * system transcript SUB-SEGMENT-wise, drop the matching spans, and keep only
 * what the room did not say. If nothing novel survives, the whole mic
 * transcript is dropped — "the user did not speak anything". The mic's text
 * is processed in the background and only displayed after this pass, so the
 * User label never shows room audio.
 *
 * The matcher is deliberately dependency-free and utterance-sized: iterative
 * longest-common-substring masking over ordered token arrays (no stopword
 * removal here — alignment needs the real word order; the Jaccard dedup in
 * mic-echo-dedup stays for the whole-utterance fast path and its tests).
 *
 * The kept text is reconstructed from the ORIGINAL characters (masking token
 * character ranges), so the user's capitalization and punctuation survive —
 * only the echoed words disappear.
 */

interface AlignedToken {
  /** Lowercased, punctuation-stripped token used for matching. */
  token: string;
  /** Character range in the ORIGINAL text (start inclusive, end exclusive). */
  start: number;
  end: number;
}

/** Ordered tokens with their original character ranges. */
const tokenizeAligned = (text: string): AlignedToken[] => {
  const tokens: AlignedToken[] = [];
  const re = /[A-Za-z0-9']+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const token = match[0]
      .toLowerCase()
      .replace(/^'+|'+$/g, "");
    if (token.length === 0) continue;
    tokens.push({ token, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
};

/** Longest common substring (contiguous) of two token arrays, as indices. */
const longestCommonSpan = (
  a: string[],
  b: string[]
): { aStart: number; length: number } | null => {
  // DP over suffix lengths; utterance-sized (<= a few hundred tokens), so the
  // O(n*m) table is fine and allocation-free beyond two rows.
  let best: { aStart: number; length: number } | null = null;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (!best || cur[j] > best.length) {
          best = { aStart: i - cur[j], length: cur[j] };
        }
      }
    }
    prev = cur;
  }
  return best;
};

export interface EchoStripResult {
  /** The mic's words the system transcript did NOT say — original casing. */
  keptText: string;
  /** Kept tokens, lowercased (for callers that want the token view). */
  keptTokens: string[];
  /** Fraction of the mic's tokens that matched the system transcript. */
  removedRatio: number;
  /** Convenience: true when nothing novel survived — drop the utterance. */
  fullyEchoed: boolean;
}

/**
 * Strip the parts of `micText` that appear (as contiguous spans) in any of
 * `systemTexts`. Greedy iterative masking: find the longest common span
 * against the concatenated system corpus, mask it, repeat while matches of
 * at least `minMatchTokens` remain. Short function-word matches (1-2
 * tokens) never mask — they are coincidence, not echo.
 */
export const stripEcho = (
  micText: string,
  systemTexts: string[],
  options?: { minMatchTokens?: number }
): EchoStripResult => {
  const minMatchTokens = options?.minMatchTokens ?? 3;
  const aligned = tokenizeAligned(micText);
  if (aligned.length === 0) {
    return {
      keptText: "",
      keptTokens: [],
      removedRatio: 0,
      fullyEchoed: true,
    };
  }
  const corpus = systemTexts
    .flatMap((text) => tokenizeAligned(text).map((t) => t.token));
  if (corpus.length === 0) {
    return {
      keptText: micText.trim(),
      keptTokens: aligned.map((t) => t.token),
      removedRatio: 0,
      fullyEchoed: false,
    };
  }

  const masked = new Array<boolean>(aligned.length).fill(false);
  for (;;) {
    // Rebuild the unmasked token stream each round: matches must be
    // contiguous in the UNMASKED text, not across previous masks.
    const freeIndices: number[] = [];
    const freeTokens: string[] = [];
    for (let i = 0; i < aligned.length; i++) {
      if (!masked[i]) {
        freeIndices.push(i);
        freeTokens.push(aligned[i].token);
      }
    }
    if (freeTokens.length === 0) break;
    const match = longestCommonSpan(freeTokens, corpus);
    if (!match || match.length < minMatchTokens) break;
    for (let k = 0; k < match.length; k++) {
      masked[freeIndices[match.aStart + k]] = true;
    }
  }

  const keptTokens: string[] = [];
  // Rebuild the kept text from ORIGINAL ranges: copy the characters between
  // masked token runs, collapsing the whitespace they leave behind.
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < aligned.length) {
    if (!masked[i]) {
      const start = i;
      while (i < aligned.length && !masked[i]) i++;
      spans.push([aligned[start].start, aligned[i - 1].end]);
    } else {
      i++;
    }
  }
  const keptText = spans
    .map(([start, end]) => micText.slice(start, end).trim())
    .filter((chunk) => chunk.length > 0)
    .join(" ")
    // Collapse doubled punctuation/separators the removal can leave at the
    // seams (e.g. "friday, , but" → "friday, but").
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:!?])(?=[A-Za-z0-9])/g, "$1 ");

  for (let k = 0; k < aligned.length; k++) {
    if (!masked[k]) keptTokens.push(aligned[k].token);
  }
  const removedRatio =
    (aligned.length - keptTokens.length) / aligned.length;
  return {
    keptText,
    keptTokens,
    removedRatio,
    // Practically-fully echoed: a couple of stray function words are noise,
    // not the user speaking. 0.85 keeps one genuinely new short phrase.
    fullyEchoed: keptTokens.length === 0 || removedRatio >= 0.85,
  };
};
