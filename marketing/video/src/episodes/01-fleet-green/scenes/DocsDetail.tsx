import React from 'react';
import { AbsoluteFill } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { Pip, pulse, enter, typed, Caret } from '../../../lib/ui';
import { TL } from '../timeline';
import { stateAt } from '../fleet';

export const USER_MSG = 'tighten the quickstart, then open a PR';

// input bar geometry, exported for the global cursor path
export const INPUT = { x: 340, y: 916, w: 1240, h: 56 } as const;
export const SEND = { x: 1540, y: INPUT.y + INPUT.h / 2 } as const;

/** docs-refresh workspace detail: the agent is idle, the user gives direction. */
export const DocsDetail: React.FC<{ frame: number }> = ({ frame }) => {
  const state = stateAt('docs', frame);
  const sent = frame >= TL.clickSend + 2;
  const msg = typed(USER_MSG, frame, TL.typeStart, 1.15);
  const typing = frame >= TL.clickInput && !sent;

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
          <div style={{ fontSize: 27, color: T.text }}>docs-refresh</div>
          <div style={{ fontSize: 16, color: T.textDim, marginTop: 4 }}>docs/getting-started</div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 16, color: T.textDim }}>1 session</div>
      </div>

      {/* transcript */}
      <div style={{ position: 'absolute', top: 240, left: 340, width: 1240 }}>
        <div style={{ fontSize: 16, color: T.textGhost, letterSpacing: '0.14em', marginBottom: 24 }}>
          pi · claude-fable-5 · turn 9
        </div>
        <div style={{ fontSize: 23, lineHeight: '44px', color: T.textMuted, opacity: enter(frame, 288, 8) }}>
          ✓ drafted docs/getting-started.md
        </div>
        <div style={{ fontSize: 23, lineHeight: '44px', color: T.textMuted, opacity: enter(frame, 296, 8) }}>
          ✓ checked 41 code examples
        </div>

        {/* idle block */}
        <div
          style={{
            marginTop: 26,
            border: `1px solid ${T.border}`,
            borderLeft: `4px solid ${sent ? T.accent : T.waiting}`,
            background: T.surface,
            padding: '22px 28px',
            opacity: enter(frame, 304, 8),
          }}
        >
          <div
            style={{
              fontSize: 15,
              letterSpacing: '0.18em',
              color: sent ? T.textDim : T.waiting,
              marginBottom: 12,
            }}
          >
            PI · IDLE
          </div>
          <div style={{ fontSize: 24, lineHeight: '38px', color: T.text }}>
            Draft is ready. What next?
          </div>
          {!sent && (
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
              <Pip state="waiting" size={11} glow={pulse(frame % 30, 4, 24)} />
              idle · waiting on you
            </div>
          )}
          {sent && (
            <div style={{ marginTop: 16, fontSize: 20, color: T.accent, opacity: enter(frame, TL.clickSend + 2, 8) }}>
              you · {USER_MSG}
            </div>
          )}
        </div>

        {sent && (
          <div style={{ fontSize: 23, lineHeight: '44px', color: T.textMuted, marginTop: 24 }}>
            {typed('→ on it: quickstart pass, then PR', frame, TL.clickSend + 8, 2.6)}
          </div>
        )}
      </div>

      {/* message input */}
      <div
        style={{
          position: 'absolute',
          left: INPUT.x,
          top: INPUT.y,
          width: INPUT.w,
          height: INPUT.h,
          background: T.bg,
          border: `1px solid ${typing ? T.accent : T.border}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 18px',
          boxSizing: 'border-box',
        }}
      >
        {msg.length === 0 && !sent ? (
          <span style={{ fontSize: 19, color: T.textDim }}>Message pi…</span>
        ) : (
          <span style={{ fontSize: 19, color: T.text }}>
            {sent ? '' : msg}
            {typing && <Caret frame={frame} height={20} />}
          </span>
        )}
        {sent && <span style={{ fontSize: 19, color: T.textDim }}>Message pi…</span>}
        <span
          style={{
            marginLeft: 'auto',
            width: 44,
            height: 36,
            border: `1px solid ${T.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            color: msg.length > 0 && !sent ? T.accent : T.textDim,
            transform: frame >= TL.clickSend && frame < TL.clickSend + 5 ? 'scale(0.92)' : 'none',
          }}
        >
          ↵
        </span>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 40,
          left: 70,
          fontSize: 16,
          color: state === 'waiting' ? T.waiting : T.textDim,
        }}
      >
        {state === 'waiting' ? '● idle · waiting on you' : '● agent running'}
      </div>
    </AbsoluteFill>
  );
};
