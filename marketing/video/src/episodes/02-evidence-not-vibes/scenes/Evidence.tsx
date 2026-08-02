import React from 'react';
import { AbsoluteFill } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, pulse } from '../../../lib/ui';
import { RV } from '../timeline-v2';
import { AgentWork, type WorkStep } from './AgentWork';

/**
 * BEATS 5–6 — UN-GAMED EVIDENCE (side by side) → READINESS (sleek marketing).
 *
 * The payoff, side by side: the same test file that was stubbed now calls the
 * REAL checkout (green — the callback), passing; next to it the real checkout
 * renders and gets paid. Both accept. Then one readiness line. This evidence
 * is trustworthy because it already survived the gate. Pure function of frame.
 */

const C = {
  green: T.running,
  amber: T.needsInput,
  red: '#ff4444',
  text: T.text,
  dim: '#7a7a7a',
  ghost: '#3c3c3c',
  border: '#1e1e1e',
  elevated: '#0a0a0a',
  bar: '#242424',
} as const;

const Bars: React.FC<{ widths: number[] }> = ({ widths }) => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'center', height: 18 }}>
    {widths.map((w, i) => (
      <div key={i} style={{ width: w, height: 9, background: C.bar, borderRadius: 2 }} />
    ))}
  </div>
);

const Accepted: React.FC<{ op: number }> = ({ op }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, border: `1px solid ${C.green}`, color: C.green, fontSize: 21, fontWeight: 700, padding: '6px 16px', opacity: op }}>
    ✓ accepted
  </span>
);

/**
 * The evidence doesn't just appear — the agent goes and gets it, under the
 * panels. Each capture lands a moment before the panel above it accepts, and
 * the readiness check resolves right before "✓ ready".
 */
const WORK: WorkStep[] = [
  { at: 1265, icon: '⧉', verb: 'run', target: 'bun test src/checkout', done: 1290, result: '142 pass · 0 fail' },
  { at: 1295, icon: '◉', verb: 'capture', target: 'checkout · pay $90.72', done: 1325, result: 'paid' },
  { at: 1335, icon: '✎', verb: 'attach', target: 'evidence/req-1.json', done: 1355, result: 'stored' },
  { at: 1360, icon: '✎', verb: 'attach', target: 'evidence/req-2.json', done: 1380, result: 'stored' },
  { at: 1388, icon: '⚑', verb: 'check', target: 'readiness', done: 1408, result: 'all requirements accepted' },
];

export const Evidence: React.FC<{ frame: number }> = ({ frame }) => {
  const ev = enter(frame, RV.req1JudgeIn, 12) * (1 - enter(frame, RV.readyType - 12, 12));
  const ready = enter(frame, RV.readyType - 4, 12);

  const result = frame >= RV.req1CmdResult;
  const paid = frame >= RV.videoPlay + 26;

  return (
    // transparent: the shader field behind Product shows through the gaps,
    // the same way the site's hero sits under its content
    <AbsoluteFill style={{ fontFamily: MONO }}>
      {/* kicker */}
      <div style={{ position: 'absolute', top: 108, left: 0, width: 1920, textAlign: 'center', fontSize: 20, letterSpacing: '0.4em', textTransform: 'uppercase', color: C.ghost, opacity: enter(frame, RV.req1JudgeIn - 10, 10) }}>
        now it&apos;s real · the evidence
      </div>

      {/* ── side by side ── */}
      <div style={{ position: 'absolute', top: 210, left: 150, right: 150, display: 'flex', gap: 60, opacity: ev }}>
        {/* LEFT — the same test, now on the REAL code (the callback) */}
        <div style={{ flex: 1 }}>
          <div style={{ border: `1px solid ${C.border}`, background: C.elevated }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: C.green }} />
              <span style={{ fontSize: 18, color: C.dim }}>checkout.test.ts</span>
            </div>
            <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <Bars widths={[140, 80]} />
              <div style={{ padding: '10px 14px', borderLeft: `3px solid ${C.green}`, background: 'rgba(0,255,102,0.06)' }}>
                <div style={{ fontSize: 23, color: C.text }}>function checkout() {'{'}</div>
                <div style={{ fontSize: 23, marginLeft: 28, color: C.text }}>
                  return computeTotal(cart) <span style={{ color: C.green }}>// real</span>
                </div>
                <div style={{ fontSize: 23, color: C.text }}>{'}'}</div>
              </div>
              <Bars widths={[110, 170]} />
              <div style={{ marginTop: 6, height: 1, background: C.border }} />
              <div style={{ fontSize: 25, color: result ? C.green : C.dim, opacity: result ? enter(frame, RV.req1CmdResult, 6) : 1 }}>
                {result ? '142 pass · 0 fail · exit 0' : 'running…'}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 18 }}><Accepted op={enter(frame, RV.req1Accept, 8)} /></div>
        </div>

        {/* RIGHT — the real checkout renders and gets paid */}
        <div style={{ flex: 1 }}>
          <div style={{ border: `1px solid ${C.border}`, background: C.elevated, padding: '22px 26px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 20, color: C.dim, marginBottom: 14 }}>
              <span>acme · checkout</span>
              <span style={{ color: C.red }}>● live</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, color: C.text, marginTop: 8 }}><span>Sneakers × 1</span><span>$84.00</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, color: C.dim, marginTop: 8 }}><span>Tax</span><span>$6.72</span></div>
            <div style={{ height: 1, background: C.border, margin: '16px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 30, fontWeight: 700, color: C.text }}><span>Total</span><span style={{ color: C.green }}>$90.72</span></div>
            <div style={{ marginTop: 18, textAlign: 'center', fontSize: 25, fontWeight: 700, color: paid ? '#001b0c' : C.dim, background: paid ? C.green : '#0f0f0f', border: paid ? 'none' : `1px solid ${C.border}`, padding: '12px 0', opacity: enter(frame, RV.videoPlay, 8) }}>
              {paid ? '✓ Paid' : 'Pay $90.72'}
            </div>
          </div>
          <div style={{ marginTop: 18 }}><Accepted op={enter(frame, RV.req2Accept, 8)} /></div>
        </div>
      </div>

      {/* the agent collecting it, under the panels */}
      <AgentWork frame={frame} start={RV.req1JudgeIn + 2} steps={WORK} top={700} left={150} right={150} op={ev} />

      {/* ── readiness ── */}
      <div style={{ position: 'absolute', top: 430, left: 0, width: 1920, textAlign: 'center', opacity: ready }}>
        <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: '-0.02em', color: C.green, textShadow: `0 0 ${18 + pulse(frame, RV.readyType, 30) * 26}px rgba(0,255,102,0.4)` }}>
          ✓ ready
        </div>
      </div>
    </AbsoluteFill>
  );
};
