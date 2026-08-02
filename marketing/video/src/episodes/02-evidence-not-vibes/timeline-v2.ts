/**
 * v2 beat grid: 120 BPM at 30fps → 1 beat = 15 frames. NON-DESTRUCTIVE parallel
 * of timeline.ts for `ep02-evidence-v2`.
 *
 * The "walk through a session" arc:
 *   1–2  I THOUGHT I SET THE BAR → THE STUB (Opening) — a plain ask, "✓ tests
 *        pass", then the reveal: checkout() just returns a stub.
 *   3    A BETTER WORKFLOW (RubricForms) — retry with a review-gated workflow;
 *        the naive bar formalizes + expands into a real rubric (① real code,
 *        not a stub · ② the total renders · ③ 0 failures).
 *   4    THE WORKFLOW CATCHES IT (WorkflowSurface) — Builder + Reviewer, the
 *        subordinate gate; the reviewer blocks the stub, loops it back, clears.
 *   5–6  UN-GAMED EVIDENCE → READINESS (Evidence) — the command judge passes,
 *        the real checkout renders, both accept; then "✓ ready".
 *   7    DECK OUTRO — "Agents lie." / "I need proof."
 *
 * Every pivot gets a reaction hold; transitions stay snappy (1 beat).
 */
import { TL } from './timeline';

export const BEAT = 15;
export const b = (n: number): number => Math.round(n * BEAT);

/** ReviewSurface's original-TL events slide this many frames later so the
 *  evidence lands after the gate clears green. 35 beats. */
export const REVIEW_SHIFT = 1020;

export const TLV = {
  // ── BEATS 1–2 — SET THE BAR → THE STUB (Opening) ──
  planIn: 0,
  humanType: TL.humanType, // 30   the plain ask types
  agentStart: TL.agentStart, // 105
  req1Appear: TL.req1Appear, // 120  the agent's "✓ tests pass" claim
  cmd1: TL.cmd1, // 120
  req2Appear: TL.req2Appear, // 165
  cmd2: TL.cmd2, // 165
  crackIn: b(20), // 300  the stub code card fades in
  crackStamp: b(26), // 390  the stub highlights; "✓ tests pass" struck
  //   HOLD b26→b36 — every beat here is sized from the SPEECH, not the other
  //   way round: the screen does a thing, then the speaker reacts to it, then
  //   there is silence, then the surface moves. See MAIN_CAPTIONS in index-v2
  //   for the model that produces the word timings these beats have to fit.

  // ── TRANSITION 1 — THE TURN. Problem to solution, and the only place the
  //    film physically changes direction: both surfaces ride one bent sheet
  //    (see BendFrame) instead of sliding past each other. Three beats long,
  //    because a bend needs room a slide doesn't. ──
  openSlideStart: b(36), // 540
  openSlideEnd: b(39), // 585

  // ── BEAT 3 — A BETTER WORKFLOW: THE RUBRIC FORMS (RubricForms) ──
  sessIn: b(39), // 585  the retry ask types
  rubricIn: b(43), // 645  the rubric card
  req1In: b(44), // 660  ① real checkout, not a stub (callback)
  req2In: b(45) + 8, // 683  ② the total renders
  req3In: b(47), // 705  ③ 0 failures · exit 0
  //   HOLD b45→b53 — the rubric line is nine words long; it needs the room.

  // ── TRANSITION 2 — rubric slides out, workflow slides in ──
  wfSlideStart: b(55), // 825
  wfSlideEnd: b(56), // 840

  // ── BEAT 4 — THE WORKFLOW CATCHES IT (WorkflowSurface) ──
  wfImplementerIn: b(56), // 840
  wfConnectorIn: b(57), // 855
  wfReviewerIn: b(57) + 8, // 863
  wfGateIn: b(58), // 870
  wfLoopIn: b(58), // 870
  wfCatch: b(63), // 945  gate ✕ RED, loops back to the builder
  //   HOLD b61→b69 — dread. Long enough for a ten-word line to land in it.
  wfFix: b(71), // 1065
  wfGateGreen: b(72), // 1080  gate ✓ cleared; barrier lifts
  //   HOLD b70→b80 — the green lands, then the line clears before the cut.

  // ── TRANSITION 3 — workflow slides out, evidence slides in ──
  rvSlideStart: b(82), // 1230
  rvSlideEnd: b(83), // 1245

  productEnd: b(104), // 1560
} as const;

