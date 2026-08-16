import { useState } from 'react';
import type { Stage, Workspace, Dashboard, ShipPanel } from '../data/mock';
import { BlockView } from '../blocks';
import { PaneActionsContext } from '../blocks/pane-actions';
import { EVIDENCE, eventLog, notesList, reportItems, workflowSpec, workspaceDashboards } from '../data/mock';
import type { ReportItem } from '../data/mock';
import { Sidebar } from './Sidebar';
import { RightRail } from './RightRail';
import { AgentChat } from './AgentChat';
import { GoalDoc } from './GoalDoc';
import { ReviewRubric } from './ReviewRubric';
import { ReportViewer } from './ReportViewer';
import { ArtifactViewer } from './ArtifactViewer';
import { ReviewStage } from './stages/ReviewStage';
import { DashboardCanvas } from './DashboardCanvas';
import { CronsTriggers } from './CronsTriggers';
import { ServicesView } from './ServicesView';
import { TerminalsView } from './TerminalsView';
import { NoteView } from './NoteView';
import { EvidenceViewer } from './EvidenceViewer';
import { Pane as PaneBox } from './stages/Pane';

export type Pane = 'agent' | 'goal' | 'workflow' | 'review' | 'rubric' | 'crons' | 'terminals' | 'services' | 'events' | 'config' | 'file' | 'report' | 'artifact';

const PANE_LABEL: Record<Pane, string> = {
  agent: 'agent · main', goal: '◇ Goal', workflow: '⟜ Workflow', review: '⛓ Change Guide', rubric: '☰ Review rubric',
  crons: '◷ Crons & triggers', terminals: '⌗ Terminals', services: '◴ Services', events: '⚑ Event logs', config: '⚙ Bundle config', file: '▤ File', report: '⚑ Report', artifact: '◇ Artifact',
};
const isDash = (t: string) => t.startsWith('dash:');
const dashId = (t: string) => t.slice(5);
const isNote = (t: string) => t.startsWith('note:');
const isEv = (t: string) => t.startsWith('ev:');
let dseq = 900;

function WorkflowPane() {
  return (
    <div style={{ height: '100%', padding: 1, background: 'var(--gs-gap)' }}>
      <PaneBox title="Workflow" sub="phased dataflow · gated loops · gates · artifacts per phase" right={<button className="btn sm">Save workflow</button>}>
        <BlockView block={workflowSpec} />
      </PaneBox>
    </div>
  );
}

function FilePane({ name }: { name: string }) {
  return (
    <div style={{ height: '100%', padding: 1, background: 'var(--gs-gap)' }}>
      <PaneBox title={name} sub="via @pierre/diffs · FileDiff">
        <div className="callout">Repo file viewer — clicking a file in the <b>Repo</b> Explorer opens it here as a dock pane (Pierre <code>FileDiff</code> for changed files, single-side for unchanged).</div>
      </PaneBox>
    </div>
  );
}

function EventsPane() {
  return <div className="evpane">{eventLog.map((e, i) => (
    <div key={i} className={`evrow ${e.tone}`}><span className="tm tnum">{e.time}</span><span>{e.text}</span></div>
  ))}</div>;
}

