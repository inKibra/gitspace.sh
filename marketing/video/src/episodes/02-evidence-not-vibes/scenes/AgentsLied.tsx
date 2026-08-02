import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, pulse } from '../../../lib/ui';
import { TLV } from '../timeline-v2';

/**
 * BEAT 2 — AGENTS LIED. The pain that motivates the whole workflow. An agent's
 * summary reads "✓ tests pass" in green; then it CRACKS and gets stamped in
 * amber-red: "✕ the test never ran your code." This is the film's title made
 * literal ("Agents lie."). A stark card over the planning surface — fast and
 * sharp. Pure function of frame.
 */

const GREEN = T.running; // the false green claim
const RED = '#ff4444';
const AMBER = T.needsInput; // #ffcc00
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const AgentsLied: React.FC<{ frame: number }> = ({ frame }) => {
  const scrim = interpolate(frame, [TLV.crackIn, TLV.crackIn + 10], [0, 0.72], clamp);
  const cardOp = enter(frame, TLV.crackIn, 8);
  const rise = (1 - cardOp) * 22;

  const cracked = frame >= TLV.crackStamp;
  // a hard shake at the stamp, decaying over ~10 frames
  const shakeT = interpolate(frame, [TLV.crackStamp, TLV.crackStamp + 12], [1, 0], clamp);
  const shake = cracked ? Math.sin((frame - TLV.crackStamp) * 2.1) * 7 * shakeT : 0;
  const stampScale = cracked ? 1 + 0.14 * interpolate(frame, [TLV.crackStamp, TLV.crackStamp + 6], [1, 0], { ...clamp, easing: Easing.out(Easing.cubic) }) : 1;
  const borderFlash = pulse(frame, TLV.crackStamp, 16);

  return (
    <AbsoluteFill style={{ background: `rgba(0,0,0,${scrim})`, fontFamily: MONO }}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            width: 1180,
            border: `1px solid ${cracked ? RED : T.border}`,
            background: T.surface,
            padding: '40px 52px',
            opacity: cardOp,
            transform: `translate(${shake}px, ${rise}px)`,
            boxShadow: borderFlash > 0.03 ? `0 0 ${borderFlash * 60}px rgba(255,68,68,0.35)` : 'none',
          }}
        >
          {/* which agent, and what it claimed */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 26 }}>
            <span style={{ width: 11, height: 11, background: T.waiting }} />
            <span style={{ fontSize: 17, letterSpacing: '0.14em', color: T.waiting }}>
              PI · SUMMARY · turn 18
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 16, color: T.textDim }}>“all green, ship it”</span>
          </div>

          {/* the claim — green, then struck through when the lie cracks */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              fontSize: 44,
              color: cracked ? T.textDim : GREEN,
              textDecoration: cracked ? 'line-through' : 'none',
              textDecorationColor: RED,
              opacity: cracked ? 0.55 : 1,
            }}
          >
            <span>✓</span>
            <span>tests pass</span>
          </div>

          {/* the crack — the amber-red verdict stamps in */}
          {cracked && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                marginTop: 24,
                paddingTop: 24,
                borderTop: `1px solid ${RED}55`,
                transform: `scale(${stampScale})`,
                transformOrigin: 'left center',
              }}
            >
              <span
                style={{
                  fontSize: 30,
                  color: '#000',
                  background: AMBER,
                  padding: '2px 12px',
                  fontWeight: 600,
                }}
              >
                ✕
              </span>
              <span style={{ fontSize: 40, color: RED, fontWeight: 600 }}>
                the test never ran your code
              </span>
            </div>
          )}

          {/* the title made literal */}
          <div style={{ marginTop: cracked ? 26 : 22, fontSize: 19, letterSpacing: '0.16em', color: cracked ? RED : T.textDim, opacity: enter(frame, TLV.crackStamp + 4, 10) }}>
            AGENTS LIE.
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
