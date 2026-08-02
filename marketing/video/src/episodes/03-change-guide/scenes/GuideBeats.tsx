import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, pulse } from '../../../lib/ui';
import { TL } from '../timeline';
import { FILES, BEATS, JOURNAL } from '../files';
// the background work stream is a series pattern now; ep02 is its home
import { AgentWork, type WorkStep } from '../../02-evidence-not-vibes/scenes/AgentWork';

/**
 * ACT 2 — THE GUIDE. The same fourteen rows FLY from alphabetical order into
 * four cluster cards laid out in build order. Order badges land, the human
 * opens beat 1, and its narration is grounded in a journal quote written
 * before the code. Then the beats check off in order and the review stamps.
 *
 * Every row's flight is a pure interpolate from its list position to its
 * beat slot — deterministic, no springs.
 */

const C = {
  green: T.running,
  amber: T.needsInput,
  red: '#ff4444',
  blue: T.waiting,
  purple: '#bc8cff',
  text: T.text,
  dim: '#7a7a7a',
  ghost: '#3c3c3c',
  border: '#1e1e1e',
  elevated: '#0a0a0a',
} as const;

const LEFT = 150;
const LIST_TOP = 240;
const ROW_H = 46;

// beat card geometry (2×2 grid)
const CARD_W = 760;
const CARD_H = 300;
const COL_X = [LEFT, LEFT + CARD_W + 60];
const ROW_Y = [232, 232 + CARD_H + 42];
const cardPos = (b: number) => ({ x: COL_X[b % 2]!, y: ROW_Y[Math.floor(b / 2)]! });

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const ease = Easing.inOut(Easing.cubic);

/** The analyzer working under the guide — the liveness layer from ep02. */
const WORK: WorkStep[] = [
  { at: TL.reorder - 46, icon: '⌕', verb: 'analyze', target: 'diff · 14 files', done: TL.reorder - 10, result: 'dependency graph built' },
  { at: TL.reorder + 4, icon: '◆', verb: 'cluster', target: 'by build order', done: TL.badges - 8, result: '4 beats' },
  { at: TL.badges + 16, icon: '✎', verb: 'narrate', target: 'beat 1 · from journal', done: TL.journal + 20, result: '2 quotes' },
  { at: TL.checks - 30, icon: '⚑', verb: 'check', target: 'coverage · stale clusters', done: TL.checks - 4, result: 'every beat narrated' },
];

