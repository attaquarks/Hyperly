// Overlay static-zone layout guard.
//
// WHY THIS EXISTS
// ---------------
// The liquid-glass redesign's functional fix is a STATIC ZONE CONTRACT for the
// overlay: every region has a reserved slot, long content scrolls inside its
// own slot, and no block can overlap or squeeze another. Before this, the
// flex stack let a growing LLM answer squeeze the transcript toward its
// 72 px floor and shrink the follow-up chips until they were unscrollable —
// the user's exact complaint. CSS regressions are silent: one `flex: 0 1`
// or a dropped `grid-row` and the blocks stack on each other again, with no
// build error and every test still green.
//
// THIS SCRIPT ENFORCES
//   1. the Listen room is a CSS grid with the fixed 8-row template, and every
//      zone carries its grid-row assignment;
//   2. the two reading zones keep their floors (transcript ≥140 px, answer
//      ≥88 px) and their fr maxes (3fr/2fr) — no `flex: 0 1` / max-height
//      shrink patterns may return;
//   3. the follow-ups DOCK: single row (nowrap) + horizontal scroller —
//      chips never wrap into a second row and the lane height never varies;
//   4. the Ask room: composer + action row fixed, one content lane
//      (.hyperly-ask-scroll) that is the room's only scroller and the
//      scrollAreaRef target;
//   5. the JSX wiring survives: zone classes in speech/index.tsx, the
//      ask-scroll ref in completion/index.tsx, and the data-testids that e2e
//      depends on (listen-streaming-badge, listen-history-toggle).
//
// Run with:  node scripts/overlay-layout-check.ts

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Failure = { where: string; problem: string };
const failures: Failure[] = [];

const read = (relPath: string): string => {
  try {
    return readFileSync(join(ROOT, relPath), "utf8");
  } catch {
    return "";
  }
};

const fail = (where: string, problem: string): void => {
  failures.push({ where, problem });
};

const expect = (cond: boolean, where: string, what: string): void => {
  if (!cond) fail(where, what);
};

// ---------------------------------------------------------------------------
// 1. The Listen room grid template and zone assignments.
// ---------------------------------------------------------------------------
const css = read("src/global.css");

const listenBody = css.match(/\.hyperly-listen-body\s*\{([^}]*)\}/);
expect(!!listenBody, "global.css", "missing .hyper-li-sten-body rule");
const bodyCss = listenBody ? listenBody[1] : "";
expect(
  /display:\s*grid/.test(bodyCss),
  "global.css .hyperly-listen-body",
  "Listen room must be display: grid (the static zone contract)"
);
expect(
  /minmax\(140px,\s*3fr\)/.test(bodyCss),
  "global.css .hyperly-listen-body",
  "transcript zone must keep its 140px floor and 3fr share"
);
expect(
  /minmax\(88px,\s*2fr\)/.test(bodyCss),
  "global.css .hyperly-listen-body",
  "answer zone must keep its 88px floor and 2fr share"
);
for (const row of [1, 2, 3, 4, 5, 6, 7, 8]) {
  expect(
    new RegExp(`grid-row:\\s*${row}`).test(css),
    "global.css",
    `zone grid-row: ${row} assignment missing`
  );
}
expect(
  /grid-row:\s*1 \/ -1/.test(css),
  "global.css",
  "setup zone must span the whole grid (grid-row: 1 / -1)"
);

// ---------------------------------------------------------------------------
// 2. The shrink patterns that caused the overlap must never return.
// ---------------------------------------------------------------------------
expect(
  !/\.hyperly-followups-section\s*\{[^}]*flex:\s*0 1/.test(css),
  "global.css .hyperly-followups-section",
  "follow-ups must never flex-shrink no-shrink (the old collapse)"
);
expect(
  !/\.hyperly-answer-section\s*\{[^}]*flex:\s*0 1/.test(css),
  "global.css .hyperly-answer-section",
  "old answer-zone shrink pattern must stay dead"
);
expect(
  !/\.hyperly-followups-section\s*\{[^}]*max-height/.test(css),
  "global.css .hyperly-followups-section",
  "follow-ups must not carry a max-height cap (dock height is fixed)"
);
expect(
  !/\.hyperly-answer-section\s*\{[^}]*max-height/.test(css),
  "global.css .hyperly-answer-section",
  "answer zone must not carry a max-height cap (the grid row owns the cap)"
);

