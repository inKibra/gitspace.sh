/**
 * ep03 — THE CHANGE GUIDE. Beat grid solved FROM the speech (the ep02 rule:
 * captions are laid out by the prosody model, then the screen events are
 * placed just before the line that reacts to them). Regenerate with
 * /tmp/solve03.mjs rather than hand-editing.
 *
 * The arc:
 *   1  the PR lands — fourteen files, alphabetical (PrWall)
 *   2  reading top to bottom betrays you — the first file needs the last
 *   3  THE TURN (bend, one sheet): pages → story
 *   4  the analyzer reorders the wall into four beats (GuideBeats)
 *   5  a beat narrates itself from the journal, beats check off, ✓ reviewed
 *   6  deck outro → tagline → sand
 */
export const BEAT = 15;
export const b = (n: number): number => Math.round(n * BEAT);

export const TL = {
  // ── ACT 1 — THE WALL (PrWall) ──
  prIn: 15, // the PR header + file list arrive
  actOpen: 40, // the human clicks "files changed · 14" (cursor + punch + click)
  scroll: 150, // the list starts crawling — reading top to bottom
  stall: 283, // the crawl stops dead: first file ↔ last file, red dependency
  //   L3 "Oh." reacts 24 frames later; L4 is the turn.

  // ── THE TURN — one bent sheet: the wall folds away, the guide unfolds ──
  openSlideStart: 555,
  openSlideEnd: 600,

  // ── ACT 2 — THE GUIDE (GuideBeats) ──
  reorder: 608, // fourteen rows fly from list order to build order
  badges: 756, // cluster cards + order badges land (1/4 … 4/4)
  actBeat: 826, // the human clicks beat 1 (cursor + punch + click)
  journal: 850, // the journal quote card opens under beat 1
  checks: 999, // beats check off in build order
  stamp: 1124, // ✓ reviewed · 14 files · 4 beats
  productEnd: 1260,
} as const;

/** Deck bookends — the series signature: 5s dust intro, sand ending. */
export const DECK = {
  select: 128,
  matchCut: 150, // product frame 0
  outStart: 150 + TL.productEnd, // 1410
  deckBack: 1440,
  tagDim: 1443,
  tagType: 1452, // "A diff is not a story." types over the deck
  stingerType: 1530, // "Read it in build order."
  sandStart: 1573,
  sandEnd: 1629,
  total: 1635, // 54.5s — pad-long is 68s
} as const;

/** The two moments a human acts (cursor + click punch + click.wav). */
export const ACTS = [
  { at: TL.actOpen, x: 472, y: 182 }, // open "files changed · 14"
  { at: TL.actBeat, x: 500, y: 420 }, // open beat 1
] as const;
