import React from 'react';
import { AbsoluteFill, interpolate } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, typed, Caret, pulse } from '../../../lib/ui';
import { TL } from '../timeline';
import { HUMAN_LINE, AGENT_CMDS, REQS } from '../rubric';

/**
 * ACT 1 — SET THE BAR. The planning surface: a human types the bar (green,
 * #00ff66 = the human's authorship), then the AGENT authors the rubric (blue,
 * #4488ff = the agent's authorship). Two requirement cards land, each with a
 * judge "aimed at" what matters, while the agent's `space goal requirement add`
 * commands stream in a side panel — tagged as the AGENT's action, never a `$`
 * prompt a human typed.
 */

const HUMAN = T.running; // #00ff66 — human authorship (green)
const AGENT = T.waiting; // #4488ff — agent authorship (blue)

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** One requirement card the agent authors into the rubric. */
const ReqCard: React.FC<{ index: number; frame: number }> = ({ index, frame }) => {
  const r = REQS[index]!;
  const op = enter(frame, r.appear, 10);
  const rise = (1 - op) * 22;
  return (
    <div
      style={{
        marginTop: 18,
        border: `1px solid ${T.border}`,
        borderLeft: `4px solid ${AGENT}`,
        background: T.surface,
        padding: '20px 26px',
        opacity: op,
        transform: `translateY(${rise}px)`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span style={{ fontSize: 15, color: AGENT, letterSpacing: '0.06em' }}>{index + 1}.</span>
        <span style={{ fontSize: 27, color: T.text }}>{r.title}</span>
      </div>
      {/* the machine-readable spec: kind · judge · expect */}
      <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        {[
          ['kind', r.kind],
          ['judge', r.judge],
          ['expect', r.expect],
        ].map(([k, v]) => (
          <span
            key={k}
            style={{
              fontSize: 16,
              color: T.textMuted,
              border: `1px solid ${T.border}`,
              padding: '4px 12px',
              background: T.bg,
            }}
          >
            <span style={{ color: T.textDim }}>{k} </span>
            <span style={{ color: v === 'video' || v === 'human' ? AGENT : T.text }}>{v}</span>
          </span>
        ))}
      </div>
      {/* the judge, aimed at what matters */}
      <div style={{ fontSize: 17, color: T.textDim, marginTop: 14, opacity: enter(frame, r.appear + 8, 10) }}>
        {r.aim}
      </div>
    </div>
  );
};

export const PlanSurface: React.FC<{ frame: number }> = ({ frame }) => {
  const humanMsg = typed(HUMAN_LINE, frame, TL.humanType, 1.2);
  const humanTyping = frame >= TL.humanType && humanMsg.length < HUMAN_LINE.length;
  const agentUp = frame >= TL.agentStart;

  return (
    <AbsoluteFill style={{ background: T.bg, fontFamily: MONO }}>
      {/* goal header (global chrome bar sits above as a fixed layer) */}
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
          <div style={{ fontSize: 15, letterSpacing: '0.18em', color: T.textDim, marginBottom: 6 }}>
            GOAL · NEW
          </div>
          <div style={{ fontSize: 27, color: T.text }}>refactor-checkout</div>
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 16, color: T.textDim }}>
          before it starts · agree on done
        </div>
      </div>

      {/* main column: the bar, then the authored rubric */}
      <div style={{ position: 'absolute', top: 210, left: 70, width: 1060 }}>
        {/* the human sets the bar — green authorship */}
        <div
          style={{
            border: `1px solid ${T.border}`,
            borderLeft: `4px solid ${HUMAN}`,
            background: T.surface,
            padding: '20px 26px',
          }}
        >
          <div style={{ fontSize: 15, letterSpacing: '0.18em', color: HUMAN, marginBottom: 12 }}>
            YOU · THE BAR
          </div>
          <div style={{ fontSize: 25, lineHeight: '40px', color: T.text, minHeight: 80 }}>
            {humanMsg}
            {humanTyping && <Caret frame={frame} height={24} color={HUMAN} />}
          </div>
        </div>

        {/* the agent authors the rubric — blue authorship */}
        {agentUp && (
          <div style={{ marginTop: 22, opacity: enter(frame, TL.agentStart, 8) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span
                style={{
                  width: 11,
                  height: 11,
                  background: AGENT,
                  boxShadow: `0 0 ${8 + pulse(frame % 30, 4, 24) * 14}px ${AGENT}`,
                }}
              />
              <span style={{ fontSize: 16, letterSpacing: '0.16em', color: AGENT }}>
                PI · AUTHORING RUBRIC
              </span>
              <span style={{ fontSize: 16, color: T.textDim }}>· 2 requirements</span>
            </div>
            <ReqCard index={0} frame={frame} />
            <ReqCard index={1} frame={frame} />
          </div>
        )}
      </div>

      {/* side panel: the AGENT's commands stream (not a human at a prompt) */}
      <div
        style={{
          position: 'absolute',
          top: 210,
          left: 1180,
          width: 660,
          bottom: 60,
          border: `1px solid ${T.border}`,
          background: '#050505',
          padding: '20px 24px',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontSize: 14, letterSpacing: '0.18em', color: T.textDim, marginBottom: 18 }}>
          AGENT ACTIVITY
        </div>
        {AGENT_CMDS.map((cmd, i) => {
          // the two `requirement add` calls land with their two cards
          const at = i < 2 ? TL.cmd1 : TL.cmd2;
          const op = enter(frame, at + (i % 2) * 6, 8);
          const isHead = i % 2 === 0;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 10,
                fontSize: 17,
                lineHeight: '30px',
                opacity: op,
                marginTop: isHead && i > 0 ? 16 : 0,
              }}
            >
              {isHead && (
                <span style={{ color: AGENT, flex: 'none', letterSpacing: '0.04em' }}>agent ran</span>
              )}
              <span style={{ color: isHead ? T.textMuted : T.textDim, whiteSpace: 'pre' }}>
                {cmd}
              </span>
            </div>
          );
        })}
        {/* footer: authorship legend — makes the blue-is-the-agent read explicit */}
        <div
          style={{
            position: 'absolute',
            left: 24,
            right: 24,
            bottom: 18,
            display: 'flex',
            gap: 22,
            fontSize: 15,
            color: T.textDim,
            borderTop: `1px solid ${T.borderMuted}`,
            paddingTop: 14,
            opacity: interpolate(frame, [TL.cmd1, TL.cmd1 + 12], [0, 1], clamp),
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, background: HUMAN }} /> you set the bar
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, background: AGENT }} /> the agent writes the checks
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
