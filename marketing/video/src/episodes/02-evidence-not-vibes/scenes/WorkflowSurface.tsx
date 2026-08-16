import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, pulse } from '../../../lib/ui';
import { TLV } from '../timeline-v2';
import { AgentWork, type WorkStep } from './AgentWork';

/**
 * BEATS 3–5 — THE WORKFLOW OF ROLES (sleek marketing version).
 *
 * The marketing abstraction, not the product's dense renderer. The story is the
 * two ROLES: Builder and Reviewer, co-equal and centred. The review GATE is a
 * smaller, subordinate node they hand off to — after the reviewer. While it's
 * blocked, a red loop returns the work to the Builder; when the fix clears the
 * gate, the loop fades and the work passes forward. One idea at a time.
 */

const C = {
  green: T.running, // #00ff66
  red: '#ff4444',
  border: '#1e1e1e',
  elevated: '#0a0a0a',
  text: T.text,
  dim: '#7a7a7a',
  ghost: '#3c3c3c',
} as const;

type GateState = 'pending' | 'unmet' | 'satisfied';

// ── absolute geometry (so the loop path has real anchors) ────────────────────
// Builder + Reviewer are the centred, co-equal pair; the Gate trails, smaller.
const ROLE = { top: 396, h: 210, w: 380 };
const ROLE_BOTTOM = ROLE.top + ROLE.h; // 606
const BUILDER_L = 514;
const REVIEWER_L = 1026;
const GATE = { left: 1512, top: 440, h: 124, w: 224 };
const GATE_BOTTOM = GATE.top + GATE.h; // 576
const CX = { builder: BUILDER_L + ROLE.w / 2, reviewer: REVIEWER_L + ROLE.w / 2, gate: GATE.left + GATE.w / 2 } as const; // 704 · 1216 · 1670

/** A role node: name (hero), one-line job (dim), a status dot. The primary pair. */
const RoleNode: React.FC<{
  name: string;
  job: string;
  left: number;
  dotColor: string;
  op: number;
  hot?: boolean;
  frame: number;
}> = ({ name, job, left, dotColor, op, hot, frame }) => (
  <div
    style={{
      position: 'absolute',
      left,
      top: ROLE.top,
      width: ROLE.w,
      height: ROLE.h,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '0 34px',
      border: `1px solid ${hot ? 'rgba(255,68,68,0.5)' : C.border}`,
      background: C.elevated,
      opacity: op,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
      <span
        style={{
          width: 13,
          height: 13,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: hot ? `0 0 ${12 + pulse(frame % 30, 0, 30) * 14}px ${dotColor}` : 'none',
        }}
      />
      <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: '-0.02em', color: C.text }}>{name}</span>
    </div>
    <div style={{ fontSize: 23, color: C.dim }}>{job}</div>
  </div>
);

/** A little review-gate boom barrier (scaled): arm DOWN + red while blocked,
 *  LIFTS open + green when the work clears. */
