import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, typed, Caret, pulse } from '../../../lib/ui';
import { TLV } from '../timeline-v2';

/**
 * BEATS 1–2 — "I THOUGHT I SET THE BAR" → THE STUB (a real workspace chat).
 *
 * A proper agent conversation:
 *   1. you type the task in the composer, hit send — it moves INTO the
 *      transcript as your turn and the composer clears.
 *   2. the agent actually WORKS: edits src/checkout.ts, runs the suite (real
 *      tool-use blocks), then reports "✓ tests pass".
 *   3. THEN you open the file and a pop-up reveals the truth on top: the test's
 *      checkout() just returns a stub.
 * Pure function of frame.
 */

const C = {
  green: T.running,
  red: '#ff4444',
  amber: T.needsInput,
  blue: T.waiting,
  text: T.text,
  dim: '#7a7a7a',
  ghost: '#3c3c3c',
  border: '#1e1e1e',
  elevated: '#0a0a0a',
  bar: '#242424',
} as const;

const LEFT = 150;
const RIGHT = 150;
const MSG = 'refactor checkout. just make sure it works.';
const SEND = 74; // frame the message sends (typing done → transcript)

const Bars: React.FC<{ widths: number[] }> = ({ widths }) => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center', height: 20 }}>
    {widths.map((w, i) => (
      <div key={i} style={{ width: w, height: 10, background: C.bar, borderRadius: 2 }} />
    ))}
  </div>
);

/** A real tool-use block: icon · verb · target · (result). */
const Tool: React.FC<{ icon: string; verb: string; target: string; meta?: string; result?: React.ReactNode; op: number }> = ({ icon, verb, target, meta, result, op }) => (
  <div style={{ border: `1px solid ${C.border}`, background: C.elevated, padding: '12px 18px', marginTop: 12, opacity: op, transform: `translateY(${(1 - op) * 8}px)` }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 23 }}>
      <span style={{ color: C.blue }}>{icon}</span>
      <span style={{ color: C.dim }}>{verb}</span>
      <span style={{ color: C.text }}>{target}</span>
      {meta && <span style={{ marginLeft: 'auto', color: C.dim, fontSize: 20 }}>{meta}</span>}
    </div>
    {result && <div style={{ fontSize: 22, marginTop: 8, marginLeft: 36 }}>{result}</div>}
  </div>
);