/** ReviewSurface/Evidence events in v2 product-local frames (original TL +
 *  REVIEW_SHIFT). Evidence reads these directly. */
export const RV = {
  agentDone: TL.agentDone + REVIEW_SHIFT, // 750
  cursorIn: TL.cursorIn + REVIEW_SHIFT, // 750
  req1JudgeIn: TL.req1JudgeIn + REVIEW_SHIFT, // 765
  req1CmdRun: TL.req1CmdRun + REVIEW_SHIFT, // 780
  req1CmdResult: TL.req1CmdResult + REVIEW_SHIFT, // 795
  req1Accept: TL.req1Accept + REVIEW_SHIFT, // 810
  aim1: TL.aim1 + REVIEW_SHIFT, // 814
  videoPlay: TL.videoPlay + REVIEW_SHIFT, // 825
  videoEnd: TL.videoEnd + REVIEW_SHIFT, // 885
  req2Accept: TL.req2Accept + REVIEW_SHIFT, // 900
  aim2: TL.aim2 + REVIEW_SHIFT, // 904
  readyType: TL.readyType + REVIEW_SHIFT, // 930
  act2End: TL.act2End + REVIEW_SHIFT, // 975
} as const;

/**
 * Deck bookends: deck intro (4 beats) + product (65 beats) + outro. Product-
 * local frames (TLV/RV) are offset by DECK.matchCut.
 */
/** A 5s intro: the deck starts fully dissolved and resolves as the camera
 *  zooms in, so the dust has room to read. Everything downstream shifts by the
 *  same 90 frames (captions/pad compensate via CAP_SHIFT). */
export const DECK = {
  select: 128, // hero card glows near the end of the approach
  matchCut: 150, // product frame 0
  outStart: 150 + b(104), // 1710 — board shrinks back into its card
  deckBack: 1740,
  tagDim: 1743,
  tagType: 1752, // "Agents lie." types over the deck
  stingerType: 1830, // "I need proof." types under the tagline
  /** The whole frame goes to sand: the deck fades out under the type while the
   *  type itself comes apart and blows away. This IS the fade to black. */
  sandStart: 1873,
  sandEnd: 1929,
  total: 1935, // holds through the stinger (64.5s; pad-long is 68s)
} as const;

/**
 * THE THREE MOMENTS A PERSON ACTS.
 *
 * ep01 is a user-driven story, so it has a cursor throughout. ep02 is an
 * AGENT-driven story: for most of its runtime you are reading, not doing, and
 * a cursor on screen would be a lie about who is working. But there are
 * exactly three beats where a human does something, and right now they happen
 * by themselves, which is why those beats feel flatter than ep01's.
 *
 * The cursor appears only for these, and leaves straight after. Each gets the
 * same click punch ep01 uses.
 */
export const ACTS = [
  /** click into the composer, then type the naive ask */
  { at: TLV.humanType - 10, x: 470, y: 995 },
  /** open the file — this is what makes the stub pop-up appear */
  { at: TLV.crackIn - 12, x: 430, y: 392 },
  /** click into the composer again for the retry */
  { at: TLV.sessIn - 10, x: 470, y: 995 },
  /** pay — the human presses the button, and THEN it says Paid. The evidence
   *  is a real transaction someone made, not a screenshot that appeared. */
  { at: RV.videoPlay + 18, x: 1380, y: 462 },
] as const;

