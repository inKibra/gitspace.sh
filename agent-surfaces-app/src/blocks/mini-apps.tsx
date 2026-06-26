import type { FC, ReactNode } from 'react';
import { triggerForData } from '../data/mock';
import type {
  MetricTile, RollupNode, ShipPanel, SloRow, Trigger, RubricVerdict,
} from '../data/mock';
import { LastRunChip } from '../app/LastRunMenu';

// ── gitspace-mini-app: a self-contained app that renders a data artifact ──
// Generalised from the mockup apps. An app is pure presentation over `data`;
// a workflow refreshes the data on a trigger. Register here, host in a frame.
export type MiniApp = FC<{ data: unknown; panel: ShipPanel }>;

const V_CHIP: Record<RubricVerdict, string> = { pass: 'green', fail: 'red', partial: 'amber', pending: 'dim' };

// tiny inline sparkline from a series
function Spark({ series, tone }: { series: number[]; tone: string }) {
  const w = 64, h = 18, min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * w},${h - ((v - min) / span) * h}`).join(' ');
  const stroke = tone === 'green' ? 'var(--gs-success)' : tone === 'amber' ? 'var(--gs-warning)' : tone === 'red' ? 'var(--gs-danger)' : 'var(--gs-text-muted)';
  return <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}><polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" /></svg>;
}

const Tile = ({ t }: { t: MetricTile }) => (
  <div className="mtile">
    <div className="mtile-label">{t.label}</div>
    <div className="mtile-value mono">{t.value}</div>
    {t.delta && <div className={`mtile-delta ${t.tone ?? 'flat'}`}>{t.delta}</div>}
  </div>
);

// ── apps ──
const OpsBoard: MiniApp = ({ data }) => (
  <div className="mtiles">{(data as MetricTile[]).map((t, i) => <Tile key={i} t={t} />)}</div>
);

const SloRubric: MiniApp = ({ data }) => (
  <table className="sloapp"><tbody>{(data as SloRow[]).map((r, i) => (
    <tr key={i}>
      <td className="slo-crit">{r.criterion}</td>
      <td className="slo-target mono dim">{r.target}</td>
      <td className="slo-cur mono">{r.current}</td>
      <td className="slo-spark"><Spark series={r.trend} tone={V_CHIP[r.verdict]} /></td>
      <td><span className={`chip ${V_CHIP[r.verdict]}`}>{r.verdict}</span></td>
    </tr>
  ))}</tbody></table>
);

const KIND_TONE: Record<string, string> = { cron: 'blue', event: 'violet', manual: 'dim' };
const STATUS_TONE: Record<string, string> = { ok: 'green', pending: 'amber', failed: 'red', idle: 'dim' };
const CronsTriggers: MiniApp = ({ data }) => (
  <table className="cronapp">
    <thead><tr><th>trigger</th><th>when</th><th>runs</th><th>writes → feeds</th><th>last</th><th></th><th></th></tr></thead>
    <tbody>{(data as Trigger[]).map((t) => (
      <tr key={t.id}>
        <td className="cron-name">{t.name}</td>
        <td><span className={`chip ${KIND_TONE[t.kind]}`}>{t.kind}</span> <span className="dim mono cron-when">{t.when}</span></td>
        <td className="mono cron-wf">{t.runs.type}: {t.runs.ref}</td>
        <td className="cron-flow"><span className="mono">{t.writes.join(', ')}</span> <span className="dim">→ {t.feeds.join(', ')}</span></td>
        <td className="mono dim cron-last">{t.last}{t.next ? ` · ${t.next}` : ''}</td>
        <td><span className={`chip ${STATUS_TONE[t.status]}`}>{t.status}</span></td>
        <td><button className="btn xs">⟳ Run</button></td>
      </tr>
    ))}</tbody>
  </table>
);

// chain roll-up: each shipped workspace contributes its OWN dashboard(s)
const ChainRollup: MiniApp = ({ data }) => (
  <div className="rollup">
    <div className="rollup-bar">
      <span className="dim">roll-up across shipped workspaces in this chain</span>
      <span className="rollup-toggle"><button className="seg on">multiple dashboards</button><button className="seg">aggregate</button></span>
    </div>
    <div className="rollup-grid">
      {(data as RollupNode[]).map((n, i) => (
        <div key={i} className="rollup-card">
          <div className="rollup-card-h">
            <span className="rollup-ws mono">{n.workspace}</span>
            <span className={`chip ${n.repo === 'pruned' ? 'dim' : 'green'}`}>{n.repo === 'pruned' ? 'repo pruned · base kept' : 'repo on disk'}</span>
          </div>
          <div className="rollup-goal">{n.goal} <span className="dim">· shipped {n.shipped}</span></div>
          <div className="rollup-tiles">{n.tiles.map((t, j) => <Tile key={j} t={t} />)}</div>
          <div className="rollup-foot"><span className="dim">{n.dashboards} dashboard{n.dashboards > 1 ? 's' : ''}</span><button className="btn xs">open ↗</button></div>
        </div>
      ))}
    </div>
  </div>
);

const Campaign: MiniApp = () => (
  <div className="dim" style={{ padding: 18, fontSize: 12 }}>Outreach campaign app — a workflow that acts on what you shipped (stub).</div>
);

export const MINI_APPS: Record<string, MiniApp> = {
  'ops-board': OpsBoard,
  'slo-rubric': SloRubric,
  'crons-triggers': CronsTriggers,
  'chain-rollup': ChainRollup,
  'campaign': Campaign,
};

// ── the frame that hosts a mini-app on the canvas (resizable) ──
export function MiniAppFrame({ panel, onToggleSize, onRemove, children }: {
  panel: ShipPanel; onToggleSize: () => void; onRemove: () => void; children: ReactNode;
}) {
  const trig = triggerForData(panel.data);
  const stale = trig && (trig.status === 'failed' || trig.status === 'pending');
  return (
    <div className={`miniapp ${panel.size}`}>
      <div className="miniapp-bar">
        <span className="ma-dot" />
        <span className="ma-title">{panel.title}</span>
        <span className={`ma-scope ${panel.scope}`}>{panel.scope}</span>
        <span className="ma-art mono dim" title="agent-authored · stored as artifact">✦ {panel.artifact}</span>
        {stale && <span className="chip amber ma-stale">stale</span>}
        <span className="ma-spacer" />
        {trig
          ? <LastRunChip trigger={trig} />
          : panel.source && <span className="ma-fresh mono dim">⟳ {panel.source} · {panel.updated}</span>}
        <button className="ma-btn" title="agentation — leave feedback for the agent">✎</button>
        <button className="ma-btn" title="resize" onClick={onToggleSize}>{panel.size === 'full' ? '⊟' : '⊞'}</button>
        <button className="ma-btn" title="remove" onClick={onRemove}>✕</button>
      </div>
      <div className="miniapp-body">{children}</div>
    </div>
  );
}
