import { useState } from 'react';
import { AgentChat } from './AgentChat';
import { DashboardCanvas } from './DashboardCanvas';
import { ProjectCronsTriggers } from './CronsTriggers';
import { NoteView } from './NoteView';
import { ProjectArtifactsRail } from './ProjectArtifactsRail';
import { EvidenceViewer } from './EvidenceViewer';
import { ArtifactViewer } from './ArtifactViewer';
import {
  CHAIN_STACKS, WORKSPACES, reportItems, notesList,
  recentlyShipped, projectDashboards,
} from '../data/mock';
import type { ChainStack, Dashboard, ReportItem, ShipPanel } from '../data/mock';

// fixed panes + dynamic dashboard tabs (`dash:<id>`) + note tabs (`note:<i>`)
type PTab = 'overview' | 'agent' | 'crons' | 'reports' | 'process' | 'chains' | 'config';
const TAB_LABEL: Record<PTab, string> = {
  overview: 'Overview', agent: 'Project agent', crons: 'Crons & triggers', reports: 'Reports', process: 'In process', chains: 'Chains', config: 'Bundle config',
};
const isDash = (t: string) => t.startsWith('dash:');
const dashId = (t: string) => t.slice(5);
const isNote = (t: string) => t.startsWith('note:');
const isEv = (t: string) => t.startsWith('ev:');
const isArtifact = (t: string) => t.startsWith('artifact:');

const RK: Record<string, { tone: string; label: string }> = {
  'good-pattern': { tone: 'green', label: 'good pattern' },
  'praise': { tone: 'blue', label: 'praise' },
  'frustration': { tone: 'amber', label: 'frustration' },
  'workflow-quirk': { tone: 'amber', label: 'workflow quirk' },
  'gitspace-quirk': { tone: 'violet', label: 'gitspace quirk' },
};

const CHAIN_GROUPS: { group: string; chains: ChainStack[] }[] = [
  { group: 'Editor pipeline', chains: CHAIN_STACKS },
  { group: 'Growth', chains: [
    { id: 'chain-sharing', title: 'Sharing & reach', nodes: [
      { goalId: 's1', title: 'Typed share union', phase: 'plan', status: 'active', wsId: 'share-union' },
      { goalId: 's2', title: 'Share renderer', phase: 'planned', status: 'planned' },
    ] },
  ] },
];

function ReportRow({ r }: { r: ReportItem }) {
  const k = RK[r.kind];
  const [planned, setPlanned] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <div className="ph-feed-row">
      <span className={`chip ${k.tone}`}>{k.label}</span>
      <div className="ph-feed-main">
        <div className="ph-feed-top"><span className="ph-feed-surface mono">{r.surface}</span></div>
        <div className="ph-feed-note">{r.note}</div>
        <div className="ph-feed-actions">
          {planned ? <span className="chip green">→ drafted chain</span> : <button className="btn xs" onClick={() => setPlanned(true)}>＋ Plan from this</button>}
          {r.kind === 'gitspace-quirk' && (sent
            ? <span className="chip violet">reported to GitSpace ✓</span>
            : <button className="btn xs" onClick={() => setSent(true)}>↗ Report to GitSpace</button>)}
        </div>
      </div>
    </div>
  );
}

