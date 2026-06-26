import { useState } from 'react';
import type { Stage, Workspace, Dashboard } from '../data/mock';
import { STAGES, STAGE_LABEL, STAGE_VAR, STAGE_CAPS, chainForWorkspace, services, terminals } from '../data/mock';
import type { Pane } from './Shell';

const SVC_TONE: Record<string, string> = { ready: 'var(--gs-success)', running: 'var(--gs-success)', stopped: 'var(--gs-text-dim)', failed: 'var(--gs-danger)' };

export function Sidebar({ ws, stage, onSwitchStage, active, onOpen, onSwitchWorkspace, dashboards = [] }: {
  ws: Workspace; stage: Stage; onSwitchStage: (s: Stage) => void; active: string; onOpen: (p: string) => void;
  onSwitchWorkspace?: (id: string) => void; dashboards?: Dashboard[];
}) {
  const [menu, setMenu] = useState(false);
  const goal = ws.ready ? `${ws.ready.passed}/${ws.ready.total}` : '—';
  const chain = chainForWorkspace(ws.id);
  const item = (p: Pane, icon: string, label: string, rt?: string) => (
    <div className={`litem ${active === p ? 'on' : ''}`} onClick={() => onOpen(p)}>
      <span className="ic">{icon}</span>{label}{rt && <span className="rt">{rt}</span>}
    </div>
  );

  const chainBlock = chain && (
    <>
      <div className="sb-grp chain-grp">Chain · {chain.chain.title}</div>
      <div className="chainstack">
        {chain.chain.nodes.map((nd, i) => {
          const isCurrent = nd.goalId === chain.currentGoalId;
          const navigable = !!nd.wsId && !isCurrent && !!onSwitchWorkspace;
          return (
            <div key={nd.goalId} className={`cs-node ${nd.status} ${isCurrent ? 'current' : ''} ${navigable ? 'nav' : ''}`} onClick={() => { if (navigable) onSwitchWorkspace!(nd.wsId!); }}>
              <span className="cs-rail"><span className={`cs-dot ${nd.status}`} />{i < chain.chain.nodes.length - 1 && <span className="cs-line" />}</span>
              <span className="cs-body">
                <span className="cs-title">{nd.title}</span>
                <span className="cs-meta">
                  <span className={`cs-phase ${nd.status}`}>{nd.status === 'planned' ? 'planned' : nd.phase}</span>
                  {nd.ready && <span className="cs-ready mono">{nd.ready.passed}/{nd.ready.total}</span>}
                  {isCurrent && <span className="cs-here">here</span>}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <aside className="sidebar">
      <div className="sb-wh">
        <span className="nm mono">{ws.name}</span>
        <div className="stagewrap">
          <button className="stagebtn" style={{ color: STAGE_VAR[stage], borderColor: STAGE_VAR[stage] }} onClick={() => setMenu((m) => !m)}>{stage} ▾</button>
          {menu && (
            <div className="stagemenu">
              {STAGES.map((s) => (
                <button key={s} className={s === stage ? 'on' : ''} onClick={() => { onSwitchStage(s); setMenu(false); }}>
                  <span className="sd" style={{ background: STAGE_VAR[s] }} />
                  <span className="stagemenu-main">{STAGE_LABEL[s]}<span className="stagemenu-note dim">{STAGE_CAPS[s].note}</span></span>
                  {s === stage && <span className="rt" style={{ color: 'var(--gs-text-dim)' }}>current</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="modecaps">
        <span className="modecaps-h">{stage} mode</span>
        {STAGE_CAPS[stage].unlocks.map((u) => <span key={u} className="modecap">{u}</span>)}
      </div>
      <div className="sb-scroll">
        <div className="sb-grp">Agent</div>
        <div className={`litem ${active === 'agent' ? 'on' : ''}`} onClick={() => onOpen('agent')}><span className="ic">▸</span>agent · main<span className="rt">live</span></div>
        <div className="litem"><span className="ic">＋</span>New thread</div>

        <div className="sb-grp">Terminals</div>
        {terminals.map((t) => (
          <div key={t.id} className={`litem ${active === 'terminals' ? 'on' : ''}`} onClick={() => onOpen(`term:${t.id}`)}>
            <span className="ic">⌗</span>{t.name}{t.busy && <span className="dotpulse" style={{ marginLeft: 'auto' }} />}
          </div>
        ))}
        <div className="litem" onClick={() => onOpen('term:new')}><span className="ic">＋</span>New terminal</div>

        <div className="sb-grp">Surfaces</div>
        {item('goal', '◇', 'Goal doc', goal)}
        {item('workflow', '⟜', 'Workflow', 'live')}
        {item('review', '⛓', 'Change Guide')}
        {item('rubric', '☰', 'Review rubric')}
        {item('crons', '◷', 'Crons & triggers', 'ship')}
        {item('events', '⚑', 'Event logs')}

        <div className="sb-grp">Dashboards</div>
        {dashboards.map((d) => (
          <div key={d.id} className={`litem ${active === `dash:${d.id}` ? 'on' : ''}`} onClick={() => onOpen(`dash:${d.id}`)}>
            <span className="ic">▦</span>{d.name}<span className="rt">{d.panels.length}</span>
          </div>
        ))}
        <div className="litem" onClick={() => onOpen('dash:new')}><span className="ic">＋</span>New dashboard</div>

        <div className="sb-grp">Services</div>
        {services.map((s) => (
          <div key={s.id} className={`litem ${active === 'services' ? 'on' : ''}`} onClick={() => onOpen('services')}>
            <span className="ic" style={{ color: SVC_TONE[s.status] }}>●</span>{s.name}
            {s.ports[0] && <span className="rt mono">:{s.ports[0].port}</span>}
          </div>
        ))}

        {chainBlock}

        <div className="sb-grp">Workspace</div>
        <div className="litem"><span className="ic">◷</span>Change status</div>
        <div className="litem" onClick={() => onOpen('config')}><span className="ic">⚙</span>Bundle config</div>
        <div className="litem danger"><span className="ic">⌫</span>Delete<span className="rt">danger</span></div>
      </div>
    </aside>
  );
}
