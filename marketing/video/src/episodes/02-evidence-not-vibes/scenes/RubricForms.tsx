import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, typed, Caret } from '../../../lib/ui';
import { TLV } from '../timeline-v2';

/**
 * BEAT 3 — "A BETTER WORKFLOW": TALKING TO THE AGENT (same chat).
 *
 * Same workspace conversation as the naive opening. You send the same intent;
 * this time the agent evokes the `review-gated-implementation` skill (a tool
 * block) and writes the rubric. You state intent — the agent enumerates the
 * facets; they scroll and settle on the one that catches the stub. Pure fn of
 * frame.
 */

const C = {
  green: T.running,
  amber: T.needsInput,
  blue: T.waiting,
  purple: '#bc8cff',
  text: T.text,
  dim: '#7a7a7a',
  ghost: '#3c3c3c',
  border: '#1e1e1e',
  elevated: '#0a0a0a',
} as const;

const FACETS: string[] = [
  'the user’s intent is preserved, not just the task wording',
  'no old behavior survives behind a new name',
  'green tests are not accepted as proof by themselves',
  'protected boundaries are unchanged',
  'tests exercise the REAL checkout, not a stub',
  'the order total renders on screen for a human',
  'the suite runs clean · 0 failures · exit 0',
];
const KEY = 4;
const ITEM = 54;
const VH = 300;
const START_Y = 150;
const END_Y = VH / 2 - ITEM / 2 - KEY * ITEM;

const LEFT = 150;
const RIGHT = 150;
const MSG = 'refactor checkout';
const SEND = TLV.sessIn + 22;

export const RubricForms: React.FC<{ frame: number }> = ({ frame }) => {
  const msg = typed(MSG, frame, TLV.sessIn, 1.6);
  const sent = frame >= SEND;

  const agentOp = enter(frame, TLV.rubricIn - 22, 10);
  const scrollY = interpolate(frame, [TLV.rubricIn, TLV.req3In], [START_Y, END_Y], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const settled = enter(frame, TLV.req3In - 6, 12);

  return (
    // transparent: the shader field behind Product shows through the gaps,
    // the same way the site's hero sits under its content
    <AbsoluteFill style={{ fontFamily: MONO }}>
      {/* session header */}
      <div style={{ position: 'absolute', top: 100, left: LEFT, display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span style={{ fontSize: 28, fontWeight: 600, color: C.text }}>checkout-refactor</span>
        <span style={{ fontSize: 20, color: C.dim }}>· agent · turn 19</span>
      </div>

      {/* your turn — the sent message in the transcript */}
      {sent && (
        <div style={{ position: 'absolute', top: 156, right: RIGHT, opacity: enter(frame, SEND, 8) }}>
          <div style={{ fontSize: 16, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.dim, textAlign: 'right', marginBottom: 8 }}>you</div>
          <div style={{ display: 'inline-block', border: `1px solid ${C.border}`, background: '#0c0c0c', padding: '14px 22px', fontSize: 24, color: C.green }}>{MSG}</div>
        </div>
      )}

      {/* agent turn — evokes the skill, writes the rubric */}
      <div style={{ position: 'absolute', top: 262, left: LEFT, right: RIGHT, opacity: agentOp }}>
        <div style={{ fontSize: 16, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.blue, marginBottom: 12 }}>agent</div>
        {/* the skill as a tool block */}
        <div style={{ border: `1px solid ${C.border}`, background: C.elevated, padding: '12px 18px', display: 'flex', alignItems: 'center', gap: 12, fontSize: 22 }}>
          <span style={{ color: C.purple }}>⚡ workflow</span>
          <span style={{ color: C.purple }}>review-gated-implementation</span>
          <span style={{ marginLeft: 'auto', color: C.dim, fontSize: 20 }}>writing the rubric…</span>
        </div>

        {/* the rubric — the agent's facets scroll and settle on the callback */}
        <div style={{ position: 'relative', width: '100%', height: VH, overflow: 'hidden', border: `1px solid ${C.border}`, borderTop: 'none', background: C.elevated }}>
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: VH / 2 - ITEM / 2,
              height: ITEM,
              borderTop: `1px solid ${settled > 0.4 ? 'rgba(255,204,0,0.4)' : C.border}`,
              borderBottom: `1px solid ${settled > 0.4 ? 'rgba(255,204,0,0.4)' : C.border}`,
              background: settled > 0.4 ? 'rgba(255,204,0,0.06)' : 'transparent',
            }}
          />
          <div style={{ position: 'absolute', left: 0, right: 0, transform: `translateY(${scrollY}px)` }}>
            {FACETS.map((f, i) => {
              const centerY = i * ITEM + ITEM / 2 + scrollY;
              const dist = Math.abs(centerY - VH / 2);
              const op = Math.max(0.12, Math.min(1, 1.14 - dist / 130));
              const isKey = i === KEY;
              return (
                <div key={i} style={{ height: ITEM, display: 'flex', alignItems: 'center', gap: 16, padding: '0 26px', opacity: op }}>
                  <span style={{ fontSize: 19, color: isKey ? C.amber : C.ghost, flex: 'none' }}>{isKey ? '◆' : '·'}</span>
                  <span style={{ fontSize: 25, color: isKey && settled > 0.4 ? C.amber : C.text }}>
                    {isKey ? (
                      <>tests exercise the <span style={{ color: C.amber }}>real checkout</span>, not a stub</>
                    ) : (
                      f
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

      </div>

      {/* composer — types your message, clears on send */}
      <div style={{ position: 'absolute', bottom: 54, left: LEFT, right: RIGHT, display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${C.border}`, background: C.elevated, padding: '16px 20px' }}>
        <span style={{ fontSize: 22, color: C.blue }}>›</span>
        {sent ? <span style={{ fontSize: 24, color: C.ghost }}>message the agent</span> : <span style={{ fontSize: 24, color: C.text }}>{msg}</span>}
        {/* same rule as Opening: a caret only exists while someone is typing */}
        {frame >= TLV.sessIn && !sent && <Caret frame={frame} height={22} color={C.text} />}
      </div>
    </AbsoluteFill>
  );
};
