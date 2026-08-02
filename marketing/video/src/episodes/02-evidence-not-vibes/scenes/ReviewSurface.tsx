import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, typed, Caret, pulse } from '../../../lib/ui';
import { TL } from '../timeline';
import { REQS, reqStatusAt, type Requirement } from '../rubric';
import { VideoTile } from './VideoTile';

/**
 * ACT 2 — NOW PROVE IT. The workspace review surface (ported from the landing
 * page's stage-04 review UI into the film's style). The agent is done and the
 * chip/card are BLUE — idle, your move. A cursor walks the rubric: the command
 * judge streams a real test result, the video judge plays a synthetic clip, and
 * each row blooms ACCEPTED. A highlight lands on each judge showing what it was
 * aimed at — was the reviewer looking at the right thing.
 */

const BLUE = T.waiting; // #4488ff — idle / your-move
const GREEN = T.running; // #00ff66
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// exported geometry so the global cursor path in index.tsx is exact
export const REVIEW = {
  row1: { x: 70, y: 236, w: 1780, statusPt: { x: 320, y: 296 }, judgePt: { x: 760, y: 430 } },
  row2: { x: 70, y: 510, w: 1160, statusPt: { x: 360, y: 566 } },
  video: { x: 1250, y: 510, w: 560, h: 336, playPt: { x: 1530, y: 690 } },
  readyPt: { x: 320, y: 952 },
} as const;

/** Status pill: pending · judging… · ACCEPTED. */
const StatusPill: React.FC<{ r: Requirement; frame: number }> = ({ r, frame }) => {
  const st = reqStatusAt(r, frame);
  const label = st === 'accepted' ? 'ACCEPTED' : st === 'judging' ? 'judging…' : 'pending';
  const col = st === 'accepted' ? GREEN : st === 'judging' ? BLUE : T.textDim;
  const bloom = st === 'accepted' ? pulse(frame, r.accept, 20) : 0;
  return (
    <span
      style={{
        marginLeft: 'auto',
        fontSize: 17,
        letterSpacing: '0.08em',
        color: col,
        border: `1px solid ${col}${st === 'accepted' ? '' : '55'}`,
        padding: '4px 14px',
        boxShadow: bloom > 0.05 ? `0 0 ${bloom * 22}px ${GREEN}66` : 'none',
        opacity: st === 'judging' ? 0.6 + 0.4 * Math.abs(Math.sin(frame / 6)) : 1,
      }}
    >
      {label}
    </span>
  );
};

/** The green "aimed at …" highlight that lands on a judge. */
const AimHighlight: React.FC<{ r: Requirement; frame: number }> = ({ r, frame }) => {
  const op = enter(frame, r.aimAt, 8);
  if (op <= 0) return null;
  return (
    <div
      style={{
        marginTop: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        border: `1px solid ${GREEN}`,
        background: 'rgba(0,255,102,0.06)',
        opacity: op,
        boxShadow: `0 0 ${pulse(frame, r.aimAt, 26) * 20}px ${GREEN}44`,
      }}
    >
      <span style={{ width: 9, height: 9, background: GREEN }} />
      <span style={{ fontSize: 17, color: T.text }}>{r.aim}</span>
    </div>
  );
};

const rowBorder = (accepted: boolean) => (accepted ? `${GREEN}55` : T.border);