export const GuideBeats: React.FC<{ frame: number }> = ({ frame }) => {
  // each row flies at a staggered moment; beat-0 rows first (build order!)
  const flightOf = (beat: number, slot: number) =>
    interpolate(frame, [TL.reorder + beat * 22 + slot * 6, TL.reorder + 66 + beat * 22 + slot * 6], [0, 1], {
      ...clampOpts,
      easing: ease,
    });

  const badgesOp = enter(frame, TL.badges, 12);
  const journalOp = enter(frame, TL.journal, 12);
  const stampOp = enter(frame, TL.stamp, 10);
  const checkedAt = (b: number) => TL.checks + b * 26;

  return (
    <AbsoluteFill style={{ fontFamily: MONO }}>
      {/* header carries over from the PR — same change, new order */}
      <div style={{ position: 'absolute', top: 100, left: LEFT, right: LEFT, display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span style={{ fontSize: 28, fontWeight: 600, color: C.text }}>remove checkout_v2 flag</span>
        <span style={{ fontSize: 20, color: C.dim }}>· PR #412</span>
        <span
          style={{
            marginLeft: 18,
            border: `1px solid ${C.purple}`,
            background: 'rgba(188,140,255,0.06)',
            padding: '6px 14px',
            fontSize: 19,
            color: C.purple,
            opacity: enter(frame, TL.reorder - 40, 10),
          }}
        >
          ⚡ change guide · build order
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 18, color: C.dim, opacity: badgesOp }}>14 files · 4 beats</span>
      </div>

      {/* the four beat cards (arrive as the rows land in them) */}
      {BEATS.map((b, i) => {
        const p = cardPos(i);
        const done = frame >= checkedAt(i);
        const focus = i === 0 && frame >= TL.journal && frame < TL.checks;
        return (
          <div
            key={b.n}
            style={{
              position: 'absolute',
              left: p.x,
              top: p.y,
              width: CARD_W,
              height: CARD_H,
              border: `1px solid ${done ? C.green : focus ? C.amber : C.border}`,
              background: C.elevated,
              opacity: badgesOp,
              boxShadow: done
                ? `0 0 ${8 + pulse(frame, checkedAt(i), 24) * 14}px rgba(0,255,102,0.18)`
                : focus
                  ? '0 0 14px rgba(255,204,0,0.12)'
                  : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 15, color: done ? C.green : C.dim, border: `1px solid ${done ? C.green : C.border}`, padding: '2px 10px' }}>
                {b.n} / 4
              </span>
              <span style={{ fontSize: 22, fontWeight: 700, color: C.text }}>{b.title}</span>
              <span style={{ fontSize: 16, color: C.dim }}>· {b.sub}</span>
              {done && <span style={{ marginLeft: 'auto', fontSize: 20, color: C.green }}>✓</span>}
            </div>
            {/* beat 1 narrates itself: the journal quote opens INSIDE the beat,
                because the narration belongs to the beat, not to a footer */}
            {i === 0 && frame >= TL.journal && (
              <div
                style={{
                  // ABSOLUTE, below the three file-row slots: the rows are
                  // absolutely-positioned overlays flying in from the list, so
                  // in-flow margin would put this straight underneath them
                  position: 'absolute',
                  left: 14,
                  right: 14,
                  top: 56 + 3 * 34 + 12,
                  border: `1px solid ${C.amber}`,
                  background: '#0a0803',
                  padding: '10px 14px',
                  opacity: enter(frame, TL.journal, 12),
                }}
              >
                <div style={{ fontSize: 13, color: C.amber, marginBottom: 5 }}>{JOURNAL.phase}</div>
                <div style={{ fontSize: 15.5, color: C.text, fontStyle: 'italic', lineHeight: 1.45 }}>“{JOURNAL.quote}”</div>
              </div>
            )}
          </div>
        );
      })}

      {/* the fourteen rows — one element each, flying list → beat slot */}
      {FILES.map((f, i) => {
        const t = flightOf(f.beat, f.slot);
        const from = { x: LEFT + 48, y: LIST_TOP + i * ROW_H };
        const card = cardPos(f.beat);
        const to = { x: card.x + 20, y: card.y + 56 + f.slot * 34 };
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        const compact = t > 0.6;
        return (
          <div
            key={f.path}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              fontSize: compact ? 17 : 20,
              color: compact ? C.dim : C.text,
              opacity: enter(frame, TL.reorder - 50, 10),
            }}
          >
            <span>{f.path}</span>
            <span style={{ color: C.green, fontSize: compact ? 13 : 16 }}>+{f.adds}</span>
            <span style={{ color: C.red, fontSize: compact ? 13 : 16 }}>−{f.dels}</span>
          </div>
        );
      })}

      {/* ✓ reviewed — the stamp the wall never earns */}
      {frame >= TL.stamp && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 148,
            textAlign: 'center',
            opacity: stampOp,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              border: `1px solid ${C.green}`,
              color: C.green,
              fontSize: 30,
              fontWeight: 700,
              padding: '10px 26px',
              background: 'rgba(0,20,8,0.72)',
              boxShadow: `0 0 ${14 + pulse(frame, TL.stamp, 30) * 20}px rgba(0,255,102,0.3)`,
            }}
          >
            ✓ reviewed · 14 files · 4 beats
          </span>
        </div>
      )}

      {/* the analyzer, working quietly under the graph */}
      <AgentWork frame={frame} start={TL.reorder - 50} steps={WORK} top={920} left={LEFT} right={LEFT} label="analyzer · working" />
    </AbsoluteFill>
  );
};