const GateGlyph: React.FC<{ state: GateState; frame: number; greenAt: number; scale: number }> = ({ state, frame, greenAt, scale }) => {
  const unmet = state === 'unmet';
  const sat = state === 'satisfied';
  const armColor = unmet ? C.red : sat ? C.green : C.ghost;
  const lift = interpolate(frame, [greenAt, greenAt + 14], [0, -64], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const armRot = sat ? lift : 0;
  const glow = unmet ? 6 + pulse(frame % 34, 0, 34) * 7 : sat ? 9 : 0;
  return (
    <div style={{ width: 94 * scale, height: 54 * scale, marginBottom: 14 * scale, position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, width: 94, height: 54, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        <div style={{ position: 'absolute', left: 0, bottom: 0, width: 94, height: 3, background: C.ghost }} />
        <div style={{ position: 'absolute', left: 7, bottom: 0, width: 7, height: 46, background: C.dim }} />
        <div
          style={{
            position: 'absolute',
            left: 10,
            bottom: 43,
            width: 72,
            height: 7,
            background: armColor,
            transformOrigin: 'left center',
            transform: `rotate(${armRot}deg)`,
            boxShadow: glow > 0.5 ? `0 0 ${glow}px ${armColor}` : 'none',
          }}
        />
      </div>
    </div>
  );
};

/** The GATE — a smaller, subordinate node after the reviewer. Its state is the
 *  only saturated colour, but it does not out-weigh the two roles. */
const GateNode: React.FC<{ state: GateState; op: number; frame: number; greenAt: number }> = ({ state, op, frame, greenAt }) => {
  const unmet = state === 'unmet';
  const sat = state === 'satisfied';
  const color = unmet ? C.red : sat ? C.green : C.ghost;
  const glow = unmet ? 16 + pulse(frame % 34, 0, 34) * 10 : sat ? 10 + pulse(frame, greenAt, 26) * 16 : 0;
  const label = unmet ? '✕  blocked' : sat ? '✓  cleared' : 'gate';
  return (
    <div
      style={{
        position: 'absolute',
        left: GATE.left,
        top: GATE.top,
        width: GATE.w,
        height: GATE.h,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 18px',
        border: `1px dashed ${color}`,
        background: unmet ? 'rgba(255,68,68,0.04)' : sat ? 'rgba(0,255,102,0.04)' : C.elevated,
        boxShadow: glow > 0.5 ? `0 0 ${glow}px ${unmet ? 'rgba(255,68,68,0.22)' : 'rgba(0,255,102,0.26)'}` : 'none',
        opacity: op,
      }}
    >
      <GateGlyph state={state} frame={frame} greenAt={greenAt} scale={0.46} />
      <div style={{ fontSize: 14, color: C.dim, marginBottom: 5, letterSpacing: '0.04em' }}>review gate</div>
      <div style={{ fontSize: 25, fontWeight: 700, letterSpacing: '-0.01em', color, whiteSpace: 'nowrap' }}>{label}</div>
    </div>
  );
};

/** A forward connector: small verb + chevron, absolutely placed at a gap centre. */
const Flow: React.FC<{ cx: number; verb: string; op: number }> = ({ cx, verb, op }) => (
  <div style={{ position: 'absolute', left: cx - 66, top: 462, width: 132, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: op }}>
    <span style={{ fontSize: 17, color: C.dim, marginBottom: 8, letterSpacing: '0.06em' }}>{verb}</span>
    <span style={{ fontSize: 32, color: C.ghost }}>▶</span>
  </div>
);

export const FINDING = 'the test mocks the total, so it never runs the real code';

/**
 * The roles aren't diagrams, they're agents doing work. This runs quietly under
 * the graph: the builder ships, the reviewer reads and finds the stub (red),
 * the builder fixes it, the suite runs again — and only then does the gate go
 * green above.
 */
const WORK: WorkStep[] = [
  { at: 850, icon: '✎', verb: 'edit', target: 'src/checkout.ts', done: 880, result: '+38 −12' },
  { at: 887, icon: '⧉', verb: 'run', target: 'bun test src/checkout', done: 920, result: '142 pass · 0 fail' },
  { at: 924, icon: '⌕', verb: 'read', target: 'checkout.test.ts', done: 942, result: 'total is hard-coded', ok: false },
  { at: 975, icon: '✎', verb: 'edit', target: 'checkout.test.ts', done: 1010, result: '+22 −9' },
  { at: 1020, icon: '✎', verb: 'edit', target: 'src/checkout.ts', done: 1045, result: '+14 −6' },
  { at: 1042, icon: '⧉', verb: 'run', target: 'bun test src/checkout', done: 1076, result: '142 pass · 0 fail' },
];

export const WorkflowSurface: React.FC<{ frame: number }> = ({ frame }) => {
  const gateState: GateState =
    frame >= TLV.wfGateGreen ? 'satisfied' : frame >= TLV.wfCatch ? 'unmet' : 'pending';
  const unmet = gateState === 'unmet';
  const sat = gateState === 'satisfied';

  const revDot = sat ? C.green : unmet ? C.red : C.dim;

  const loopColor = unmet ? C.red : C.ghost;
  const loopOp = unmet ? enter(frame, TLV.wfCatch, 8) : sat ? 0.12 : 0.3;
  const loopIn = enter(frame, TLV.wfGateIn, 10);

  return (
    // transparent: the shader field behind Product shows through the gaps,
    // the same way the site's hero sits under its content
    <AbsoluteFill style={{ fontFamily: MONO }}>
      {/* kicker — centred over the primary pair */}
      {/* session header — the workflow runs INSIDE the agent run */}
      <div style={{ position: 'absolute', top: 100, left: 150, display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span style={{ fontSize: 28, fontWeight: 600, color: C.text }}>checkout-refactor</span>
        <span style={{ fontSize: 20, color: C.dim }}>· agent · turn 20</span>
      </div>
      <div style={{ position: 'absolute', top: 150, left: 150, display: 'flex', alignItems: 'center', gap: 14, opacity: enter(frame, TLV.wfImplementerIn - 10, 10) }}>
        <span style={{ fontSize: 16, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#4488ff' }}>agent</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, border: '1px solid #bc8cff', background: 'rgba(188,140,255,0.06)', padding: '6px 14px', fontSize: 20, color: '#bc8cff' }}>
          ⚡ running · review-gated-implementation
        </span>
      </div>

      {/* the primary pair — Builder and Reviewer, co-equal + centred */}
      <RoleNode name="Builder" job="writes the code" left={BUILDER_L} dotColor={C.green} op={enter(frame, TLV.wfImplementerIn, 12)} frame={frame} />
      <Flow cx={(BUILDER_L + ROLE.w + REVIEWER_L) / 2} verb="builds" op={enter(frame, TLV.wfConnectorIn, 10)} />
      <RoleNode name="Reviewer" job="only reviews · hunts the lie" left={REVIEWER_L} dotColor={revDot} hot={unmet} op={enter(frame, TLV.wfReviewerIn, 12)} frame={frame} />

      {/* the subordinate gate — smaller, after the reviewer */}
      <Flow cx={(REVIEWER_L + ROLE.w + GATE.left) / 2} verb="verdict" op={enter(frame, TLV.wfGateIn - 4, 10)} />
      <GateNode state={gateState} op={enter(frame, TLV.wfGateIn, 12)} frame={frame} greenAt={TLV.wfGateGreen} />

      {/* the LOOP — the gate sends it back to the builder while blocked */}
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: loopIn }}>
        <path
          d={`M${CX.gate},${GATE_BOTTOM} V664 Q${CX.gate},680 ${CX.gate - 16},680 H${CX.builder + 16} Q${CX.builder},680 ${CX.builder},664 V${ROLE_BOTTOM + 6}`}
          fill="none"
          stroke={loopColor}
          strokeWidth={3}
          opacity={loopOp}
        />
        <path d={`M${CX.builder},${ROLE_BOTTOM - 2} l-9,18 l18,0 z`} fill={loopColor} opacity={loopOp} />
      </svg>

      {/* the roles are actually working, under the graph */}
      <AgentWork frame={frame} start={TLV.wfImplementerIn + 4} steps={WORK} top={706} left={150} right={150} />

      {/* composer — you're in the workspace, the agent is running the workflow */}
      <div style={{ position: 'absolute', bottom: 54, left: 150, right: 150, display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${C.border}`, background: C.elevated, padding: '16px 20px' }}>
        <span style={{ fontSize: 22, color: '#4488ff' }}>›</span>
        <span style={{ fontSize: 24, color: C.ghost }}>message the agent</span>
      </div>
    </AbsoluteFill>
  );
};
