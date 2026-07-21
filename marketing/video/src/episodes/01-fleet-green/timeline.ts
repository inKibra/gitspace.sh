/**
 * Beat grid: 120 BPM at 30fps → 1 beat = 15 frames. Every cut, click, and
 * state change lands on the grid. Total: 32 beats = 480 frames = 16s.
 */
export const BEAT = 15;
export const b = (n: number): number => Math.round(n * BEAT);

export const TL = {
  // act 1 — the fleet, then two dots turn
  docsIdle: b(4), // 60  docs-refresh → blue (droplet)
  flagsAsk: b(5), // 75  checkout-flags → amber (droplet + badge)
  cursorIn: b(6), // 90
  clickFlagsChip: b(7), // 105
  pushStart: 110,
  pushEnd: 124,

  // act 2 — answer the question (contained modal)
  modalIn: b(10), // 150
  clickOption: b(13), // 195
  clickSubmit: b(15), // 225
  modalOutStart: 229,
  modalGone: 243,
  flagsGreen: b(16), // 240 (bloom)

  // act 3 — give the idle agent direction
  clickDocsChip: b(18), // 270
  slideStart: 272,
  slideEnd: 284,
  clickInput: 295,
  typeStart: b(20), // 300
  clickSend: 336,
  docsGreen: b(23), // 345 (bloom)

  // act 4 — all green
  pullStart: b(24), // 360
  pullEnd: 374,
} as const;

/**
 * Deck bookends: the whole product story is one snippet card in a 3D deck.
 * Global timeline = deck intro (3 beats) + product (26 beats) + deck outro.
 * Product-local frames (TL above) are offset by DECK.matchCut.
 */
export const DECK = {
  select: 40, // hero card glows (thunk)
  matchCut: b(4), // 60 — product frame 0
  outStart: b(4) + b(26), // 450 — board shrinks back into its card
  deckBack: 480, // deck re-racked
  tagDim: 483,
  tagType: 492, // "keep your fleet green." types over the deck
  total: b(38), // 570 — holds through the end of the VO's last line
} as const;

/** Cursor click frames (each gets a click sound + ring). */
export const CLICKS = [
  TL.clickFlagsChip,
  TL.clickOption,
  TL.clickSubmit,
  TL.clickDocsChip,
  TL.clickInput,
  TL.clickSend,
];
