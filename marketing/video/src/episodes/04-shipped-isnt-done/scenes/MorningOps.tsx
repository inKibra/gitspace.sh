import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../../lib/theme';
import { enter, pulse } from '../../../lib/ui';
import { TL } from '../timeline';
// the liveness layer — series pattern, home in ep02
import { AgentWork, type WorkStep } from '../../02-evidence-not-vibes/scenes/AgentWork';

/**
 * ACT 2 — THE MORNING AFTER. The dashboard checkout-flags left behind: three
 * tiles, stale (updated 8h ago). The nightly cron fires UNATTENDED — no
 * cursor; that's the point — tiles refresh, the data commit rolls up to main.
 * Then day two: the error rate crosses the rubric's line, the tile goes
 * amber, and the SHIPPED goal reopens with the rubric line quoted as the
 * reason. A strip of the fleet shows what that reopening is: a new amber.
 */

const C = {
  green: T.running,
  amber: T.needsInput,
  red: '#ff4444',
  blue: T.waiting,
  text: T.text,
  dim: '#7a7a7a',
  ghost: '#3c3c3c',
  border: '#1e1e1e',
  elevated: '#0a0a0a',
} as const;

const LEFT = 150;
const TILE_W = 520;
const TILE_H = 210;
const TOP = 250;

const WORK: WorkStep[] = [
  { at: TL.cron - 4, icon: '⏰', verb: 'trigger', target: 'nightly.trigger.json · every 1d', done: TL.cron + 22, result: 'fired' },
  { at: TL.cron + 26, icon: '✎', verb: 'refresh', target: 'data/*.data.json', done: TL.cron + 58, result: 'scope data/** held' },
  { at: TL.cron + 62, icon: '⇪', verb: 'commit', target: 'rollup → main', done: TL.cron + 88, result: 'e4f21' },
  { at: TL.amber + 6, icon: '⚖', verb: 'judge', target: 'R2 · error rate < 0.10%', done: TL.amber + 30, result: '0.14% · fail', ok: false },
  { at: TL.reopen - 8, icon: '↺', verb: 'reopen', target: 'checkout-flags · quote R2', done: TL.reopen + 18, result: 'amber on the board' },
];

const Tile: React.FC<{
  x: number;
  label: string;
  value: string;
  freshValue: string;
  day2Value?: string;
  frame: number;
  bad?: boolean;
}> = ({ x, label, value, freshValue, day2Value, frame, bad }) => {
  const fresh = frame >= TL.cron + 40;
  const isDay2 = frame >= TL.amber && day2Value !== undefined;
  const alarmed = isDay2 && bad;
  const v = isDay2 ? day2Value! : fresh ? freshValue : value;
  const col = alarmed ? C.amber : C.green;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: TOP,
        width: TILE_W,
        height: TILE_H,
        border: `1px solid ${alarmed ? C.amber : C.border}`,
        background: C.elevated,
        boxShadow: alarmed ? `0 0 ${10 + pulse(frame % 34, 0, 34) * 14}px rgba(255,204,0,0.22)` : 'none',
      }}
    >
      <div style={{ padding: '14px 20px', fontSize: 16, color: C.dim, borderBottom: `1px solid ${C.border}`, display: 'flex' }}>
        {label}
        <span style={{ marginLeft: 'auto', color: fresh ? C.green : C.ghost }}>{fresh ? (isDay2 ? 'day 2 · 03:00' : 'day 1 · 03:00') : 'updated 8h ago'}</span>
      </div>
      <div style={{ padding: '22px 20px 0', fontSize: 52, fontWeight: 700, color: col }}>{v}</div>
      {bad && <div style={{ padding: '8px 20px', fontSize: 15, color: alarmed ? C.amber : C.ghost }}>rubric R2 · stays under 0.10%</div>}
    </div>
  );
};

