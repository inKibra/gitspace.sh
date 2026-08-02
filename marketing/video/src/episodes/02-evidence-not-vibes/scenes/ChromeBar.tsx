import React from 'react';
import { interpolate } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { FLEET, CHIP } from '../rubric';
import { TL } from '../timeline';

/**
 * Faithful reproduction of the product's GlobalChromeBar: wordmark, project,
 * activity strip of workspace chips (status square + name), right actions.
 * Fixed above every view. The active workspace (checkout-refactor) is BLUE —
 * idle / your-move (ep01 continuity: blue = waiting on you, NOT amber).
 */

export const BAR_H = 72;

export type ActiveChip = 'goal' | (typeof FLEET)[number]['id'];

const chipColor = (state: 'green' | 'blue'): string =>
  state === 'blue' ? T.waiting : T.running;

export const ChromeBar: React.FC<{
  frame: number; // product-local
  active: ActiveChip;
}> = ({ frame, active }) => {
  // one blue idle workspace in the inbox — the one waiting on you
  const inboxCount = FLEET.filter((c) => c.state === 'blue').length;

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
        overflow: 'hidden',
      }}
    >
      {/* blue sweep: the reward for both requirements accepting */}
      {(() => {
        const sweep = interpolate(frame, [TL.req2Accept + 2, TL.req2Accept + 24], [0, 1], {
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
          width: CHIP.stripX0 - CHIP.goalW,
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

      {/* activity strip — goal chip + workspace chips (fixed widths) */}
      <div style={{ display: 'flex', alignItems: 'stretch', alignSelf: 'stretch', flex: 'none' }}>
        <div
          style={{
            width: CHIP.goalW,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderLeft: `1px solid ${T.border}`,
            background: active === 'goal' ? '#0c0c0c' : 'transparent',
            color: active === 'goal' ? T.text : T.textMuted,
            fontSize: 18,
          }}
        >
          ◇ goal
        </div>
        {FLEET.map((c) => {
          const isActive = active === c.id;
          const col = chipColor(c.state);
          // the blue workspace pip breathes while it waits on you
          const breathe =
            c.state === 'blue' ? 0.5 + 0.5 * Math.sin(frame / 9) : 0;
          return (
            <div
              key={c.id}
              style={{
                width: CHIP.w,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                borderLeft: `1px solid ${T.border}`,
                background: isActive ? (c.state === 'blue' ? '#0a1220' : '#0c0c0c') : 'transparent',
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
                  background: col,
                  boxShadow: c.state === 'blue' ? `0 0 ${8 + breathe * 12}px ${col}` : 'none',
                }}
              />
              <span>{c.name}</span>
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
