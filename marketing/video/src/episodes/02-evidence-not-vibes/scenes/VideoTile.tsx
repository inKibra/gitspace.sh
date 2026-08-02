import React from 'react';
import { interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { TL } from '../timeline';

/**
 * The VIDEO evidence: a synthetic checkout-flow clip that actually PLAYS inside
 * the tile. Over ~2s a tiny mock checkout renders — line item → subtotal → tax
 * → total appear, then the green "Pay" button highlights and presses. This is
 * the artifact the human judge is pointed at (the rendered order total).
 *
 * All motion is a pure function of the product-local frame relative to the
 * play beat, so it's deterministic and re-timeable.
 */

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const GREEN = T.running;

const DUR = TL.videoEnd - TL.videoPlay; // 60 frames ≈ 2s

// each row of the receipt: [label, value, appear-offset]
const ROWS: Array<[string, string, number]> = [
  ['Sneakers × 1', '$84.00', 6],
  ['Subtotal', '$84.00', 18],
  ['Tax', '$6.72', 30],
];
const TOTAL_AT = 42;
const PAY_HILITE = 50;
const PAY_PRESS = 56;

export const VideoTile: React.FC<{ frame: number }> = ({ frame }) => {
  const rel = frame - TL.videoPlay;
  const playing = rel >= 0 && rel <= DUR + 24;
  const progress = interpolate(rel, [0, DUR], [0, 1], clamp);
  // blinking playhead dot, ~2Hz
  const rec = Math.floor(rel / 8) % 2 === 0;
  const tc = `0:0${Math.max(0, Math.min(2, Math.floor(rel / 30)))}`;

  const payHi = interpolate(rel, [PAY_HILITE, PAY_HILITE + 6], [0, 1], clamp);
  const pressed = rel >= PAY_PRESS && rel < PAY_PRESS + 5;
  const paid = rel >= PAY_PRESS + 5;

  const poster = rel < 0; // before play: a still poster with a play glyph

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: '#060606',
        overflow: 'hidden',
        fontFamily: MONO,
      }}
    >
      {/* the mock storefront the clip is "recording" */}
      <div style={{ position: 'absolute', inset: 0, padding: '22px 26px', opacity: poster ? 0.25 : 1 }}>
        <div style={{ fontSize: 15, letterSpacing: '0.14em', color: T.textDim, marginBottom: 16 }}>
          acme · checkout
        </div>

        {ROWS.map(([label, value, at]) => {
          const op = interpolate(rel, [at, at + 6], [0, 1], clamp);
          return (
            <div
              key={label}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 19,
                lineHeight: '34px',
                color: T.textMuted,
                opacity: op,
                transform: `translateY(${(1 - op) * 8}px)`,
              }}
            >
              <span>{label}</span>
              <span style={{ color: T.text }}>{value}</span>
            </div>
          );
        })}

        {/* the total — the thing the judge is aimed at */}
        {(() => {
          const op = interpolate(rel, [TOTAL_AT, TOTAL_AT + 6], [0, 1], {
            ...clamp,
            easing: Easing.out(Easing.cubic),
          });
          const pop = 1 + 0.06 * interpolate(rel, [TOTAL_AT, TOTAL_AT + 8], [1, 0], clamp);
          return (
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginTop: 14,
                paddingTop: 14,
                borderTop: `1px solid ${T.border}`,
                opacity: op,
                transform: `scale(${pop})`,
                transformOrigin: 'left center',
              }}
            >
              <span style={{ fontSize: 20, color: T.text }}>Total</span>
              <span style={{ fontSize: 30, color: GREEN, fontWeight: 600 }}>$90.72</span>
            </div>
          );
        })()}

        {/* the Pay button highlights, then presses */}
        <div
          style={{
            marginTop: 22,
            height: 52,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
            fontWeight: 600,
            color: '#000',
            background: paid ? '#b8ffd6' : GREEN,
            opacity: interpolate(rel, [TOTAL_AT + 2, TOTAL_AT + 10], [0.4, 1], clamp),
            boxShadow: payHi > 0 ? `0 0 ${payHi * 26}px ${GREEN}88` : 'none',
            transform: pressed ? 'scale(0.96)' : 'scale(1)',
          }}
        >
          {paid ? '✓ Paid' : 'Pay $90.72'}
        </div>
      </div>

      {/* poster play glyph before the clip runs */}
      {poster && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: 62,
              height: 62,
              borderRadius: '50%',
              border: `2px solid ${T.textMuted}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: T.text,
              fontSize: 22,
              paddingLeft: 4,
            }}
          >
            ▶
          </div>
        </div>
      )}

      {/* recording/timecode chrome — top-right, clear of the storefront header */}
      <div
        style={{
          position: 'absolute',
          right: 12,
          top: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          fontSize: 13,
          color: T.textDim,
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: playing && rec ? '#ff5555' : '#3a1414',
          }}
        />
        {playing ? 'REC' : 'clip'} · {tc}
      </div>

      {/* scrubber */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 5, background: '#141414' }}>
        <div style={{ height: '100%', width: `${progress * 100}%`, background: GREEN }} />
      </div>
    </div>
  );
};
