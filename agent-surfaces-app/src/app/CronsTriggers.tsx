import { useState } from 'react';
import { triggers, SKILLS, projectTriggerGroups } from '../data/mock';
import type { Stage, Trigger } from '../data/mock';
import { Md } from '../Md';

const KIND_TONE: Record<string, string> = { cron: 'blue', event: 'violet', manual: 'dim' };
const STATUS_TONE: Record<string, string> = { ok: 'green', pending: 'amber', failed: 'red', idle: 'dim' };
const HIST_TONE: Record<string, string> = { ok: 'var(--gs-success)', fail: 'var(--gs-danger)', pending: 'var(--gs-warning)' };

function Spark({ history }: { history: string[] }) {
  return <span className="trig-spark">{history.map((h, i) => <span key={i} className="trig-bar-dot" style={{ background: HIST_TONE[h] }} />)}</span>;
}

function TriggerCard({ t, live }: { t: Trigger; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [showSkill, setShowSkill] = useState(false);
  const hasSideFx = t.sideEffects.length > 0;
  const skill = t.runs.type === 'skill' ? SKILLS[t.runs.ref] : undefined;
  return (
    <div className={`trig ${hasSideFx ? 'sidefx' : ''}`}>
      <div className="trig-h">
        <span className="trig-name mono">{t.name}</span>
        <span className={`chip ${KIND_TONE[t.kind]}`}>{t.kind}</span>
        <span className="dim mono trig-when">{t.when}</span>
        <span className={`ma-scope ${t.scope}`}>{t.scope}</span>
        <span className="trig-spacer" />
        <span className={`chip ${live ? STATUS_TONE[t.status] : 'dim'}`}>{live ? t.status : 'armed'}</span>
        <button className="btn xs">⟳ Run now</button>
        <button className="btn xs" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Edit'}</button>
      </div>

      <div className="trig-does">{t.does}</div>

      <div className="trig-flow">
        <span className="trig-k">runs</span><span className="mono trig-runs">{t.runs.type}: {t.runs.ref}</span>
        <span className="trig-arrow">·</span>
        <span className="trig-k">reads</span><span className="mono dim">{t.reads.join(', ')}</span>
        <span className="trig-arrow">→</span>
        <span className="trig-k">writes</span><span className="mono">{t.writes.join(', ')}</span>
      </div>

      <div className="trig-scope">
        <span className="trig-k">capability</span>
        {hasSideFx
          ? t.sideEffects.map((se) => <span key={se.grant} className="chip amber">can {se.grant}{se.needsApproval ? ' · approval' : ''}</span>)
          : <span className="chip green">data-only · no side-effects</span>}
        <span className="trig-feeds dim">feeds ▸ {t.feeds.join(', ')}</span>
        <span className="trig-spacer" />
        <span className="dim mono trig-meta">{t.last}{t.next ? ` · next ${t.next}` : ''}{t.cost ? ` · ${t.cost}` : ''}</span>
        {t.history.length > 0 && <Spark history={t.history} />}
      </div>

      {open && (
        <div className="trig-editor">
          <div className="trig-ek">runs · {t.runs.type}: {t.runs.ref}</div>
          {skill && (
            <div className="trig-skill">
              <button className="trig-skill-h" onClick={() => setShowSkill((s) => !s)}>
                <span className={`caret ${showSkill ? 'open' : ''}`}>▶</span>
                skill <span className="mono">{skill.name}</span> <span className="dim">— {skill.summary}</span>
              </button>
              {showSkill && <div className="trig-skill-body"><Md>{skill.body}</Md></div>}
            </div>
          )}
          {t.runs.prompt && (<><div className="trig-ek">prompt <span className="dim">— per-trigger instruction</span></div><textarea className="trig-prompt" defaultValue={t.runs.prompt} /></>)}
          <div className="trig-ek">capability scope — what this trigger may touch</div>
          <div className="trig-perm"><span className="dim trig-perm-l">may write</span>{t.writes.map((w) => <span key={w} className="chip dim">{w}</span>)}</div>
          <div className="trig-perm">
            <span className="dim trig-perm-l">side-effects</span>
            {hasSideFx
              ? t.sideEffects.map((se) => (
                <label key={se.grant} className="trig-grant"><input type="checkbox" defaultChecked /> {se.grant}
                  <span className="trig-appr"><input type="checkbox" defaultChecked={se.needsApproval} /> approval before live</span>
                </label>))
              : <span className="dim">none — writes data artifacts only</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function CronsTriggers({ stage }: { stage: Stage }) {
  const live = stage === 'ship';
  return (
    <div className="trigsurface">
      <div className="trig-bar">
        <span className="kicker">Crons &amp; triggers</span>
        <span className={`chip ${live ? 'green' : 'dim'}`}>{live ? '● live · armed in ship' : 'design mode · runs once shipped'}</span>
        <span className="trig-spacer" />
        <button className="btn sm">＋ New trigger</button>
      </div>
      <div className="trig-list">
        {triggers.map((t) => <TriggerCard key={t.id} t={t} live={live} />)}
      </div>
    </div>
  );
}

// project view: triggers grouped by the workspace they rolled up from
export function ProjectCronsTriggers() {
  const byId = new Map(triggers.map((t) => [t.id, t]));
  return (
    <div className="trigsurface">
      <div className="trig-bar">
        <span className="kicker">Crons &amp; triggers</span>
        <span className="dim" style={{ fontSize: 11 }}>across the project · grouped by originating workspace</span>
        <span className="trig-spacer" />
        <button className="btn sm">＋ New trigger</button>
      </div>
      <div className="trig-list">
        {projectTriggerGroups.map((g) => (
          <div key={g.workspace} className="trig-group">
            <div className="trig-group-h"><span className="mono">{g.workspace}</span><span className="dim"> · {g.triggerIds.length} trigger{g.triggerIds.length > 1 ? 's' : ''}</span></div>
            {g.triggerIds.map((id) => { const t = byId.get(id); return t ? <TriggerCard key={id} t={t} live /> : null; })}
          </div>
        ))}
      </div>
    </div>
  );
}
