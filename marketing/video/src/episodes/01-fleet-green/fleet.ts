import type { AgentState } from '../../lib/theme';
import { TL } from './timeline';

export type Col = 'build' | 'docs' | 'review';

export interface Member {
  id: string;
  name: string;
  branch: string;
  col: Col;
  phase: string;
}

export const FLEET: Member[] = [
  { id: 'api', name: 'api-hardening', branch: 'feat/rate-limits', col: 'build', phase: 'build' },
  { id: 'flags', name: 'checkout-flags', branch: 'feat/remove-checkout-v2', col: 'build', phase: 'build' },
  { id: 'retry', name: 'retry-backoff', branch: 'fix/retry-storm', col: 'build', phase: 'build' },
  { id: 'docs', name: 'docs-refresh', branch: 'docs/getting-started', col: 'docs', phase: 'docs' },
  { id: 'relay', name: 'relay-metrics', branch: 'feat/relay-metrics', col: 'review', phase: 'review' },
];

/**
 * State transitions per member. Only blue (idle) and amber (question) problems;
 * both are resolved BY THE USER on camera. No errors, no magic.
 */
const CHANGES: Record<string, Array<{ at: number; to: AgentState }>> = {
  api: [{ at: -1, to: 'running' }],
  flags: [
    { at: -1, to: 'running' },
    { at: TL.flagsAsk, to: 'needsInput' },
    { at: TL.flagsGreen, to: 'running' },
  ],
  retry: [{ at: -1, to: 'running' }],
  docs: [
    { at: -1, to: 'running' },
    { at: TL.docsIdle, to: 'waiting' },
    { at: TL.docsGreen, to: 'running' },
  ],
  relay: [{ at: -1, to: 'running' }],
};

export const stateAt = (id: string, frame: number): AgentState => {
  const changes = CHANGES[id] ?? [];
  let state: AgentState = 'none';
  for (const c of changes) {
    if (c.at <= frame) state = c.to;
  }
  return state;
};

/** Frame of the most recent state change at/before `frame`, for glow pulses. */
export const lastChangeAt = (id: string, frame: number): number | null => {
  const changes = CHANGES[id] ?? [];
  let at: number | null = null;
  for (const c of changes) {
    if (c.at >= 0 && c.at <= frame) at = c.at;
  }
  return at;
};

// Board layout constants (shared with the camera in FleetGreen).
export const BOARD = {
  pad: 90,
  colTop: 176,
  colW: 548,
  colGap: 48,
  colHeaderH: 48,
  cardH: 148,
  cardGap: 20,
} as const;

/** Camera targets: card centers. */
export const FLAGS_CARD_CENTER = {
  x: BOARD.pad + BOARD.colW / 2,
  y: BOARD.colTop + BOARD.colHeaderH + (BOARD.cardH + BOARD.cardGap) + BOARD.cardH / 2,
} as const;

export const DOCS_CARD_CENTER = {
  x: BOARD.pad + BOARD.colW + BOARD.colGap + BOARD.colW / 2,
  y: BOARD.colTop + BOARD.colHeaderH + BOARD.cardH / 2,
} as const;

// Chrome-bar chip geometry: fixed widths so the cursor path is exact.
export const CHIP = {
  stripX0: 370, // where workspace chips start (after wordmark/project/board chip)
  boardW: 130,
  w: 270,
  centerY: 36,
} as const;

export const chipCenterX = (index: number): number => CHIP.stripX0 + index * CHIP.w + CHIP.w / 2;
