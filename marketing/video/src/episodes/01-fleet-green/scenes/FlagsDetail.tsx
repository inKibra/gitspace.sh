import React from 'react';
import { AbsoluteFill } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { Pip, pulse, enter, typed } from '../../../lib/ui';
import { TL } from '../timeline';
import { stateAt } from '../fleet';

const QUESTION_TEXT =
  'checkout_v2 is still referenced by api, web, and worker. How should I roll out the removal?';

const LINES = [
  { at: 128, text: '✓ bun test · 142 passed', color: T.textMuted },
  { at: 136, text: '✓ removed checkout_v2 from api/flags.ts', color: T.textMuted },
  { at: 144, text: '→ still referenced: web/checkout.tsx, worker/jobs.ts', color: T.text },
];

/** checkout-flags workspace detail: the agent asked a question. */
export const FlagsDetail: React.FC<{ frame: number }> = ({ frame }) => {
  const state = stateAt('flags', frame);
  const answered = frame >= TL.modalGone + 2;

  return (
    <AbsoluteFill style={{ background: T.bg, fontFamily: MONO }}>
      {/* workspace header (global chrome bar sits above as a fixed layer) */}
      <div
        style={{
          position: 'absolute',
          top: 72,
          left: 0,
          right: 0,
          height: 96,
          display: 'flex',
          alignItems: 'center',
          padding: '0 70px',
          borderBottom: `1px solid ${T.borderMuted}`,
        }}
      >
        <div>
          <div style={{ fontSize: 27, color: T.text }}>checkout-flags</div>
          <div style={{ fontSize: 16, color: T.textDim, marginTop: 4 }}>feat/remove-checkout-v2</div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 16, color: T.textDim }}>2 sessions · 1 replay</div>
      </div>

      {/* transcript */}
      <div style={{ position: 'absolute', top: 240, left: 340, width: 1240 }}>
        <div style={{ fontSize: 16, color: T.textGhost, letterSpacing: '0.14em', marginBottom: 24 }}>
          pi · claude-fable-5 · turn 14
        </div>
        {LINES.map((l) => (
          <div
            key={l.at}
            style={{
              fontSize: 23,
              lineHeight: '44px',
              color: l.color,
              opacity: enter(frame, l.at, 8),
            }}
          >
            {l.text}
          </div>
        ))}

        {/* the question block */}
        {frame >= 146 && (
          <div
            style={{
              marginTop: 26,
              border: `1px solid ${T.border}`,
              borderLeft: `4px solid ${answered ? T.accent : T.needsInput}`,
              background: T.surface,
              padding: '22px 28px',
              opacity: enter(frame, 146, 8),
            }}
          >
            <div
              style={{
                fontSize: 15,
                letterSpacing: '0.18em',
                color: answered ? T.textDim : T.needsInput,
                marginBottom: 12,
              }}
            >
              PI · ASK
            </div>
            <div style={{ fontSize: 24, lineHeight: '38px', color: T.text }}>{QUESTION_TEXT}</div>
            {!answered && (
              <div
                style={{
                  marginTop: 16,
                  fontSize: 17,
                  color: T.textDim,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <Pip state="needsInput" size={11} glow={pulse(frame % 30, 4, 24)} />
                waiting for your answer
              </div>
            )}
            {answered && (
              <div style={{ marginTop: 16, fontSize: 20, color: T.accent, opacity: enter(frame, TL.modalGone + 2, 8) }}>
                you · Canary: api first, watch errors 10m
              </div>
            )}
          </div>
        )}

        {/* resume */}
        {answered && (
          <div style={{ fontSize: 23, lineHeight: '44px', color: T.textMuted, marginTop: 24 }}>
            {typed('✓ resuming: canary rollout, api first', frame, 250, 2.6)}
          </div>
        )}
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 40,
          left: 70,
          fontSize: 16,
          color: state === 'needsInput' ? T.needsInput : T.textDim,
        }}
      >
        {state === 'needsInput' ? '● needs your input' : '● agent running'}
      </div>
    </AbsoluteFill>
  );
};