export function Shell({ ws, onSwitchWorkspace }: { ws: Workspace; onSwitchWorkspace?: (id: string) => void }) {
  const [stage, setStage] = useState<Stage>(ws.stage);
  const [tabs, setTabs] = useState<string[]>(['agent', 'goal', 'workflow', 'review']);
  const [active, setActive] = useState<string>('agent');
  const [file, setFile] = useState('app.json');
  const [report, setReport] = useState<ReportItem | null>(null);
  const [artifact, setArtifact] = useState('');
  const [dashboards, setDashboards] = useState<Dashboard[]>(workspaceDashboards);
  const [termFocus, setTermFocus] = useState<string | undefined>();

  const open = (t: string) => { setTabs((s) => (s.includes(t) ? s : [...s, t])); setActive(t); };
  const openFile = (name: string) => { setFile(name); open('file'); };
  const setDashPanels = (id: string) => (fn: (p: ShipPanel[]) => ShipPanel[]) =>
    setDashboards((ds) => ds.map((d) => d.id === id ? { ...d, panels: fn(d.panels) } : d));
  const newDash = () => {
    const id = `wd-new-${dseq++}`;
    setDashboards((ds) => [...ds, { id, name: 'New dashboard', scope: 'workspace', panels: [] }]);
    open(`dash:${id}`);
  };
  const openTarget = (target: string) => {
    if (target === 'dash:new') { newDash(); return; }
    if (target.startsWith('term:')) { setTermFocus(target.slice(5)); open('terminals'); return; }
    if (target.startsWith('report:')) { setReport(reportItems[Number(target.slice(7))] ?? null); open('report'); return; }
    if (target.startsWith('artifact:')) { setArtifact(target.slice(9)); open('artifact'); return; }
    if (target.startsWith('file:')) { openFile(target.slice(5)); return; }
    open(target);
  };
  const closeTab = (t: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs((s) => { const n = s.filter((x) => x !== t); if (active === t) setActive(n[n.length - 1] ?? 'agent'); return n; });
  };
  const tabLabel = (t: string) => t === 'file' ? `▤ ${file}` : t === 'artifact' ? `◇ ${artifact || 'Artifact'}`
    : isDash(t) ? (dashboards.find((d) => d.id === dashId(t))?.name ?? 'Dashboard')
    : isNote(t) ? `✎ ${t === 'note:new' ? 'New note' : (notesList[Number(t.slice(5))]?.title ?? 'Note')}`
    : isEv(t) ? `▸ ${EVIDENCE[t.slice(3)]?.name ?? 'Evidence'}`
    : PANE_LABEL[t as Pane];

  return (
    <PaneActionsContext.Provider value={{ open: openTarget }}>
      <div className="shell">
        <Sidebar ws={ws} stage={stage} onSwitchStage={setStage} active={active} onOpen={openTarget} onSwitchWorkspace={onSwitchWorkspace} dashboards={dashboards} />
        <div className="center">
          <div className="tabstrip">
            {tabs.map((t) => (
              <div key={t} className={`tab ${active === t ? 'on' : ''}`} onClick={() => setActive(t)}>
                {t === 'agent' && <span className="wdot running" />}{isDash(t) && <span className="tab-ic">▦</span>}{tabLabel(t)}
                {t !== 'agent' && <span className="tab-x" onClick={(e) => closeTab(t, e)}>✕</span>}
              </div>
            ))}
            <div className="tools"><button className="btn sm">⇆ Split</button></div>
          </div>
          <div className="dockbody">
            {active === 'agent' && <AgentChat />}
            {active === 'goal' && <GoalDoc onOpen={openTarget} />}
            {active === 'workflow' && <WorkflowPane />}
            {active === 'review' && <ReviewStage ws={ws} />}
            {active === 'rubric' && <ReviewRubric />}
            {active === 'crons' && <CronsTriggers stage={stage} />}
            {active === 'terminals' && <TerminalsView focus={termFocus} />}
            {active === 'services' && <ServicesView />}
            {isNote(active) && <NoteView noteId={active.slice(5)} />}
            {isEv(active) && <EvidenceViewer evidenceId={active.slice(3)} />}
            {active === 'events' && <EventsPane />}
            {active === 'config' && <div className="ph-scroll ph-pad"><div className="dim">Bundle config editor (stub) — name, base branch, scripts, secrets, processes.</div></div>}
            {active === 'file' && <FilePane name={file} />}
            {active === 'report' && <ReportViewer report={report} />}
            {active === 'artifact' && <ArtifactViewer name={artifact} />}
            {isDash(active) && (() => {
              const d = dashboards.find((x) => x.id === dashId(active));
              return d ? <DashboardCanvas panels={d.panels} setPanels={setDashPanels(d.id)} scopeLabel={d.source ? `${d.name} · ${d.source}` : d.name} addLabel="＋ Add panel" /> : null;
            })()}
          </div>
        </div>
        <RightRail onOpen={openTarget} onFile={openFile} stage={stage} />
      </div>
    </PaneActionsContext.Provider>
  );
}