export const Opening: React.FC<{ frame: number }> = ({ frame }) => {
  const msg = typed(MSG, frame, TLV.humanType, 1.25);
  /** Only while a person is actually at the keyboard: first keystroke → send. */
  const typing = frame >= TLV.humanType && frame < SEND;
  const sent = frame >= SEND;

  // the discovery pop-up rides on TOP of the chat, after the agent reports done
  const pop = enter(frame, TLV.crackIn, 12);
  const popScale = interpolate(pop, [0, 1], [0.96, 1]);
  const hot = frame >= TLV.crackStamp;
  const glow = hot ? 6 + pulse(frame % 40, 0, 40) * 8 : 0;

  return (
    // transparent: the shader field behind Product shows through the gaps,
    // the same way the site's hero sits under its content
    <AbsoluteFill style={{ fontFamily: MONO }}>
      {/* ── the chat (dims when the pop-up lands) ──
          NOTE: dimmed with a black scrim ON TOP, never with `opacity` on this
          wrapper. An opacity < 1 promotes the subtree to its own compositing
          layer, and a composited layer inside a `layoutsubtree` canvas escapes
          html-in-canvas entirely: it is not captured, and paints straight to
          the page instead. That is why this chat used to sit flat and unbent
          through the fold — and almost certainly why the deck's hero card
          never dissolved either. Keep this subtree layer-free. */}
      <AbsoluteFill>
        <div style={{ position: 'absolute', top: 100, left: LEFT, display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span style={{ fontSize: 28, fontWeight: 600, color: C.text }}>checkout-refactor</span>
          <span style={{ fontSize: 20, color: C.dim }}>· agent · turn 18</span>
        </div>

        {/* your turn — the sent message sits in the transcript */}
        {sent && (
          <div style={{ position: 'absolute', top: 160, right: RIGHT, maxWidth: 900, opacity: enter(frame, SEND, 8) }}>
            <div style={{ fontSize: 16, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.dim, textAlign: 'right', marginBottom: 8 }}>you</div>
            <div style={{ display: 'inline-block', border: `1px solid ${C.border}`, background: '#0c0c0c', padding: '14px 22px', fontSize: 24, color: C.green }}>{MSG}</div>
          </div>
        )}

        {/* agent turn — it actually works, then reports */}
        <div style={{ position: 'absolute', top: 288, left: LEFT, right: RIGHT, opacity: enter(frame, TLV.agentStart, 10) }}>
          <div style={{ fontSize: 16, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.blue, marginBottom: 12 }}>agent</div>
          <div style={{ fontSize: 24, color: C.text }}>refactoring the checkout totals…</div>
          <Tool icon="✎" verb="edit" target="src/checkout.ts" meta="+38 −12" op={enter(frame, TLV.req1Appear, 10)} />
          <Tool
            icon="⧉"
            verb="run"
            target="bun test src/checkout"
            op={enter(frame, TLV.req1Appear + 22, 10)}
            result={frame >= TLV.req2Appear ? <span style={{ color: C.green, opacity: enter(frame, TLV.req2Appear, 8) }}>142 pass · 0 fail · exit 0</span> : <span style={{ color: C.dim }}>running…</span>}
          />
          <div style={{ fontSize: 30, fontWeight: 700, color: C.green, marginTop: 18, opacity: enter(frame, TLV.req2Appear + 12, 8) }}>✓ done. tests pass, all green.</div>
        </div>

        {/* composer — types your message, then clears on send */}
        <div style={{ position: 'absolute', bottom: 54, left: LEFT, right: RIGHT, display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${C.border}`, background: C.elevated, padding: '16px 20px' }}>
          <span style={{ fontSize: 22, color: C.blue }}>›</span>
          {sent ? (
            <span style={{ fontSize: 24, color: C.ghost }}>message the agent</span>
          ) : (
            <span style={{ fontSize: 24, color: C.text }}>{msg}</span>
          )}
          {/* The caret belongs to the ACT of typing. It used to blink whenever
              this scene existed, which meant it was still blinking inside the
              hero card during the deck intro — a cursor pulsing away in a
              workspace nobody had touched yet, visible right through the match
              cut. It now exists only between the first keystroke and send. */}
          {typing && <Caret frame={frame} height={22} color={C.text} />}
        </div>
      </AbsoluteFill>

      {/* the dim, as a scrim rather than an opacity layer */}
      <AbsoluteFill style={{ background: `rgba(0,0,0,${0.55 * pop})`, pointerEvents: 'none' }} />

      {/* ── the discovery pop-up, on TOP, after ── */}
      {frame >= TLV.crackIn && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 316,
            transform: `translateX(-50%) translateY(${(1 - pop) * 18}px) scale(${popScale})`,
            width: 820,
            border: `1px solid ${hot ? C.red : C.border}`,
            background: '#050505',
            boxShadow: `0 30px 90px rgba(0,0,0,0.75)${hot ? `, 0 0 ${glow}px rgba(255,68,68,0.25)` : ''}`,
            opacity: pop,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 22px', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: C.red }} />
            <span style={{ fontSize: 19, color: C.dim }}>checkout.test.ts</span>
            <span style={{ marginLeft: 'auto', fontSize: 18, color: C.dim }}>you open the file</span>
          </div>
          <div style={{ padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 13 }}>
            <Bars widths={[150, 90]} />
            <Bars widths={[210]} />
            <div style={{ margin: '4px 0', padding: '11px 16px', borderLeft: `3px solid ${C.amber}`, background: 'rgba(255,204,0,0.07)' }}>
              <div style={{ fontSize: 25, color: C.text }}>function checkout() {'{'}</div>
              <div style={{ fontSize: 25, marginLeft: 32, color: C.text }}>
                return {'{'} total: 90.72 {'}'} <span style={{ color: C.amber }}>// stubbed</span>
              </div>
              <div style={{ fontSize: 25, color: C.text }}>{'}'}</div>
            </div>
            <Bars widths={[120, 190]} />
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
