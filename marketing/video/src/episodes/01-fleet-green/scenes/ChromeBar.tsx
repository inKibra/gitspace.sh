import React from 'react';
import { interpolate } from 'remotion';
import { T, MONO, stateColor } from '../../../lib/theme';
import { pulse } from '../../../lib/ui';
import { TL } from '../timeline';
import { FLEET, CHIP, stateAt, lastChangeAt } from '../fleet';

/**
 * Faithful reproduction of the product's GlobalChromeBar
 * (src/components/GlobalChromeBar.web.tsx): GitSpace wordmark, project,
 * activity strip of workspace chips (status square + name + phase), right
 * actions. Fixed above every view. Chips are fixed-width so the cursor path
 * is deterministic. Scaled ~1.7x for 1080p legibility.
 */

export const BAR_H = 72;

export type ActiveChip = 'board' | (typeof FLEET)[number]['id'];

export const ChromeBar: React.FC<{
  frame: number;
  active: ActiveChip;
  opacity?: number;
}> = ({ frame, active, opacity = 1 }) => {
  const flagsState = stateAt('flags', frame);
  const docsState = stateAt('docs', frame);
  const inboxCount = (flagsState === 'needsInput' ? 1 : 0) + (docsState === 'waiting' ? 1 : 0);

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: BAR_H,
        display: 'flex',
        alignItems: 'center',
        background: '#050505',
        borderBottom: `1px solid ${T.border}`,
        fontFamily: MONO,
        zIndex: 50,
        opacity,
        overflow: 'hidden',
      }}
    >
      {/* light sweep: the reward for getting the whole strip green */}
      {(() => {
        const sweep = interpolate(frame, [TL.docsGreen + 2, TL.docsGreen + 24], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        if (sweep <= 0 || sweep >= 1) return null;
        return (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: sweep * 2300 - 340,
              width: 320,
              height: '100%',
              background:
                'linear-gradient(105deg, transparent, rgba(0,255,102,0.12) 42%, rgba(255,255,255,0.07) 52%, transparent)',
              pointerEvents: 'none',
            }}
          />
        );
      })()}
      <div
        style={{
          width: CHIP.stripX0 - CHIP.boardW,
          display: 'flex',
          alignItems: 'center',
          gap: 20,
          paddingLeft: 28,
          flex: 'none',
        }}
      >
        <span style={{ fontSize: 22, fontWeight: 600, color: T.text }}>GitSpace</span>
        <span style={{ fontSize: 18, color: T.textMuted }}>
          <b style={{ fontWeight: 500, color: T.text }}>acme</b>
        </span>
      </div>

      {/* activity strip — board chip + workspace chips (fixed widths) */}
      <div style={{ display: 'flex', alignItems: 'stretch', alignSelf: 'stretch', flex: 'none' }}>
        <div
          style={{
            width: CHIP.boardW,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderLeft: `1px solid ${T.border}`,
            background: active === 'board' ? '#0c0c0c' : 'transparent',
            color: active === 'board' ? T.text : T.textMuted,
            fontSize: 18,
          }}
        >
          ⊞ board
        </div>
        {FLEET.map((m) => {
          const state = stateAt(m.id, frame);
          const changed = lastChangeAt(m.id, frame);
          const glow = changed === null ? 0 : pulse(frame, changed, 24);
          const c = stateColor(state);
          const isActive = active === m.id;
          return (
            <div
              key={m.id}
              style={{
                width: CHIP.w,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                borderLeft: `1px solid ${T.border}`,
                background: isActive ? '#0c0c0c' : 'transparent',
                color: isActive ? T.text : T.textMuted,
                fontSize: 18,
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 11,
                  height: 11,
                  flex: 'none',
                  background: c,
                  boxShadow: glow > 0.05 ? `0 0 ${glow * 18}px ${c}` : 'none',
                  filter: `brightness(${1 + glow * 0.4})`,
                }}
              />
              <span>{m.name}</span>
              <span
                style={{
                  fontSize: 13,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: T.textDim,
                }}
              >
                {m.phase}
              </span>
            </div>
          );
        })}
      </div>

      {/* right actions */}
      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          paddingRight: 20,
          flex: 'none',
        }}
      >
        <span style={{ position: 'relative', fontSize: 20, color: T.textMuted }}>
          ⚑
          {inboxCount > 0 && (
            <span
              style={{
                position: 'absolute',
                right: -12,
                top: -8,
                minWidth: 21,
                height: 21,
                borderRadius: '50%',
                background: T.waiting,
                color: '#000',
                fontSize: 13,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {inboxCount}
            </span>
          )}
        </span>
        <span style={{ border: `1px solid ${T.border}`, padding: '2px 8px', fontSize: 15, color: T.textDim }}>
          ⌘K
        </span>
      </div>
    </div>
  );
};
