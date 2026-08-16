/**
 * Beat grid: 120 BPM at 30fps → 1 beat = 15 frames. Every cut, click, judge,
 * and bloom lands on the grid. Product runs 30 beats (b0–b30); the whole story
 * is one card in the deck (intro 4 beats + product + outro).
 *
 * Two acts:
 *   ACT 1 — SET THE BAR (b0–b14): the human sets the bar, the agent authors
 *     the rubric (two requirements + judges), commands stream in a side panel.
 *   ACT 2 — NOW PROVE IT (b14–b30): the workspace goes BLUE (done, your move),
 *     the rubric fills with evidence, a cursor walks it, both rows accept.
 */
export const BEAT = 15;
export const b = (n: number): number => Math.round(n * BEAT);

export const TL = {
  // ── ACT 1 — SET THE BAR (planning surface) ──
  planIn: 0,
  humanType: b(2), // 30   human types the bar (green authorship)
  agentStart: b(7), // 105  agent begins authoring the rubric
  req1Appear: b(8), // 120  requirement 1 lands · test-output · command judge
  cmd1: b(8), // 120  side-panel: agent ran `space goal requirement add …`
  req2Appear: b(11), // 165  requirement 2 lands · VIDEO · human judge
  cmd2: b(11), // 165  side-panel: second requirement add
  act1End: b(14), // 210

  // ── ACT 2 — NOW PROVE IT (workspace review surface) ──
  slideStart: 210,
  slideEnd: 224,
  agentDone: b(15), // 225  agent's last line: done · ready for your review
  cursorIn: b(15), // 225

  // requirement 1 — command judge
  req1JudgeIn: b(16), // 240  cursor reaches row 1, evidence opens
  req1CmdRun: b(17), // 255  `bun test src/checkout` streams
  req1CmdResult: b(18), // 270  `142 passed · exit 0`
  req1Accept: b(19), // 285  row blooms ACCEPTED (green) — accept cue #1
  aim1: b(19) + 4, // 289  highlight lands on the command judge

  // requirement 2 — video judge
  videoPlay: b(20), // 300  the synthetic checkout clip plays (~2s)
  videoEnd: b(24), // 360
  req2Accept: b(25), // 375  row blooms ACCEPTED (human judge) — accept cue #2
  aim2: b(25) + 4, // 379  highlight lands on the video judge

  // readiness
  readyType: b(27), // 405  "Ready: all required artifacts passed judgment."
  act2End: b(30), // 450
} as const;

/**
 * Deck bookends: global timeline = deck intro (4 beats) + product (30 beats) +
 * outro (tagline, then the stinger). Product-local frames (TL) are offset by
 * DECK.matchCut.
 */
export const DECK = {
  select: 40, // hero (evidence) card glows — thunk
  matchCut: b(4), // 60 — product frame 0
  outStart: b(4) + b(30), // 510 — review board shrinks back into its card
  deckBack: 540, // deck re-racked
  tagDim: 543,
  tagType: 552, // "Agents lie." types over the deck
  stingerType: 630, // "I need proof." types under the tagline
  total: b(48), // 720 — holds through the stinger (24s)
} as const;

/** Cursor click frames (product-local; each gets a click sound + ring). */
export const CLICKS = [
  TL.req1JudgeIn, // open requirement 1's evidence
  TL.videoPlay, // press play on the video evidence
];
