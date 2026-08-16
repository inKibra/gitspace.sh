import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, pulse } from '../../../lib/ui';
import { TL } from '../timeline';

/**
 * ACT 1 — THE CHAIN. Four goals, one order:
 *   billing-schema → backfill-job → checkout-flags → checkout-e2e
 * The first two already merged (goals outlive their workspaces). checkout-flags
 * is live with an agent; it ships, its workspace vanishes, and checkout-e2e
 * stops being paper: it binds a workspace off its ancestor's HEAD. The human
 * approves the last ship and the whole board says done — the FALSE green this
 * episode exists to correct. Pure function of frame.
 */

const C = {
  green: T.running,
  amber: T.needsInput,
  blue: T.waiting,
  text: T.text,
  dim: '#7a7a7a',
  ghost: '#3c3c3c',
  border: '#1e1e1e',
  elevated: '#0a0a0a',
} as const;

const LEFT = 150;
const CARD_W = 380;
const CARD_H = 240;
const GAP = 32;
const TOP = 330;

const GOALS = [
  { id: 'billing-schema', sub: 'db · migrations' },
  { id: 'backfill-job', sub: 'workers · queue' },
  { id: 'checkout-flags', sub: 'feat/remove-v2' },
  { id: 'checkout-e2e', sub: 'the proof suite' },
] as const;

export const ChainBoard: React.FC<{ frame: number }> = ({ frame }) => {
  const inOp = enter(frame, TL.chainIn, 12);
  const all = frame >= TL.allGreen;

  // per-goal state as a function of frame
  const state = (i: number): 'merged' | 'active' | 'planned' => {
    if (i <= 1) return 'merged';
    if (i === 2) return frame >= TL.ship3 ? 'merged' : 'active';
    return frame >= TL.ship4 ? 'merged' : frame >= TL.ship3 + 14 ? 'active' : 'planned';
  };

  return (
    <AbsoluteFill style={{ fontFamily: MONO, opacity: inOp }}>
      {/* header */}
      <div style={{ position: 'absolute', top: 100, left: LEFT, right: LEFT, display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span style={{ fontSize: 28, fontWeight: 600, color: C.text }}>checkout-cutover</span>
        <span style={{ fontSize: 20, color: C.dim }}>· chain · 4 goals</span>
        <span style={{ marginLeft: 'auto', fontSize: 18, color: all ? C.green : C.dim }}>
          {all ? '4 / 4 merged' : `${frame >= TL.ship4 ? 3 : 2} / 4 merged`}
        </span>
      </div>

      {/* the track — order badges + guide line */}
      <div style={{ position: 'absolute', top: TOP - 58, left: LEFT, right: LEFT, height: 2, background: C.border }} />
      {GOALS.map((g, i) => {
        const st = state(i);
        const x = LEFT + i * (CARD_W + GAP);
        const shipsAt = i === 2 ? TL.ship3 : i === 3 ? TL.ship4 : -999;
        const justShipped = frame >= shipsAt && frame < shipsAt + 26;
        const bindAt = TL.ship3 + 14;
        return (
          <div key={g.id}>
            {/* order badge on the track */}
            <div
              style={{
                position: 'absolute',
                top: TOP - 72,
                left: x + CARD_W / 2 - 26,
                fontSize: 15,
                color: st === 'merged' ? C.green : C.dim,
                border: `1px solid ${st === 'merged' ? C.green : C.border}`,
                background: T.bg,
                padding: '2px 12px',
              }}
            >
              {i + 1} / 4
            </div>
            {/* goal card */}
            <div
              style={{
                position: 'absolute',
                top: TOP,
                left: x,
                width: CARD_W,
                height: CARD_H,
                border: `1px solid ${st === 'active' ? C.green : C.border}`,
                background: C.elevated,
                opacity: enter(frame, TL.chainIn + 4 + i * 5, 10),
                boxShadow: justShipped ? `0 0 ${14 + pulse(frame, shipsAt, 24) * 16}px rgba(0,255,102,0.22)` : 'none',
              }}
            >
              <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: C.text }}>{g.id}</div>
                <div style={{ fontSize: 15, color: C.dim, marginTop: 4 }}>{g.sub}</div>
              </div>
              <div style={{ padding: '14px 20px', fontSize: 17 }}>
                {st === 'merged' && (
                  <>
                    <div style={{ color: C.green }}>✓ merged</div>
                    <div style={{ color: C.ghost, marginTop: 6 }}>workspace removed</div>
                  </>
                )}
                {st === 'active' && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.green }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: C.green, boxShadow: `0 0 ${6 + pulse(frame % 30, 0, 30) * 8}px ${C.green}` }} />
                      workspace · agent running
                    </div>
                    {/* the bind moment: branched from the ancestor's HEAD */}
                    {i === 3 && frame < bindAt + 40 && (
                      <div style={{ color: C.blue, marginTop: 8, fontSize: 15, opacity: enter(frame, bindAt, 10) }}>
                        ↳ branched from checkout-flags HEAD
                      </div>
                    )}
                    {/* the human's ship control on the last goal */}
                    {i === 3 && (
                      <div
                        style={{
                          marginTop: 12,
                          display: 'inline-block',
                          border: `1px solid ${frame >= TL.actShip ? C.green : C.border}`,
                          color: frame >= TL.actShip ? C.green : C.dim,
                          padding: '7px 18px',
                          fontSize: 16,
                        }}
                      >
                        ship · review passed
                      </div>
                    )}
                  </>
                )}
                {st === 'planned' && (
                  <>
                    <div style={{ color: C.dim }}>planned</div>
                    <div style={{ color: C.ghost, marginTop: 6 }}>no workspace yet</div>
                  </>
                )}
              </div>
            </div>
            {/* connector */}
            {i < 3 && (
              <div style={{ position: 'absolute', top: TOP + CARD_H / 2 - 8, left: x + CARD_W + 4, fontSize: 22, color: C.ghost }}>▶</div>
            )}
          </div>
        );
      })}

      {/* the false green — everything says done */}
      {all && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 668, textAlign: 'center', opacity: enter(frame, TL.allGreen, 10) }}>
          <span
            style={{
              display: 'inline-block',
              border: `1px solid ${C.green}`,
              color: C.green,
              fontSize: 30,
              fontWeight: 700,
              padding: '10px 28px',
              boxShadow: `0 0 ${12 + pulse(frame, TL.allGreen, 30) * 18}px rgba(0,255,102,0.3)`,
            }}
          >
            ✓ chain complete · every workspace deleted
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};
