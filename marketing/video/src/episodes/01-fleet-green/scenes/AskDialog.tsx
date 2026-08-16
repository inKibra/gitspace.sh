import React from 'react';
import { AbsoluteFill, interpolate, spring, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { TL } from '../timeline';

/**
 * Faithful reproduction of the product's AskFormDialog
 * (src/components/HostUIDialogs.web.tsx) as a CONTAINED modal: "AGENT
 * QUESTIONS" kicker, radio options with dim descriptions, an "Other" field,
 * Cancel/Submit. Fully inside the frame — no vertical overflow.
 */

const OPTIONS = [
  {
    label: 'Canary: api first, watch errors 10m (Recommended)',
    desc: 'Safest. Adds about 20 minutes.',
  },
  { label: 'All three at once', desc: 'Fastest. One revert point.' },
  { label: 'web only, hold the rest', desc: 'Partial cleanup with a follow-up PR.' },
];

// fixed geometry, exported for the global cursor path
export const MODAL = { x: 500, y: 235, w: 920, h: 610 } as const;
export const MODAL_TARGETS = {
  option1: { x: 900, y: 478 },
  option2: { x: 900, y: 560 },
  submit: { x: 1317, y: 786 },
} as const;

const ROW_H = 78;

const hoverIndex = (frame: number): number => {
  if (frame < 164) return -1;
  if (frame < 182) return 0;
  if (frame < 192) return 1;
  if (frame < TL.modalOutStart) return 0;
  return -1;
};

export const AskDialog: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  if (frame < TL.modalIn || frame > TL.modalGone) return null;

  const springIn = spring({
    frame: frame - TL.modalIn,
    fps,
    config: { damping: 26, mass: 0.7, stiffness: 190 },
  });
  const out = interpolate(frame, [TL.modalOutStart, TL.modalGone - 2], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });
  const visible = Math.min(springIn, 1 - out);
  const scale = 0.955 + 0.045 * springIn - 0.02 * out;
  const backdrop = visible * 0.8;

  const hover = hoverIndex(frame);
  const radioPulse =
    frame < TL.clickOption || frame > TL.clickOption + 12 ? 0 : (frame - TL.clickOption) / 12;
  const submitPressed = frame >= TL.clickSubmit && frame < TL.clickSubmit + 5;

  return (
    <AbsoluteFill style={{ fontFamily: MONO }}>
      <AbsoluteFill style={{ background: `rgba(0,0,0,${backdrop})` }} />
      <div
        style={{
          position: 'absolute',
          left: MODAL.x,
          top: MODAL.y,
          width: MODAL.w,
          height: MODAL.h,
          background: T.surface,
          border: `1px solid ${T.border}`,
          opacity: visible,
          transform: `scale(${scale}) translateY(${(1 - springIn) * 16}px)`,
          transformOrigin: '50% 40%',
        }}
      >
        {/* header */}
        <div style={{ height: 96, padding: '24px 32px 0', borderBottom: `1px solid ${T.borderMuted}`, boxSizing: 'border-box' }}>
          <div style={{ fontSize: 14, letterSpacing: '0.18em', color: T.textDim, marginBottom: 10 }}>
            AGENT QUESTIONS
          </div>
          <div style={{ fontSize: 26, color: T.text }}>Flag cleanup: rollout order</div>
        </div>
        <div style={{ position: 'absolute', right: 20, top: 16, fontSize: 22, color: T.textDim }}>×</div>

        {/* body */}
        <div style={{ padding: '28px 28px 0' }}>
          <div style={{ height: 68, marginBottom: 12, fontSize: 23, lineHeight: '34px', color: T.text }}>
            checkout_v2 is still referenced by api, web, and worker. How should I roll out the
            removal?
          </div>

          {OPTIONS.map((o, i) => {
            const selected = i === 0; // recommended is preselected, matching the component
            const isHover = hover === i;
            return (
              <div
                key={i}
                style={{
                  height: ROW_H,
                  marginBottom: 4,
                  padding: '13px 16px',
                  display: 'flex',
                  gap: 15,
                  alignItems: 'flex-start',
                  background: isHover ? T.elevated : 'transparent',
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{
                    width: 19,
                    height: 19,
                    marginTop: 3,
                    borderRadius: '50%',
                    border: `2px solid ${selected ? T.accent : T.textDim}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: selected && radioPulse > 0 ? `0 0 ${radioPulse * 16}px ${T.accentGlow}` : 'none',
                  }}
                >
                  {selected && (
                    <div style={{ width: 9, height: 9, borderRadius: '50%', background: T.accent }} />
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 21, color: T.text }}>{o.label}</div>
                  <div style={{ fontSize: 16, color: T.textDim, marginTop: 5 }}>{o.desc}</div>
                </div>
              </div>
            );
          })}

          {/* Other field */}
          <div
            style={{
              marginTop: 12,
              height: 48,
              background: T.bg,
              border: `1px solid ${T.border}`,
              display: 'flex',
              alignItems: 'center',
              padding: '0 16px',
              fontSize: 18,
              color: T.textDim,
              boxSizing: 'border-box',
            }}
          >
            Other (type your own)
          </div>

          {/* footer buttons */}
          <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 14 }}>
            <div
              style={{
                height: 50,
                padding: '0 26px',
                border: `1px solid ${T.border}`,
                display: 'flex',
                alignItems: 'center',
                fontSize: 19,
                color: T.text,
              }}
            >
              Cancel
            </div>
            <div
              style={{
                height: 50,
                padding: '0 30px',
                background: T.accent,
                display: 'flex',
                alignItems: 'center',
                fontSize: 19,
                color: '#000',
                transform: submitPressed ? 'scale(0.95)' : 'none',
              }}
            >
              Submit
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
