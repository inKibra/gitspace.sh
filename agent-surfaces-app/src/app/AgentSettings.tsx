import { useState } from 'react';
import {
  OMP_PROVIDERS, OMP_MODELS, MODEL_ROLES, EFFORTS, MODEL_PARAMS, AGENT_TOOLS, AGENT_SKILLS,
  USAGE_SESSION, USAGE_MONTH, CONTEXT_BREAKDOWN, PINNED_FILES,
  SETTINGS_TABS, GENERAL_SETTINGS,
} from '../data/mock';
import type { OmpProvider, AgentTool, SettingItem, SettingTab } from '../data/mock';

const k = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`;

// ── Sign in to OMP (first-run + provider connections) ──
export function AccountPanel() {
  const [flow, setFlow] = useState<'idle' | 'pending' | 'connected'>('idle');
  const [providers, setProviders] = useState<OmpProvider[]>(OMP_PROVIDERS);
  const connect = (id: string) => setProviders((p) => p.map((x) => x.id === id ? { ...x, status: 'connected', via: 'oauth' } : x));
  return (
    <div className="set">
      <div className="set-acct">
        {flow === 'idle' && <>
          <div className="dim">First run — connect this machine to your OMP account.</div>
          <button className="btn primary" onClick={() => setFlow('pending')}>Continue with GitHub →</button>
          <div className="dim mono set-sm">device flow · opens omp.dev/activate</div>
        </>}
        {flow === 'pending' && <>
          <div className="dim">Enter this code at <span className="mono" style={{ color: 'var(--gs-text)' }}>omp.dev/activate</span></div>
          <div className="set-code mono">WDJB-2847</div>
          <div className="set-wait"><span className="wdot pending" /> waiting for authorization…</div>
          <button className="btn primary sm" onClick={() => setFlow('connected')}>I've authorized →</button>
        </>}
        {flow === 'connected' && <div className="set-ok"><span className="chip green">✓ signed in</span> bradleat@inkibra.com · plan: Pro</div>}
      </div>
      <div className="set-grp">Provider credentials</div>
      {providers.map((p) => (
        <div key={p.id} className="set-row">
          <span className={`set-dot ${p.status === 'connected' ? 'on' : ''}`} />
          <span className="set-row-name">{p.label}</span>
          {p.status === 'connected'
            ? <><span className="chip dim">{p.via}</span><button className="btn xs">Disconnect</button></>
            : <button className="btn xs" onClick={() => connect(p.id)}>Connect</button>}
        </div>
      ))}
      <button className="btn xs set-addkey">＋ Add API key</button>
    </div>
  );
}

// ── Model configuration (the SDK "model" settings tab) ──
const PARAM_OPTS: Record<string, string[]> = {
  temperature: ['default', '0', '0.3', '0.7', '1.0'], topP: ['default', '0.9', '0.95', '1.0'], topK: ['default', '40', '64'],
  serviceTier: ['none', 'auto', 'flex', 'priority'], fallbackPolicy: ['cooldown-expiry', 'manual', 'never'],
};
export function ModelPanel() {
  const [def, setDef] = useState('claude-opus-4-8');
  const [params, setParams] = useState<Record<string, string | number | boolean>>({ ...MODEL_PARAMS });
  const set = (key: string, v: string | number | boolean) => setParams((p) => ({ ...p, [key]: v }));
  const byProvider = OMP_PROVIDERS.map((p) => ({ p, models: OMP_MODELS.filter((m) => m.provider === p.id) })).filter((g) => g.models.length);
  return (
    <div className="set">
      <div className="set-grp">Model roles <span className="dim">— per-role model assignment</span></div>
      {MODEL_ROLES.map((r) => (
        <div key={r} className="set-row"><span className="set-row-name mono">{r}</span>
          <select className="set-select" defaultValue={r === 'default' ? def : ''}>
            <option value="">— inherit default —</option>
            {OMP_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
      ))}
      <div className="set-grp">Parameters</div>
      <div className="set-field"><span className="set-label">thinking level</span>
        <span className="seg">{EFFORTS.map((e) => <button key={e} className={`seg ${params.thinkingLevel === e ? 'on' : ''}`} onClick={() => set('thinkingLevel', e)}>{e}</button>)}</span>
      </div>
      {(['temperature', 'topP', 'topK', 'serviceTier', 'fallbackPolicy'] as const).map((key) => (
        <div key={key} className="set-field"><span className="set-label">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
          <select className="set-select" value={String(params[key])} onChange={(e) => set(key, e.target.value)}>
            {PARAM_OPTS[key].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      ))}
      <div className="set-field"><span className="set-label">retry attempts</span><input className="set-num mono" value={Number(params.retryAttempts)} onChange={(e) => set('retryAttempts', +e.target.value || 0)} /></div>
      <div className="set-row clickable" onClick={() => set('hideThinkingBlock', !params.hideThinkingBlock)}><span className={`set-check ${params.hideThinkingBlock ? 'on' : ''}`}>{params.hideThinkingBlock ? '☑' : '☐'}</span><span className="set-row-name">Hide thinking blocks</span></div>
      <div className="set-row clickable" onClick={() => set('repeatToolDescriptions', !params.repeatToolDescriptions)}><span className={`set-check ${params.repeatToolDescriptions ? 'on' : ''}`}>{params.repeatToolDescriptions ? '☑' : '☐'}</span><span className="set-row-name">Repeat tool descriptions</span></div>
      <div className="set-grp">Enabled models <span className="dim">— provider order + availability</span></div>
      {byProvider.map(({ p, models }) => (
        <div key={p.id}>
          <div className="set-sub">{p.label}{p.status !== 'connected' && <span className="dim"> · not connected</span>}</div>
          {models.map((m) => (
            <div key={m.id} className={`set-model ${def === m.id ? 'on' : ''} ${p.status !== 'connected' ? 'off' : ''}`} onClick={() => p.status === 'connected' && setDef(m.id)}>
              <span className="set-model-r">{def === m.id ? '◉' : '○'}</span>
              <span className="set-model-name">{m.label}{def === m.id && <span className="chip dim" style={{ marginLeft: 6 }}>default</span>}</span>
              <span className="dim mono set-model-meta">{k(m.ctx)} ctx · {k(m.maxOut)} out · ${m.costIn}/${m.costOut}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── General settings (the unified SETTINGS_SCHEMA, by tab) ──
function SettingControl({ s, value, onChange }: { s: SettingItem; value: string | number | boolean; onChange: (v: string | number | boolean) => void }) {
  if (s.type === 'toggle') return <button className={`set-toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span className="set-toggle-knob" /></button>;
  if (s.type === 'enum') return <select className="set-select" value={String(value)} onChange={(e) => onChange(e.target.value)}>{s.options!.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
  if (s.type === 'number') return <input className="set-num mono" value={Number(value)} onChange={(e) => onChange(+e.target.value || 0)} />;
  return <input className="set-text mono" value={String(value)} onChange={(e) => onChange(e.target.value)} />;
}
export function GeneralSettings() {
  const [tab, setTab] = useState<SettingTab>('appearance');
  const [vals, setVals] = useState<Record<string, string | number | boolean>>(() => Object.fromEntries(GENERAL_SETTINGS.map((s) => [s.key, s.value])));
  const rows = GENERAL_SETTINGS.filter((s) => s.tab === tab);
  return (
    <div className="set gset">
      <div className="gset-tabs">
        {SETTINGS_TABS.map((t) => <button key={t} className={`gset-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div className="gset-body">
        {rows.map((s) => (
          <div key={s.key} className="gset-row">
            <div className="gset-meta"><span className="gset-label">{s.label}</span>{s.desc && <span className="dim gset-desc">{s.desc}</span>}<span className="gset-key mono dim">{s.key}</span></div>
            <SettingControl s={s} value={vals[s.key]} onChange={(v) => setVals((m) => ({ ...m, [s.key]: v }))} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Agent configuration (prompt · tools · permissions · skills · subagents) ──
const NEXT_APPROVAL: Record<string, AgentTool['approval']> = { allow: 'prompt', prompt: 'deny', deny: 'allow' };
const APPROVAL_TONE: Record<string, string> = { allow: 'green', prompt: 'amber', deny: 'red' };
const TIER_TONE: Record<string, string> = { read: 'blue', write: 'amber', exec: 'red' };
export function AgentPanel() {
  const [mode, setMode] = useState('write');
  const [tools, setTools] = useState<AgentTool[]>(AGENT_TOOLS);
  const [skills, setSkills] = useState<Set<string>>(new Set(AGENT_SKILLS));
  const cycle = (name: string) => setTools((t) => t.map((x) => x.name === name ? { ...x, approval: NEXT_APPROVAL[x.approval] } : x));
  const toggleSkill = (s: string) => setSkills((set) => { const n = new Set(set); n.has(s) ? n.delete(s) : n.add(s); return n; });
  return (
    <div className="set">
      <div className="set-grp">System prompt <span className="dim">— appended to the default</span></div>
      <textarea className="set-ta" defaultValue={"Prefer the workspace's goal rubric as the source of truth. Never accept “tests are green” as proof of deletion."} />
      <div className="set-grp">Approval mode</div>
      <span className="seg full">{['always-ask', 'write', 'yolo'].map((m) => <button key={m} className={`seg ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>{m}</button>)}</span>
      <div className="set-grp">Tools <span className="dim">— tier · approval</span></div>
      {tools.map((t) => (
        <div key={t.name} className="set-row">
          <span className="set-row-name mono">{t.name}</span>
          <span className={`chip ${TIER_TONE[t.tier]}`}>{t.tier}</span>
          <button className={`chip ${APPROVAL_TONE[t.approval]} set-cyc`} onClick={() => cycle(t.name)}>{t.approval}</button>
        </div>
      ))}
      <div className="set-grp">Skills <span className="dim">· {skills.size}/{AGENT_SKILLS.length}</span></div>
      {AGENT_SKILLS.map((s) => (
        <div key={s} className="set-row clickable" onClick={() => toggleSkill(s)}>
          <span className={`set-check ${skills.has(s) ? 'on' : ''}`}>{skills.has(s) ? '☑' : '☐'}</span>
          <span className="set-row-name mono">{s}</span>
        </div>
      ))}
      <div className="set-grp">Subagents</div>
      <div className="set-field"><span className="set-label">spawns</span><input className="set-text mono" defaultValue="*" /><span className="dim">allow all</span></div>
    </div>
  );
}

// ── Usage & limits ──
function Bar({ value, max, tone = 'green' }: { value: number; max: number; tone?: string }) {
  return <span className="set-bar"><span className={`set-bar-fill ${tone}`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} /></span>;
}
export function UsagePanel() {
  const s = USAGE_SESSION;
  const total = s.input + s.output + s.cacheRead + s.cacheWrite;
  return (
    <div className="set">
      <div className="set-grp">This session</div>
      <div className="set-stat"><span className="set-stat-v mono">${s.cost.toFixed(2)}</span><span className="dim">· {k(total)} tokens</span></div>
      {[['input', s.input], ['output', s.output], ['cache read', s.cacheRead], ['cache write', s.cacheWrite]].map(([l, v]) => (
        <div key={l as string} className="set-row"><span className="set-row-name">{l}</span><Bar value={v as number} max={total} tone="blue" /><span className="dim mono set-tok">{k(v as number)}</span></div>
      ))}
      <div className="set-grp">This month</div>
      <div className="set-stat"><span className="set-stat-v mono">${USAGE_MONTH.cost.toFixed(2)}</span><span className="dim">· {k(USAGE_MONTH.tokens)} / {k(USAGE_MONTH.limit)} tokens</span></div>
      <div className="set-row"><Bar value={USAGE_MONTH.tokens} max={USAGE_MONTH.limit} tone="green" /><span className="dim mono set-tok">{Math.round((USAGE_MONTH.tokens / USAGE_MONTH.limit) * 100)}%</span></div>
    </div>
  );
}

// ── Context usage ──
export function ContextPanel() {
  const used = CONTEXT_BREAKDOWN.reduce((a, s) => a + s.tokens, 0);
  const window = 200000;
  return (
    <div className="set">
      <div className="set-grp">Context window</div>
      <div className="set-stat"><span className="set-stat-v mono">{k(used)} / {k(window)}</span><span className="dim">· {Math.round((used / window) * 100)}% · compaction at 90%</span></div>
      <div className="set-ctxbar">
        {CONTEXT_BREAKDOWN.map((s) => <span key={s.label} className={`set-ctx-seg ${s.tone}`} style={{ width: `${(s.tokens / window) * 100}%` }} title={`${s.label}: ${k(s.tokens)}`} />)}
        <span className="set-ctx-rest" />
      </div>
      {CONTEXT_BREAKDOWN.map((s) => (
        <div key={s.label} className="set-row"><span className={`set-dot ${s.tone} on`} /><span className="set-row-name">{s.label}</span><span className="dim mono set-tok">{k(s.tokens)}</span></div>
      ))}
      <div className="set-grp">Pinned files</div>
      {PINNED_FILES.map((f) => <div key={f} className="set-row"><span className="set-row-name mono">📌 {f}</span><button className="btn xs">unpin</button></div>)}
      <div className="set-actions"><button className="btn sm">Compact now</button></div>
    </div>
  );
}
