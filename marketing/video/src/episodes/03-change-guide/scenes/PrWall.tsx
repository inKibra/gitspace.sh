import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, pulse } from '../../../lib/ui';
import { TL } from '../timeline';
import { FILES } from '../files';

/**
 * ACT 1 — THE WALL. An agent PR: fourteen files, alphabetical, a wall of
 * +/- counts. The camera crawls down the list (reading top to bottom), then
 * STALLS: the first file depended on the last one, and a red dependency line
 * connects them across the whole wall. Alphabetical order is the lie.
 *
 * Transparent background — the shader field reads through, like every scene
 * in the series. Pure function of frame.
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

const LEFT = 150;
const ROW_H = 64;
const LIST_TOP = 268;

export const PrWall: React.FC<{ frame: number }> = ({ frame }) => {
  const inOp = enter(frame, TL.prIn, 12);

  // the crawl: reading top to bottom, then a dead stop at the stall
  // 240, not more: the red line needs BOTH ends of the wall on screen —
  // file 1 barely hanging on at the top is the point
  const scroll = interpolate(frame, [TL.scroll, TL.stall], [0, 240], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.quad),
  });

  const stalled = frame >= TL.stall;
  const stallOp = enter(frame, TL.stall, 10);
  const glow = stalled ? 5 + pulse(frame % 40, 0, 40) * 7 : 0;

  // rows the red line touches: the FIRST file and the LAST
  const firstY = LIST_TOP + 0 * ROW_H - scroll + ROW_H / 2;
  const lastY = LIST_TOP + (FILES.length - 1) * ROW_H - scroll + ROW_H / 2;

  return (
    <AbsoluteFill style={{ fontFamily: MONO, opacity: inOp }}>
      {/* PR header */}
      <div style={{ position: 'absolute', top: 100, left: LEFT, right: LEFT }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span style={{ fontSize: 28, fontWeight: 600, color: C.text }}>remove checkout_v2 flag</span>
          <span style={{ fontSize: 20, color: C.dim }}>· PR #412 · agent</span>
        </div>
        <div style={{ marginTop: 22, display: 'flex', gap: 14, fontSize: 20 }}>
          <span style={{ border: `1px solid ${C.border}`, background: C.elevated, padding: '9px 18px', color: C.dim }}>conversation</span>
          <span style={{ border: `1px solid ${stalled ? C.red : C.blue}`, background: C.elevated, padding: '9px 18px', color: stalled ? C.red : C.blue }}>
            files changed · 14
          </span>
          <span style={{ marginLeft: 'auto', color: C.green, fontSize: 20, alignSelf: 'center' }}>+402</span>
          <span style={{ color: C.red, fontSize: 20, alignSelf: 'center' }}>−518</span>
        </div>
      </div>

      {/* the wall — clipped viewport that the reading crawl scrolls */}
      <div style={{ position: 'absolute', top: LIST_TOP - 24, left: LEFT, right: LEFT, height: 690, overflow: 'hidden' }}>
        <div style={{ transform: `translateY(${-scroll}px)` }}>
          {FILES.map((f, i) => (
            <div
              key={f.path}
              style={{
                height: ROW_H,
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                borderBottom: `1px solid ${C.border}`,
                opacity: enter(frame, TL.prIn + 6 + i * 2, 8),
              }}
            >
              <span style={{ fontSize: 15, color: C.ghost, width: 30, textAlign: 'right' }}>{i + 1}</span>
              <span style={{ fontSize: 22, color: stalled && (i === 0 || i === FILES.length - 1) ? C.red : C.text }}>{f.path}</span>
              {f.status === 'D' && <span style={{ fontSize: 15, color: C.red, border: `1px solid ${C.red}`, padding: '1px 8px' }}>deleted</span>}
              <span style={{ marginLeft: 'auto', fontSize: 18, color: C.green }}>+{f.adds}</span>
              <span style={{ fontSize: 18, color: C.red }}>−{f.dels}</span>
              {/* the flat wall of hunks, suggested */}
              <div style={{ width: 320, display: 'flex', gap: 3 }}>
                {Array.from({ length: 12 }).map((_, j) => (
                  <div key={j} style={{ flex: 1, height: 8, background: (i * 7 + j * 5) % 3 ? '#11241a' : '#241111' }} />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* THE STALL — the first file meant nothing without the last */}
        {stalled && (
          <svg width={1620} height={690} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: stallOp }}>
            <path
              d={`M 560 ${firstY - LIST_TOP + 24} C 1100 ${firstY - LIST_TOP + 24}, 1100 ${lastY - LIST_TOP + 24}, 620 ${lastY - LIST_TOP + 24}`}
              fill="none"
              stroke={C.red}
              strokeWidth={2.5}
              strokeDasharray="7 7"
              style={{ filter: glow > 0.5 ? `drop-shadow(0 0 ${glow}px rgba(255,68,68,0.6))` : undefined }}
            />
            <path d={`M 632 ${lastY - LIST_TOP + 24} l 16 -7 l -2 14 z`} fill={C.red} />
          </svg>
        )}
      </div>

      {/* the stall label — UI story text, not caption */}
      {stalled && (
        <div
          style={{
            position: 'absolute',
            right: LEFT + 40,
            top: 430,
            border: `1px solid ${C.red}`,
            background: '#0a0505',
            padding: '12px 20px',
            fontSize: 19,
            color: C.red,
            opacity: stallOp,
            boxShadow: `0 0 ${glow * 2}px rgba(255,68,68,0.2)`,
          }}
        >
          reads a symbol deleted in file 14
        </div>
      )}
    </AbsoluteFill>
  );
};
