import { useState } from 'react';
import type { Stage, Workspace } from '../data/mock';
import {
  STAGES, STAGE_LABEL, STAGE_BLURB, WORKSPACES, PROJECTS,
  WS_STATUS, WS_STATUS_COLOR, WS_STATUS_LABEL, WS_MACHINE, BOARD_STACKS, ALIGN_TONE,
} from '../data/mock';

const ALIGN_GLYPH: Record<string, string> = { aligned: '✓', 'needs-rebase': '⇅', 'dirty-worktree': '±', 'missing-branch': '✕', 'missing-workspace': '○' };

function Card({ ws, i, onOpen }: { ws: Workspace; i: number; onOpen: (ws: Workspace, s: Stage) => void }) {
  const status = WS_STATUS[ws.id] ?? 'idle';
  const m = WS_MACHINE[ws.id];
  return (
    <button onClick={() => onOpen(ws, ws.stage)} className="wscard" style={{ borderLeftColor: WS_STATUS_COLOR[status], animationDelay: `${i * 45}ms` }}>
      <div className="row" style={{ gap: 7 }}>
        <span className="wscard-dot" style={{ background: WS_STATUS_COLOR[status] }} title={WS_STATUS_LABEL[status]} />
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--gs-text)' }}>{ws.name}</span>
        {ws.chainTitle && <span className="chip dim" style={{ marginLeft: 'auto' }}>⛓ {ws.chainPos ?? ''}</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 5 }}>{ws.summary}</div>
      <div className="row" style={{ marginTop: 7, gap: 8 }}>
        {m && <span className="wscard-machine"><span className="wscard-mdot" style={{ background: m.online ? 'var(--gs-success)' : 'var(--gs-text-dim)' }} />{m.remote ? m.name : 'local'}</span>}
        {ws.ready && <span className="tnum" style={{ fontSize: 11, marginLeft: 'auto', color: ws.ready.passed === ws.ready.total ? 'var(--gs-success)' : 'var(--gs-warning)' }}>{ws.ready.passed}/{ws.ready.total} gates</span>}
      </div>
    </button>
  );
}

function Stacks({ onOpen }: { onOpen: (ws: Workspace, s: Stage) => void }) {
  const open = (wsId?: string) => { const w = WORKSPACES.find((x) => x.id === wsId); if (w) onOpen(w, w.stage); };
  return (
    <div className="stacks">
      {BOARD_STACKS.map((st) => (
        <div key={st.id}>
          <div className="stacklane-h"><span className="stacklane-t">⛓ {st.title}</span><span className="dim" style={{ fontSize: 11 }}>{st.group} · {st.nodes.length} goals</span></div>
          <div className="stacklane">
            {st.nodes.map((n, i) => (
              <div key={n.goalId} style={{ display: 'flex', alignItems: 'center' }}>
                <div className={`snode ${n.here ? 'here' : ''} ${n.wsId ? 'nav' : ''}`} onClick={() => open(n.wsId)} style={{ cursor: n.wsId ? 'pointer' : 'default' }}>
                  <div className="snode-h">
                    <span className={`snode-dot ${n.status}`} />
                    <span className="snode-t">{n.title}</span>
                    {n.here && <span className="snode-here">here</span>}
                  </div>
                  <div className="snode-meta">
                    <span className="snode-phase">{n.status === 'planned' ? 'planned' : n.phase}</span>
                    <span className={`chip ${ALIGN_TONE[n.align]}`}>{n.align}</span>
                  </div>
                  {!n.wsId && <button className="btn xs snode-create" onClick={(e) => { e.stopPropagation(); }}>＋ Create workspace</button>}
                </div>
                {i < st.nodes.length - 1 && <span className={`sconn ${st.nodes[i + 1].align}`} title={st.nodes[i + 1].align}>→</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Board({ onOpen, onOpenProject }: { onOpen: (ws: Workspace, s: Stage) => void; onOpenProject?: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'workspaces' | 'stacks'>('workspaces');
  const projects = PROJECTS.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="ghome">
      <div className="ghome-projects">
        <div className="ghome-ph">
          <span className="kicker">Projects</span>
          <input className="ghome-filter" placeholder="filter projects…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn primary sm">＋ New project</button>
        </div>
        <div className="ghome-pgrid">
          {projects.map((p) => (
            <button key={p.id} className="projcard" onClick={() => onOpenProject?.(p.id)}>
              <div className="projcard-h"><span className="mono projcard-n">{p.name}</span>{p.inProcess > 0 && <span className="dotpulse" />}</div>
              <div className="projcard-m dim">{p.chains} chains · {p.workspaces} workspaces{p.inProcess > 0 ? ` · ${p.inProcess} active` : ''}</div>
              <div className="projcard-open">enter project home →</div>
            </button>
          ))}
        </div>
      </div>

      <div className="ghome-kanban-h">
        <span className="kicker">{view === 'workspaces' ? 'All workspaces · across projects' : 'Goal stacks · alignment across the chain'}</span>
        <span className="board-modes">
          <button className={`board-mode ${view === 'workspaces' ? 'on' : ''}`} onClick={() => setView('workspaces')}>Workspaces</button>
          <button className={`board-mode ${view === 'stacks' ? 'on' : ''}`} onClick={() => setView('stacks')}>Stacks</button>
        </span>
      </div>

      {view === 'workspaces' ? (
        <div className="ghome-kanban">
          {STAGES.map((stage) => {
            const items = WORKSPACES.filter((w) => w.stage === stage);
            return (
              <div key={stage} className="ghome-col">
                <div className="ghome-col-h">
                  <div className="row">
                    <span style={{ fontWeight: 600, color: 'var(--gs-text)' }}>{STAGE_LABEL[stage]}</span>
                    <span className="tnum dim" style={{ marginLeft: 'auto', fontSize: 11 }}>{items.length}</span>
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{STAGE_BLURB[stage]}</div>
                </div>
                <div className="ghome-col-b">
                  {items.length === 0
                    ? <div className="ghome-empty dim">No workspaces in {STAGE_LABEL[stage].toLowerCase()}</div>
                    : items.map((ws, i) => <Card key={ws.id} ws={ws} i={i} onOpen={onOpen} />)}
                </div>
              </div>
            );
          })}
        </div>
      ) : <Stacks onOpen={onOpen} />}
    </div>
  );
}