export const ReviewSurface: React.FC<{ frame: number }> = ({ frame }) => {
  const suite = REQS[0]!;
  const flow = REQS[1]!;
  const suiteAccepted = frame >= suite.accept;
  const flowAccepted = frame >= flow.accept;

  // command judge stream (requirement 1)
  const cmd = typed('bun test src/checkout', frame, TL.req1CmdRun, 1.9);
  const cmdTyping = frame >= TL.req1CmdRun && cmd.length < 'bun test src/checkout'.length;
  const showResult = frame >= TL.req1CmdResult;

  const ready = typed('Ready: all required artifacts passed judgment.', frame, TL.readyType, 1.25);
  const readyTyping = frame >= TL.readyType && ready.length < 46;

  return (
    <AbsoluteFill style={{ background: T.bg, fontFamily: MONO }}>
      {/* workspace header — BLUE, idle / your move */}
      <div
        style={{
          position: 'absolute',
          top: 72,
          left: 0,
          right: 0,
          height: 88,
          display: 'flex',
          alignItems: 'center',
          padding: '0 70px',
          borderBottom: `1px solid ${T.borderMuted}`,
        }}
      >
        <div>
          <div style={{ fontSize: 27, color: T.text }}>checkout-refactor</div>
          <div style={{ fontSize: 16, color: T.textDim, marginTop: 4 }}>feat/refactor-checkout</div>
        </div>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 17,
            color: BLUE,
          }}
        >
          <span
            style={{
              width: 11,
              height: 11,
              background: BLUE,
              boxShadow: `0 0 ${8 + Math.abs(Math.sin(frame / 9)) * 12}px ${BLUE}`,
            }}
          />
          idle · ready for your review
        </div>
      </div>

      {/* agent's last transcript line — blue authorship */}
      <div style={{ position: 'absolute', top: 176, left: 70, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 15, color: T.textGhost, letterSpacing: '0.14em' }}>
          pi · claude-fable-5 · turn 21
        </span>
        <span style={{ fontSize: 20, color: BLUE }}>done · ready for your review</span>
      </div>

      {/* ── Requirement 1 — command judge ── */}
      <div
        style={{
          position: 'absolute',
          top: REVIEW.row1.y,
          left: REVIEW.row1.x,
          width: REVIEW.row1.w,
          border: `1px solid ${rowBorder(suiteAccepted)}`,
          background: T.surface,
          padding: '18px 24px',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span
            style={{
              width: 12,
              height: 12,
              flex: 'none',
              background: suiteAccepted ? GREEN : 'transparent',
              border: suiteAccepted ? 'none' : `1px solid ${T.textGhost}`,
              boxShadow: suiteAccepted ? `0 0 ${8 + pulse(frame, suite.accept, 20) * 16}px ${GREEN}` : 'none',
            }}
          />
          <span style={{ fontSize: 24, color: T.text }}>1. {suite.title}</span>
          <span style={{ fontSize: 16, color: T.textDim }}>
            kind test-output · judge command · expect exit-zero
          </span>
          <StatusPill r={suite} frame={frame} />
        </div>

        {/* command judge output block */}
        <div
          style={{
            marginTop: 14,
            border: `1px solid ${T.border}`,
            background: T.bg,
            padding: '14px 18px',
            fontSize: 19,
            lineHeight: '32px',
          }}
        >
          <div style={{ color: T.textMuted }}>
            <span style={{ color: T.textDim }}>judge ▸ </span>
            {cmd}
            {cmdTyping && <Caret frame={frame} height={19} color={T.textMuted} />}
          </div>
          {showResult && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, opacity: enter(frame, TL.req1CmdResult, 6) }}>
              <span style={{ color: GREEN }}>142 passed</span>
              <span style={{ color: T.textDim }}>·</span>
              <span
                style={{
                  color: GREEN,
                  border: `1px solid ${GREEN}55`,
                  padding: '2px 10px',
                  fontSize: 16,
                }}
              >
                exit 0
              </span>
            </div>
          )}
        </div>

        <AimHighlight r={suite} frame={frame} />
      </div>

      {/* ── Requirement 2 — video judge ── */}
      <div
        style={{
          position: 'absolute',
          top: REVIEW.row2.y,
          left: REVIEW.row2.x,
          width: REVIEW.row2.w,
          border: `1px solid ${rowBorder(flowAccepted)}`,
          background: T.surface,
          padding: '18px 24px',
          boxSizing: 'border-box',
          minHeight: REVIEW.video.h,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span
            style={{
              width: 12,
              height: 12,
              flex: 'none',
              background: flowAccepted ? GREEN : 'transparent',
              border: flowAccepted ? 'none' : `1px solid ${T.textGhost}`,
              boxShadow: flowAccepted ? `0 0 ${8 + pulse(frame, flow.accept, 20) * 16}px ${GREEN}` : 'none',
            }}
          />
          <span style={{ fontSize: 24, color: T.text }}>2. {flow.title}</span>
          <span style={{ fontSize: 16, color: T.textDim }}>kind video · judge human</span>
          <StatusPill r={flow} frame={frame} />
        </div>

        <div style={{ marginTop: 16, fontSize: 18, color: T.textMuted, lineHeight: '30px' }}>
          The evidence is a clip of the real flow, and a human watches the order total render.
        </div>

        {/* evidence chip */}
        <div style={{ marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 16, color: T.textMuted, border: `1px solid ${T.border}`, padding: '5px 12px', background: T.bg }}>
          ⎘ {flow.artifact}
        </div>

        <AimHighlight r={flow} frame={frame} />
      </div>

      {/* the video evidence tile — actually plays */}
      <div
        style={{
          position: 'absolute',
          top: REVIEW.video.y,
          left: REVIEW.video.x,
          width: REVIEW.video.w,
          height: REVIEW.video.h,
          border: `1px solid ${flowAccepted ? `${GREEN}66` : BLUE + '66'}`,
          boxShadow: flowAccepted ? `0 0 ${pulse(frame, flow.accept, 24) * 26}px ${GREEN}44` : 'none',
          boxSizing: 'border-box',
        }}
      >
        <VideoTile frame={frame} />
      </div>

      {/* readiness types green */}
      <div style={{ position: 'absolute', top: 924, left: 70, display: 'flex', alignItems: 'center', gap: 14 }}>
        {frame >= TL.readyType && (
          <>
            <span
              style={{
                width: 12,
                height: 12,
                background: GREEN,
                boxShadow: `0 0 ${8 + pulse(frame, TL.readyType, 30) * 18}px ${GREEN}`,
              }}
            />
            <span style={{ fontSize: 26, color: GREEN }}>
              {ready}
              {readyTyping && <Caret frame={frame} height={24} />}
            </span>
          </>
        )}
      </div>

      {/* the reviewer-aimed-right idea, spelled once as a footer */}
      <div
        style={{
          position: 'absolute',
          bottom: 34,
          left: 70,
          fontSize: 16,
          color: T.textDim,
          opacity: interpolate(frame, [TL.aim1, TL.aim1 + 14], [0, 1], clamp) * interpolate(frame, [TL.readyType - 10, TL.readyType], [1, 0], clamp),
        }}
      >
        every judge points at what matters. the reviewer was looking at the right thing.
      </div>
    </AbsoluteFill>
  );
};