function Chains({ onOpenWorkspace }: { onOpenWorkspace: (id: string) => void }) {
  return (
    <div className="ph-pad">
      {CHAIN_GROUPS.map((g) => (
        <div key={g.group} className="ph-chgroup">
          <div className="ph-chgroup-h">{g.group}</div>
          {g.chains.map((c) => {
            const cur = c.nodes.find((n) => n.wsId);
            return (
              <div key={c.id} className="ph-chain" onClick={() => cur?.wsId && onOpenWorkspace(cur.wsId)}>
                <span className="ph-chain-t">{c.title}</span>
                <span className="ph-chain-nodes">{c.nodes.map((n) => <span key={n.goalId} className={`cs-dot ${n.status}`} title={`${n.title} · ${n.status}`} />)}</span>
                <span className="dim ph-chain-meta">{c.nodes.length} goals</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function InProcess({ onOpenWorkspace }: { onOpenWorkspace: (id: string) => void }) {
  const items = WORKSPACES.filter((w) => w.agentBusy || (w.ready && w.ready.passed < w.ready.total));
  return (
    <div className="ph-pad">
      {items.map((w) => (
        <div key={w.id} className="ph-proc" onClick={() => onOpenWorkspace(w.id)}>
          {w.agentBusy && <span className="dotpulse" />}
          <span className="ph-proc-name mono">{w.name}</span>
          <span className="chip dim">{w.stage}</span>
          <span className="dim ph-proc-meta">{w.agentBusy ? 'agent running' : w.ready ? `${w.ready.passed}/${w.ready.total} gates` : ''}</span>
        </div>
      ))}
    </div>
  );
}

function ReportsFeed() {
  return (
    <div className="ph-pad ph-feed">
      {reportItems.map((r, i) => <ReportRow key={i} r={r} />)}
    </div>
  );
}

// small star rater for the roll-up rate step
function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <span className="rater">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} className={`rstar ${n <= value ? 'on' : ''}`} onClick={() => onChange(n)}>★</button>
      ))}
    </span>
  );
}

let dseq = 700;

export function ProjectHome({ onOpenWorkspace, onOpenBoard }: { onOpenWorkspace: (id: string) => void; onOpenBoard: () => void }) {
  const [tabs, setTabs] = useState<string[]>(['overview']);
  const [active, setActive] = useState<string>('overview');
  const [dashboards, setDashboards] = useState<Dashboard[]>(projectDashboards);
  const [rolled, setRolled] = useState<Record<string, boolean>>({});
  const [rating, setRating] = useState<string | null>(null); // workspace mid-rate
  const [stars, setStars] = useState<Record<string, number>>({}); // artifactKey → rating
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const toggleFav = (id: string) => setFavorites((f) => { const n = new Set(f); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const open = (t: string) => { setTabs((s) => (s.includes(t) ? s : [...s, t])); setActive(t); };
  const closeTab = (t: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs((s) => { const next = s.filter((x) => x !== t); if (active === t) setActive(next[next.length - 1] ?? 'overview'); return next; });
  };

  const setDashPanels = (id: string) => (fn: (p: ShipPanel[]) => ShipPanel[]) =>
    setDashboards((ds) => ds.map((d) => d.id === id ? { ...d, panels: fn(d.panels) } : d));

  // roll-up: promote a shipped workspace's whole dashboard into the project + open it
  const rollUp = (workspace: string, dashboard: Dashboard) => {
    setRolled((r) => ({ ...r, [workspace]: true }));
    setDashboards((ds) => (ds.some((d) => d.id === dashboard.id) ? ds : [...ds, dashboard]));
    open(`dash:${dashboard.id}`);
  };

  const newDash = () => {
    const id = `db-new-${dseq++}`;
    setDashboards((ds) => [...ds, { id, name: 'New dashboard', scope: 'project', panels: [] }]);
    open(`dash:${id}`);
  };

  const tabLabel = (t: string) => isDash(t) ? (dashboards.find((d) => d.id === dashId(t))?.name ?? 'Dashboard')
    : isNote(t) ? `✎ ${t === 'note:new' ? 'New note' : (notesList[Number(t.slice(5))]?.title ?? 'Note')}`
    : isEv(t) ? `▸ ${t.slice(3)}`
    : isArtifact(t) ? `◇ ${t.slice(9)}`
    : TAB_LABEL[t as PTab];
  const inProcessCount = WORKSPACES.filter((w) => w.agentBusy || (w.ready && w.ready.passed < w.ready.total)).length;
  const navItem = (t: PTab, icon: string, rt?: string) => (
    <div className={`litem ${active === t ? 'on' : ''}`} onClick={() => open(t)}><span className="ic">{icon}</span>{TAB_LABEL[t]}{rt && <span className="rt">{rt}</span>}</div>
  );

  return (
    <div className="phome2">
      {/* left navigator */}
      <aside className="ph-sb">
        <div className="ph-sb-wh">
          <span className="nm mono">tone-tempo</span>
          <button className="ph-allproj" onClick={onOpenBoard}>⊞ All projects</button>
        </div>
        <div className="sb-scroll">
          <div className="sb-grp">Agent</div>
          {navItem('agent', '✦', 'live')}
          <div className="litem"><span className="ic">＋</span>New thread</div>

          <div className="sb-grp">Project</div>
          {navItem('overview', '◎')}
          {navItem('process', '◷', String(inProcessCount))}
          {navItem('reports', '⚑', String(reportItems.length))}
          {navItem('chains', '⛓', '2')}
          {navItem('crons', '◷')}

          <div className="sb-grp">Dashboards</div>
          {dashboards.map((d) => (
            <div key={d.id} className={`litem ${active === `dash:${d.id}` ? 'on' : ''}`} onClick={() => open(`dash:${d.id}`)}>
              <span className="ic">▦</span>{d.name}
              {d.source?.startsWith('rolled up') && <span className="li-roll" title={d.source}>⤴</span>}
              <span className="rt">{d.panels.length}</span>
            </div>
          ))}
          <div className="litem" onClick={newDash}><span className="ic">＋</span>New dashboard</div>

          <div className="sb-grp">Config</div>
          {navItem('config', '⚙')}
        </div>
      </aside>

      {/* center multi-tab */}
      <div className="ph-center">
        <div className="tabstrip">
          {tabs.map((t) => (
            <div key={t} className={`tab ${active === t ? 'on' : ''}`} onClick={() => setActive(t)}>
              {t === 'agent' && <span className="wdot running" />}{isDash(t) && <span className="tab-ic">▦</span>}{tabLabel(t)}
              {t !== 'overview' && <span className="tab-x" onClick={(e) => closeTab(t, e)}>✕</span>}
            </div>
          ))}
        </div>
        <div className="ph-tabbody">
          {active === 'overview' && (
            <div className="ph-overview">
              <div className="ph-card"><div className="ph-card-h"><span className="ph-card-t">Chains</span><span className="dim ph-card-sub">grouped · tag into epics</span><span className="ph-card-right"><button className="btn xs">＋ New</button></span></div><Chains onOpenWorkspace={onOpenWorkspace} /></div>
              <div className="ph-card"><div className="ph-card-h"><span className="ph-card-t">In process</span><span className="ph-card-right"><button className="btn xs" onClick={() => open('process')}>open ↗</button></span></div><InProcess onOpenWorkspace={onOpenWorkspace} /></div>
              <div className="ph-card"><div className="ph-card-h"><span className="ph-card-t">Reports & notes</span><span className="dim ph-card-sub">reflect → plan</span><span className="ph-card-right"><button className="btn xs" onClick={() => open('reports')}>open feed ↗</button></span></div><ReportsFeed /></div>
            </div>
          )}
          {active === 'agent' && <AgentChat />}
          {active === 'crons' && <ProjectCronsTriggers />}
          {isNote(active) && <NoteView noteId={active.slice(5)} />}
          {isEv(active) && <EvidenceViewer evidenceId={active.slice(3)} />}
          {isArtifact(active) && <ArtifactViewer name={active.slice(9)} />}
          {active === 'reports' && <div className="ph-scroll"><ReportsFeed /></div>}
          {active === 'process' && <div className="ph-scroll"><InProcess onOpenWorkspace={onOpenWorkspace} /></div>}
          {active === 'chains' && <div className="ph-scroll"><Chains onOpenWorkspace={onOpenWorkspace} /></div>}
          {active === 'config' && <div className="ph-scroll ph-pad"><div className="dim">Bundle config editor (stub) — name, base branch, scripts, secrets.</div></div>}
          {isDash(active) && (() => {
            const d = dashboards.find((x) => x.id === dashId(active));
            return d ? <DashboardCanvas panels={d.panels} setPanels={setDashPanels(d.id)} scopeLabel={d.source ? `${d.name} · ${d.source}` : d.name} addLabel="＋ Add panel" /> : null;
          })()}
        </div>
      </div>

      {/* right: chain→workspace locator + flat artifacts + favorites, then shipped queue */}
      <aside className="rrail-wrap">
        <ProjectArtifactsRail onOpen={open} favorites={favorites} toggleFav={toggleFav} />
        <div className="rsection changes">
          <div className="rsec-h"><span>▾</span> Recently shipped <span className="compTag"><span className="x">deletion check →</span> roll up</span></div>
          <div className="rsec-b">
            {recentlyShipped.map((s) => {
              const done = s.rolledUp || rolled[s.workspace];
              const rated = rating === s.workspace;
              return (
                <div key={s.workspace} className={`ph-q-row ${rated ? 'rating' : ''}`}>
                  <div className="ph-q-line">
                    <div className="ph-q-main">
                      <span className="ph-q-ws mono">{s.workspace}</span>
                      <span className="dim ph-q-meta">{s.chain} · {s.shipped} · dashboard “{s.dashboard.name}” ({s.dashboard.panels.length})</span>
                    </div>
                    {done
                      ? <span className="chip green">rolled up</span>
                      : !rated && <button className="btn xs" onClick={() => setRating(s.workspace)}>Check & roll up</button>}
                  </div>
                  {rated && !done && (
                    <div className="ph-rate">
                      <div className="ph-rate-h">Rate the artifacts you're rolling up <span className="dim">— feeds rated precedents</span></div>
                      {[{ k: `${s.workspace}:dash`, label: `dashboard · ${s.dashboard.name}` }, ...s.dashboard.panels.map((p) => ({ k: `${s.workspace}:${p.id}`, label: `panel · ${p.title}` }))].map((a) => (
                        <div key={a.k} className="ph-rate-row"><span className="ph-rate-label">{a.label}</span><Stars value={stars[a.k] ?? 0} onChange={(v) => setStars((m) => ({ ...m, [a.k]: v }))} /></div>
                      ))}
                      <div className="ph-rate-foot">
                        <button className="btn xs" onClick={() => setRating(null)}>Cancel</button>
                        <button className="btn primary xs" onClick={() => { rollUp(s.workspace, s.dashboard); setRating(null); }}>Roll up →</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
