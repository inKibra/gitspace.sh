/**
 * GitSpace brand tokens, sampled from web/index.css (default theme).
 * Flat black brutalist: square corners, 1px borders, JetBrains Mono.
 */
export const T = {
  bg: '#000000',
  surface: '#080808',
  elevated: '#0a0a0a',
  backdrop: 'rgba(0, 0, 0, 0.85)',
  border: '#1a1a1a',
  borderMuted: '#111111',
  text: '#e6e6e6',
  textMuted: '#9c9c9c',
  textDim: '#6a6a6a',
  textGhost: '#3a3a3a',
  accent: '#00ff66',
  accentGlow: 'rgba(0, 255, 102, 0.25)',

  // agent states
  running: '#00ff66',
  waiting: '#4488ff', // idle / waiting on you
  needsInput: '#ffcc00', // asked you a question
  error: '#ff5555',
  none: '#282828',
} as const;

export type AgentState = 'running' | 'waiting' | 'needsInput' | 'error' | 'none';

export const stateColor = (s: AgentState): string =>
  s === 'running' ? T.running
  : s === 'waiting' ? T.waiting
  : s === 'needsInput' ? T.needsInput
  : s === 'error' ? T.error
  : T.none;

export const MONO = `'JetBrains Mono', monospace`;
