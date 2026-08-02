import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO, stateColor } from '../../../lib/theme';
import { Pip, pulse } from '../../../lib/ui';
import { TL } from '../timeline';
import { FLEET, BOARD, stateAt, lastChangeAt, type Col, type Member } from '../fleet';

const COLS: Array<{ key: Col; label: string }> = [
  { key: 'build', label: 'BUILD' },
  { key: 'docs', label: 'DOCS' },
  { key: 'review', label: 'REVIEW' },
];

const STATE_LABEL: Record<string, string> = {
  running: 'running',
  waiting: 'idle · waiting on you',
  needsInput: 'asked you a question',
  none: '',
};

const Card: React.FC<{ m: Member; frame: number; index: number }> = ({ m, frame, index }) => {
  const state = stateAt(m.id, frame);
  const changed = lastChangeAt(m.id, frame);
  const glow = changed === null ? 0 : pulse(frame, changed, 24);
  // breathing once the user has the whole fleet green again
  const breathe =
    frame > TL.pullEnd && state === 'running' ? 0.18 + 0.14 * Math.sin(frame / 9 + index) : 0;
  // Cards are always present: the deck fly-in is the opener now, and the board
  // must read fully populated inside the hero card during the intro drift.
  const t = 1;
  const c = stateColor(state);
  return (
    <div
      style={{
        height: BOARD.cardH,
        marginBottom: BOARD.cardGap,
        background: T.surface,
        border: `1px solid ${glow > 0.05 ? c : T.border}`,
        boxShadow: glow + breathe > 0.05 ? `0 0 ${(glow + breathe) * 26}px ${c}44` : 'none',
        padding: '20px 22px',
        opacity: t,
        transform: `translateY(${(1 - t) * 26}px)`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        position: 'relative',
      }}
    >
      <div>
        <div style={{ fontSize: 25, color: T.text }}>{m.name}</div>
        <div style={{ fontSize: 17, color: T.textDim, marginTop: 6 }}>{m.branch}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Pip state={state} size={13} glow={glow + breathe} />
        <span style={{ fontSize: 16, color: state === 'running' ? T.textMuted : c }}>
          {STATE_LABEL[state]}
        </span>
        {m.id === 'flags' && state === 'needsInput' && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 15,
              color: T.needsInput,
              border: `1px solid ${T.needsInput}55`,
              padding: '3px 10px',
              opacity: interpolate(frame, [TL.flagsAsk + 3, TL.flagsAsk + 13], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
            }}
          >
            1 question
          </span>
        )}
      </div>
    </div>
  );
};

export const Board: React.FC<{ frame: number }> = ({ frame }) => {
  return (
    // transparent: the shader field behind Product shows through the gaps,
    // the same way the site's hero sits under its content
    <AbsoluteFill style={{ fontFamily: MONO }}>
      {/* columns (global chrome bar sits above as a fixed layer) */}
      <div
        style={{
          position: 'absolute',
          top: BOARD.colTop,
          left: BOARD.pad,
          right: BOARD.pad,
          display: 'flex',
          gap: BOARD.colGap,
        }}
      >
        {COLS.map((col) => {
          const members = FLEET.filter((m) => m.col === col.key);
          return (
            <div key={col.key} style={{ width: BOARD.colW }}>
              <div
                style={{
                  height: BOARD.colHeaderH,
                  fontSize: 15,
                  letterSpacing: '0.18em',
                  color: T.textDim,
                }}
              >
                {col.label} <span style={{ color: T.textGhost }}>· {members.length}</span>
              </div>
              {members.map((m) => (
                <Card key={m.id} m={m} frame={frame} index={FLEET.indexOf(m)} />
              ))}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