export const MorningOps: React.FC<{ frame: number }> = ({ frame }) => {
  const inOp = enter(frame, TL.dashIn, 12);
  const reopened = frame >= TL.reopen;
  const showFleet = frame >= TL.fleet;

  return (
    <AbsoluteFill style={{ fontFamily: MONO, opacity: inOp }}>
      {/* header — the goal is SHIPPED; this surface is what it left behind */}
      <div style={{ position: 'absolute', top: 100, left: LEFT, right: LEFT, display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span style={{ fontSize: 28, fontWeight: 600, color: C.text }}>checkout-flags</span>
        <span style={{ fontSize: 20, color: C.dim }}>· shipped yesterday · operations</span>
        <span style={{ marginLeft: 'auto', fontSize: 17, color: C.dim }}>goals/checkout-flags/ · on main</span>
      </div>

      {/* the three tiles */}
      <Tile x={LEFT} label="rollout" value="62%" freshValue="100%" day2Value="100%" frame={frame} />
      <Tile x={LEFT + TILE_W + 30} label="error rate" value="0.06%" freshValue="0.07%" day2Value="0.14%" frame={frame} bad />
      <Tile x={LEFT + (TILE_W + 30) * 2} label="checkout p95" value="214ms" freshValue="209ms" day2Value="221ms" frame={frame} />

      {/* the reopened goal — the payoff */}
      {reopened && (
        <div
          style={{
            position: 'absolute',
            left: LEFT,
            top: 540,
            width: TILE_W * 2 + 30,
            border: `1px solid ${C.amber}`,
            background: '#0a0803',
            opacity: enter(frame, TL.reopen, 12),
            boxShadow: `0 0 ${12 + pulse(frame, TL.reopen, 30) * 18}px rgba(255,204,0,0.25)`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px', borderBottom: `1px solid ${C.border}` }}>
            <span style={{ width: 11, height: 11, borderRadius: '50%', background: C.amber, boxShadow: `0 0 ${8 + pulse(frame % 30, 0, 30) * 10}px ${C.amber}` }} />
            <span style={{ fontSize: 24, fontWeight: 700, color: C.text }}>checkout-flags</span>
            <span style={{ fontSize: 18, color: C.amber, border: `1px solid ${C.amber}`, padding: '2px 12px' }}>reopened</span>
            <span style={{ marginLeft: 'auto', fontSize: 15, color: C.dim }}>same folder · same journal · same evidence</span>
          </div>
          <div style={{ padding: '14px 20px', fontSize: 19, color: C.text }}>
            <span style={{ color: C.amber }}>R2 ·</span> “error rate stays under 0.10%” <span style={{ color: C.dim }}>— the line that shipped it</span>
          </div>
        </div>
      )}

      {/* the fleet strip — a reopened goal is just a new amber */}
      {showFleet && (
        <div style={{ position: 'absolute', left: LEFT + TILE_W * 2 + 90, top: 540, width: 490, opacity: enter(frame, TL.fleet, 12) }}>
          <div style={{ fontSize: 15, letterSpacing: '0.18em', textTransform: 'uppercase', color: C.ghost, marginBottom: 10 }}>the fleet</div>
          {[
            { id: 'api-hardening', col: C.green },
            { id: 'relay-metrics', col: C.green },
            { id: 'checkout-flags', col: C.amber },
            { id: 'docs-refresh', col: C.green },
          ].map((g) => (
            <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${C.border}`, background: C.elevated, padding: '9px 16px', marginBottom: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: g.col }} />
              <span style={{ fontSize: 17, color: g.col === C.amber ? C.text : C.dim }}>{g.id}</span>
              {g.col === C.amber && <span style={{ marginLeft: 'auto', fontSize: 14, color: C.amber }}>answer me</span>}
            </div>
          ))}
        </div>
      )}

      {/* the cron and judges, working unattended under everything */}
      <AgentWork frame={frame} start={TL.cron - 10} steps={WORK} top={920} left={LEFT} right={LEFT} label="daemon · unattended" />
    </AbsoluteFill>
  );
};
