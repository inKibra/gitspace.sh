import React from 'react';
import { T, MONO } from '../../../lib/theme';
import { enter } from '../../../lib/ui';

/**
 * BACKGROUND WORK STREAM — the agent is never idle while the story beat lands.
 *
 * A dim, low-contrast band of live tool calls that runs UNDER the hero surface
 * (the workflow diagram, the evidence panels). It's deliberately quiet: you
 * read the headline, and you feel the work happening beneath it.
 *
 * The stream scrolls: only the last few calls stay on screen, older ones slide
 * off the top behind a fade. Every position is a pure function of `frame`.
 */

const C = {
  green: T.running,
  red: '#ff4444',
  blue: T.waiting,
  text: T.text,
  dim: '#7a7a7a',
  ghost: '#3c3c3c',
  border: '#1e1e1e',
  elevated: '#0a0a0a',
} as const;

const ROW_H = 46;
const ROWS = 3; // how many calls stay on screen (kept clear of the caption band)
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export type WorkStep = {
  /** frame the call appears */
  at: number;
  icon: string;
  verb: string;
  target: string;
  /** frame the call resolves (omit to leave it spinning) */
  done?: number;
  result?: string;
  /** false paints the result red — a call that found something wrong */
  ok?: boolean;
};

export const AgentWork: React.FC<{
  frame: number;
  /** frame the band fades in */
  start: number;
  steps: WorkStep[];
  top: number;
  left: number;
  right: number;
  /** multiplied into the band opacity, so the caller can fade it with its scene */
  op?: number;
  label?: string;
}> = ({ frame, start, steps, top, left, right, op = 1, label = 'agent · working' }) => {
  const band = enter(frame, start, 12) * op;
  if (band <= 0.001) return null;

  const live = steps.filter((s) => frame >= s.at);
  // smooth scroll: each call past the window pushes the column up as it lands
  const overflow = steps.reduce(
    (acc, s, i) => (i >= ROWS ? acc + ROW_H * enter(frame, s.at, 10) : acc),
    0,
  );

  return (
    <div style={{ position: 'absolute', top, left, right, opacity: band, fontFamily: MONO }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span style={{ fontSize: 15, letterSpacing: '0.22em', textTransform: 'uppercase', color: C.ghost }}>
          {label}
        </span>
        <span style={{ flex: 1, height: 1, background: C.border }} />
      </div>

      <div style={{ position: 'relative', height: ROWS * ROW_H, overflow: 'hidden' }}>
        <div style={{ transform: `translateY(${-overflow}px)` }}>
          {live.map((s, i) => {
            const resolved = s.done !== undefined && frame >= s.done;
            const rowOp = enter(frame, s.at, 8) * (resolved ? 0.62 : 1);
            const spin = SPIN[Math.floor(frame / 3) % SPIN.length];
            return (
              <div
                key={i}
                style={{
                  height: ROW_H,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  fontSize: 21,
                  opacity: rowOp,
                }}
              >
                <span style={{ color: C.ghost, width: 22 }}>
                  {resolved ? '·' : spin}
                </span>
                <span style={{ color: C.blue }}>{s.icon}</span>
                <span style={{ color: C.ghost }}>{s.verb}</span>
                <span style={{ color: C.dim }}>{s.target}</span>
                {s.result && resolved && (
                  <span
                    style={{
                      marginLeft: 'auto',
                      color: s.ok === false ? C.red : C.green,
                      opacity: enter(frame, s.done ?? 0, 6),
                    }}
                  >
                    {s.result}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {/* older calls slide off behind this fade */}
        <div
          style={{
            position: 'absolute',
            inset: '0 0 auto 0',
            height: 40,
            background: `linear-gradient(${T.bg}, rgba(0,0,0,0))`,
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
};