// ---------------------------------------------------------------------------
// 3. The follow-ups dock: one lane, no wrap, horizontal scroll.
// ---------------------------------------------------------------------------
const dockCss = css.match(
  /\.hyperly-followups-section \.hyperly-action-row\s*\{([^}]*)\}/
);
expect(!!dockCss, "global.css", "missing follow-ups dock rule");
const dock = dockCss ? dockCss[1] : "";
expect(
  /flex-wrap:\s*nowrap/.test(dock),
  "global.css follow-ups dock",
  "chips must never wrap (flex-wrap: nowrap)"
);
expect(
  /overflow-x:\s*auto/.test(dock),
  "global.css follow-ups dock",
  "the dock lane must scroll horizontally"
);
expect(
  /overflow-y:\s*hidden/.test(dock), ".hyperly-followups-section .hyperly-action-row",
  "the dock lane must not scroll vertically (one lane only)"
);

// ---------------------------------------------------------------------------
// 4. The Ask room: fixed chrome + one content lane.
// ---------------------------------------------------------------------------
const askScroll = css.match(/\.hyperly-ask-scroll\s*\{([^}]*)\}/);
expect(!!askScroll, "global.css", "missing .hyperly-ask-scroll rule");
const ask = askScroll ? askScroll[1] : "";
expect(
  /overflow-y:\s*auto/.test(ask),
  "global.css .hyperly-ask-scroll",
  "the content lane must be the room's scroller"
);
expect(
  /min-height:\s*0/.test(ask),
  "global.css .hyperly-ask-scroll",
  "the content lane must be allowed to shrink (min-height: 0)"
);
const bodyRule = css.match(/\.hyperly-overlay-body\s*\{([^}]*)\}/);
expect(!!bodyRule, "global.css", "missing .hyperly-overlay-body rule");
expect(
  /overflow:\s*hidden/.test(bodyRule ? bodyRule[1] : ""),
  "global.css .hyperly-overlay-body",
  "the room body must not scroll itself; only the lane scrolls"
);
expect(
  /\.hyperly-overlay-body > \.hyperly-composer[^}]*flex:\s*0 0 auto/.test(css),
  "global.css .hyperly-overlay-body",
  "composer + action row must be fixed rows (flex: 0 0 auto)"
);

// ---------------------------------------------------------------------------
// 5. JSX wiring.
// ---------------------------------------------------------------------------
const speech = read("src/pages/app/components/speech/index.tsx");
for (const zone of [
  "hyperly-zone-toolbar",
  "hyperly-zone-error",
  "hyperly-zone-actions",
  "hyperly-zone-setup",
]) {
  expect(
    speech.includes(zone),
    "speech/index.tsx",
    `missing ${zone} class (grid row placement breaks without it)`
  );
}
const completion = read("src/pages/app/components/completion/index.tsx");
expect(
  completion.includes('className="hyperly-ask-scroll" ref={completion.scrollAreaRef}'),
  "completion/index.tsx",
  "scrollAreaRef must target the ask-scroll lane (autoscroll + arrow keys)"
);
expect(
  speech.includes('data-testid="listen-streaming-badge"'),
  "speech/index.tsx",
  "streaming badge testid lost"
);
expect(
  speech.includes('data-testid="listen-history-toggle"'),
  "speech/index.tsx",
  "history toggle testid lost"
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`overlay-layout-check: ${failures.length} failure(s):`);
  for (const f of failures) {
    console.error(`  ✗ [${f.where}] ${f.problem}`);
  }
  process.exit(1);
}
console.log("overlay-layout-check: all zone-contract invariants hold");
