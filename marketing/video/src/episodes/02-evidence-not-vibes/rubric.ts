import { TL } from './timeline';

/**
 * The bar and the two requirements that prove it. The HUMAN sets the bar (green
 * authorship, #00ff66); the AGENT authors the rubric (blue authorship,
 * #4488ff). Each requirement carries a judge and what it's "aimed at".
 */

export const HUMAN_LINE =
  "Refactor checkout. I need proof, not a summary. Write the checks so you can't game them.";

/** The commands the AGENT runs to author each requirement (side panel). */
export const AGENT_CMDS = [
  'space goal requirement add "Checkout suite passes" \\',
  '  --kind test-output --judge command --expect exit-zero',
  'space goal requirement add "Checkout flow works" \\',
  '  --kind video --judge human',
] as const;

export interface Requirement {
  id: 'suite' | 'flow';
  title: string;
  kind: string; // artifact kind
  judge: string; // command | human
  expect: string;
  artifact: string;
  aim: string; // "aimed at …" — what the judge was pointed at
  appear: number; // pf it lands in the plan (Act 1)
  accept: number; // pf its row blooms ACCEPTED (Act 2)
  aimAt: number; // pf the "aimed at" highlight lands
}

export const REQS: Requirement[] = [
  {
    id: 'suite',
    title: 'Checkout suite passes',
    kind: 'test-output',
    judge: 'command',
    expect: 'exit-zero',
    artifact: 'test-run.json',
    aim: 'aimed at: the checkout suite specifically',
    appear: TL.req1Appear,
    accept: TL.req1Accept,
    aimAt: TL.aim1,
  },
  {
    id: 'flow',
    title: 'Checkout flow works',
    kind: 'video',
    judge: 'human',
    expect: 'order total renders',
    artifact: 'checkout-flow.webm',
    aim: 'aimed at: the rendered order total',
    appear: TL.req2Appear,
    accept: TL.req2Accept,
    aimAt: TL.aim2,
  },
];

/** Requirement-row status over product-local frames (Act 2). */
export type ReqStatus = 'pending' | 'judging' | 'accepted';

export const reqStatusAt = (r: Requirement, pf: number): ReqStatus => {
  if (pf >= r.accept) return 'accepted';
  if (r.id === 'suite' && pf >= TL.req1CmdRun) return 'judging';
  if (r.id === 'flow' && pf >= TL.videoPlay) return 'judging';
  return 'pending';
};

// ── chrome-bar chip geometry (fixed widths → deterministic cursor path) ──
export type ChipState = 'green' | 'blue';
export interface Chip {
  id: string;
  name: string;
  state: ChipState;
}

/** The active workspace goes BLUE — idle, done, waiting on you (ep01 continuity). */
export const FLEET: Chip[] = [
  { id: 'api', name: 'api-hardening', state: 'green' },
  { id: 'checkout', name: 'checkout-refactor', state: 'blue' },
  { id: 'relay', name: 'relay-metrics', state: 'green' },
  { id: 'docs', name: 'docs-refresh', state: 'green' },
];

export const CHIP = {
  stripX0: 370,
  goalW: 130,
  w: 270,
  centerY: 36,
} as const;

export const chipCenterX = (index: number): number => CHIP.stripX0 + index * CHIP.w + CHIP.w / 2;
