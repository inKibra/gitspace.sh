/**
 * ep04 — SHIPPED ISN'T DONE. Beats solved FROM the speech (/tmp/solve04.mjs);
 * regenerate there rather than hand-editing.
 *
 * The arc:
 *   1  the chain ships in order (ChainBoard) — workspaces come and go
 *   2  the last goal merges. Everything says done. The FALSE green.
 *   3  THE TURN (bend): done → the morning after
 *   4  the goal's dashboard; the cron refreshes it nightly (MorningOps)
 *   5  day two: the error rate crosses the rubric line, the SHIPPED GOAL
 *      REOPENS with the rubric quoted, and it's just a new amber
 *   6  deck outro → tagline → sand
 */
export const BEAT = 15;
export const b = (n: number): number => Math.round(n * BEAT);

export const TL = {
  // ── ACT 1 — THE CHAIN (ChainBoard) ──
  chainIn: 15, // the four-goal track arrives
  ship3: 146, // checkout-flags ships: workspace out, checkout-e2e binds
  actShip: 225, // the human approves the LAST ship (cursor + punch + click)
  ship4: 240, // checkout-e2e merges
  allGreen: 268, // chain complete · 4/4 merged — everything says done

  // ── THE TURN — done folds away, the morning after unfolds ──
  openSlideStart: 510,
  openSlideEnd: 555,

  // ── ACT 2 — THE MORNING AFTER (MorningOps) ──
  dashIn: 561, // the dashboard the goal left behind (stale · 8h ago)
  cron: 585, // nightly trigger fires; tiles refresh; commit rolls up
  day2: 720, // the date advances
  amber: 735, // error rate 0.14% crosses the rubric's 0.10%
  reopen: 863, // the shipped goal REOPENS, rubric line quoted
  actOpen: 940, // the human clicks the reopened goal (cursor + punch + click)
  fleet: 984, // the fleet strip: it's just a new amber
  productEnd: 1140,
} as const;

/** Deck bookends — the series signature. */
export const DECK = {
  select: 128,
  matchCut: 150,
  outStart: 150 + TL.productEnd, // 1290
  deckBack: 1320,
  tagDim: 1323,
  tagType: 1332, // "Shipped isn't done."
  stingerType: 1410, // "Merge is the midpoint."
  sandStart: 1453,
  sandEnd: 1509,
  total: 1515, // 50.5s — pad-long is 68s
} as const;

/** The two moments a human acts. */
export const ACTS = [
  { at: TL.actShip, x: 1560, y: 430 }, // approve the last ship
  { at: TL.actOpen, x: 640, y: 598 }, // open the reopened goal
] as const;
