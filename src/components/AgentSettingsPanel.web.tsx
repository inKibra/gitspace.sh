/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type {
  AgentAuthProvider,
  AgentControlInfo,
  AgentDefinitionInfo,
  AgentOAuthEvent,
  AgentSessionUsageReport,
  AgentSettingSchemaItem,
  AgentToolInfo,
} from '../agents/agent-runtime-types.js';

type ActiveOAuth = (AgentOAuthEvent & { provider: string }) | null;
type Tab = 'models' | 'agent' | 'agents' | 'settings' | 'usage' | 'context' | 'providers';
const TABS: Tab[] = ['models', 'agent', 'agents', 'settings', 'usage', 'context', 'providers'];
const APPROVAL_CYCLE = ['default', 'allow', 'prompt', 'deny'];
const TIER_COLOR: Record<string, string> = { read: 'var(--gs-info)', write: 'var(--gs-warning)', exec: 'var(--gs-danger)' };

const k = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

export function AgentSettingsPanel({
  control,
  schema,
  tools,
  agents = [],
  providers,
  loading,
  oauth,
  onSetModel,
  onSetSetting,
  onSetApiKey,
  onOAuthLogin,
  onOAuthRespond,
  onRemoveAccount,
  onCheckUsage,
  onLoadSessionUsage,
  onCompact,
  onClose,
}: {
  control?: AgentControlInfo;
  schema: AgentSettingSchemaItem[];
  tools: AgentToolInfo[];
  agents?: AgentDefinitionInfo[];
  providers: AgentAuthProvider[];
  loading: boolean;
  oauth: ActiveOAuth;
  onSetModel: (provider: string, modelId: string) => void;
  onSetSetting: (path: string, value: string | number | boolean | string[]) => Promise<void>;
  onSetApiKey: (provider: string, key: string) => Promise<void>;
  onOAuthLogin: (provider: string) => void;
  onOAuthRespond: (value: string) => void;
  onRemoveAccount: (provider: string, credentialId: number) => Promise<void>;
  onCheckUsage: (provider: string) => Promise<AccountUsage[]>;
  /** Per-session attribution for the Usage tab (reads the transcript). */
  onLoadSessionUsage?: () => Promise<AgentSessionUsageReport | null>;
  onCompact: () => void;
  onClose: () => void;
}): ReactElement {
  const [tab, setTab] = useState<Tab>('models');
  const [error, setError] = useState<string | null>(null);

  const set = (path: string, value: string | number | boolean | string[]) => {
    setError(null);
    void onSetSetting(path, value).catch((e) => setError(e instanceof Error ? e.message : 'Failed to set'));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative z-10 flex h-[80vh] w-[560px] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] text-[12px] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--gs-border)] px-4 py-2.5 text-[13px]">
          <span className="font-[family-name:var(--gs-font)] text-[var(--gs-text)]">Agent settings</span>
          <button type="button" onClick={onClose} className="text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">✕</button>
        </div>

        <div className="flex gap-1 border-b border-[var(--gs-border)] px-2 py-1">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-2 py-1 capitalize ${tab === t ? 'border-b-2 border-[var(--gs-accent)] text-[var(--gs-accent)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {tab === 'models' && <ModelsTab control={control} onSetModel={onSetModel} onSet={set} />}
          {tab === 'agent' && <AgentTab control={control} tools={tools} loading={loading} onSet={set} />}
          {tab === 'agents' && <AgentsTab control={control} agents={agents} loading={loading} onSet={set} />}
          {tab === 'settings' && <SettingsTab schema={schema} loading={loading} onSet={set} />}
          {tab === 'usage' && <UsageTab control={control} agents={agents} onLoadSessionUsage={onLoadSessionUsage} />}
          {tab === 'context' && <ContextTab control={control} onCompact={onCompact} />}
          {tab === 'providers' && (
            <ProvidersTab providers={providers} loading={loading} oauth={oauth} onOAuthLogin={onOAuthLogin} onOAuthRespond={onOAuthRespond} onSetApiKey={onSetApiKey} onRemoveAccount={onRemoveAccount} onCheckUsage={onCheckUsage} />
          )}
          {error && <div className="mt-2 text-[var(--gs-danger)]">⚠ {error}</div>}
        </div>
      </div>
    </div>
  );
}

function Grp({ children }: { children: React.ReactNode }): ReactElement {
  return <div className="mb-1 mt-3 text-[10px] uppercase tracking-wide text-[var(--gs-text-ghost)] first:mt-0">{children}</div>;
}

function ModelsTab({ control, onSetModel, onSet }: { control?: AgentControlInfo; onSetModel: (p: string, id: string) => void; onSet: (path: string, value: string | number | boolean | string[]) => void }): ReactElement {
  const models = control?.models ?? [];
  const current = control?.currentModel ?? null;
  const roles = control?.roleCatalog ?? [];
  const thinkingLevels = control?.thinkingLevels ?? [];
  // Quick-cycle membership: the `cycleOrder` setting (order preserved by the
  // control seam). Toggling rewrites the array — append on add, remove on
  // remove — but never empties it (the cycle needs at least one role).
  const cycleOrder = control?.cycleOrder;
  const toggleCycle = (role: string) => {
    if (!cycleOrder) return;
    const next = cycleOrder.includes(role) ? cycleOrder.filter((r) => r !== role) : [...cycleOrder, role];
    if (next.length === 0) return;
    onSet('cycleOrder', next);
  };
  // A role selector is `provider/id[:thinking]`. Split the trailing thinking
  // suffix (only when it's a known level) and recombine on change.
  const splitRole = (val: string | null): { base: string; think: string } => {
    if (!val) return { base: '', think: '' };
    const i = val.lastIndexOf(':');
    if (i > 0 && thinkingLevels.includes(val.slice(i + 1))) return { base: val.slice(0, i), think: val.slice(i + 1) };
    return { base: val, think: '' };
  };
  const combine = (base: string, think: string): string => (base && think ? `${base}:${think}` : base);
  return (
    <div>
      {roles.length > 0 && (
        <>
          <Grp>Model roles — ◉ in quick cycle · model + thinking per role</Grp>
          {roles.map((r) => {
            const { base, think } = splitRole(r.model);
            // Keep the assigned base selectable even if its provider isn't authed.
            const inList = base ? models.some((m) => `${m.provider}/${m.id}` === base) : true;
            const member = !!cycleOrder?.includes(r.role);
            const lastMember = member && (cycleOrder?.length ?? 0) <= 1;
            return (
              <div key={r.role} className="flex items-center gap-2 px-1 py-1">
                <button
                  type="button"
                  disabled={!cycleOrder || lastMember}
                  onClick={() => toggleCycle(r.role)}
                  title={lastMember
                    ? 'in quick cycle — the cycle needs at least one role'
                    : member
                      ? 'in quick cycle — click to remove'
                      : 'not in quick cycle — click to add'}
                  className={member
                    ? 'text-[var(--gs-success)]'
                    : 'text-[var(--gs-text-ghost)] hover:text-[var(--gs-text-dim)] disabled:hover:text-[var(--gs-text-ghost)]'}
                >
                  {member ? '◉' : '○'}
                </button>
                <span className="w-14 shrink-0 truncate font-[family-name:var(--gs-font)]" title={r.description ?? r.name}>{r.name}</span>
                <select
                  value={base}
                  onChange={(e) => onSet(`modelRoles.${r.role}`, combine(e.target.value, think))}
                  className="min-w-0 flex-1 truncate border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1 py-0.5 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]"
                >
                  <option value="">— default —</option>
                  {base && !inList && <option value={base}>{base}</option>}
                  {models.map((m) => {
                    const ref = `${m.provider}/${m.id}`;
                    return <option key={ref} value={ref}>{ref}</option>;
                  })}
                </select>
                <select
                  value={think}
                  disabled={!base}
                  title={base ? 'Thinking level for this role' : 'Pick a model first'}
                  onChange={(e) => onSet(`modelRoles.${r.role}`, combine(base, e.target.value))}
                  className="w-20 shrink-0 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1 py-0.5 text-[var(--gs-text)] disabled:opacity-40"
                >
                  <option value="">think</option>
                  {thinkingLevels.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            );
          })}
        </>
      )}
      <Grp>Model — click to switch</Grp>
      {models.length === 0 ? (
        <div className="text-[var(--gs-text-dim)]">No models (sign in to a provider).</div>
      ) : (
        models.map((m) => {
          const ref = `${m.provider}/${m.id}`;
          const active = ref === current;
          return (
            <button
              key={ref}
              type="button"
              onClick={() => onSetModel(m.provider, m.id)}
              className={`flex w-full items-center gap-2 px-1 py-1 text-left hover:bg-[var(--gs-border)] ${active ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text)]'}`}
            >
              <span>{active ? '◉' : '○'}</span>
              <span className="font-[family-name:var(--gs-font-mono)] truncate">{ref}</span>
              {m.contextWindow ? <span className="ml-auto text-[var(--gs-text-dim)]">{k(m.contextWindow)} ctx</span> : null}
            </button>
          );
        })
      )}
    </div>
  );
}

/** Mechanics of an unset role — surfaced as a tooltip wherever we display the
 *  "follows Default" shorthand (SDK model-resolver shouldInheritDefaultBeforePriority:
 *  smol/slow/designer inherit the Default role first, plan collapses to slow,
 *  advisor/tiny alias the slow/smol chains). */
const UNSET_ROLE_MECHANICS = 'unset: inherits Default, then built-in chain';

function AgentsTab({ control, agents, loading, onSet }: { control?: AgentControlInfo; agents: AgentDefinitionInfo[]; loading: boolean; onSet: (p: string, v: string | number | boolean) => void }): ReactElement {
  const roles = control?.roleCatalog ?? [];
  // Effective model for the Default role: prefer the resolved cycle entry
  // (control.roles), then the catalog assignment.
  const defaultModel = (control?.roles ?? []).find((r) => r.role === 'default')?.model
    ?? roles.find((r) => r.role === 'default')?.model
    ?? null;
  // Translate `pi/<role>` refs into the Model roles vocabulary (Models tab).
  // Display-only: values written to settings stay `pi/<role>`; the raw ref
  // survives only in title attrs for debugging. Non-role refs pass through.
  const roleFor = (ref: string) => roles.find((x) => `pi/${x.role}` === ref);
  const CURRENT_MODEL = "Current model (follows this session's model)";
  const nameForRef = (ref: string): string => {
    const r = roleFor(ref);
    return r ? (r.role === 'task' ? 'Current model' : r.name) : ref;
  };
  const labelForModel = (spec: string): string => {
    // Multi-pattern pins ("pi/plan, pi/slow") → "Architect, Thinking".
    const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts.map(nameForRef).join(', ');
    const r = roleFor(spec);
    if (!r) return spec;
    // A CONFIGURED role (incl. Subtask) shows its assigned model — always keep the
    // role name so it's findable in the Agents dropdown. The old code short-
    // circuited 'task' to "Current model" here, ignoring what you set for Subtask
    // in the Models tab and dropping the name entirely.
    if (r.model) return `${r.name} — ${r.model}`;
    // Subtask is special ONLY when UNSET: a subagent then follows the session's
    // current model (not the Default-role priority chain the other roles use).
    if (r.role === 'task') return `${r.name} — ${CURRENT_MODEL}`;
    // Unset role: the effective behavior is inherit-the-Default-role first,
    // so show it as following Default rather than the opaque priority chain.
    if (r.role !== 'default' && defaultModel) return `${r.name} — Default — ${defaultModel}`;
    return `${r.name} — auto (priority chain)`;
  };
  const optionTitle = (ref: string): string => {
    const r = roleFor(ref);
    return r && !r.model && r.role !== 'task' ? `${ref}\n${UNSET_ROLE_MECHANICS}` : ref;
  };
  return (
    <div>
      <Grp>Agents — model role per subagent · role names match the Models tab</Grp>
      {agents.length === 0 ? (
        <div className="text-[var(--gs-text-dim)]">{loading ? 'Loading…' : 'No agents discovered.'}</div>
      ) : (
        agents.map((a) => {
          // The select holds the OVERRIDE (task.agentModelOverrides.<name>);
          // '' = no override → the definition's own model (or session default).
          // Options are ROLES only (stored as pi/<role>) — no concrete
          // provider/id pins; a pre-existing non-role override stays visible
          // (and clearable) but is not offered as a new choice.
          const value = a.overrideModel ?? '';
          const roleRefs = roles.map((r) => `pi/${r.role}`);
          const inList = !value || roleRefs.includes(value);
          return (
            <div key={`${a.source}:${a.name}`} className="flex items-center gap-2 px-1 py-1">
              <span
                className="w-24 shrink-0 truncate font-[family-name:var(--gs-font)] text-[var(--gs-text)]"
                title={`${a.description}${a.filePath ? `\n${a.filePath}` : ''}`}
              >
                {a.name}
              </span>
              <span className="w-14 shrink-0 text-[10px] uppercase text-[var(--gs-text-ghost)]">{a.source}</span>
              <select
                value={value}
                onChange={(e) => onSet(`task.agentModelOverrides.${a.name}`, e.target.value)}
                title={[value ? `Override: ${value}` : null, a.resolvedModel ? `Resolves to: ${a.resolvedModel}` : null].filter(Boolean).join('\n') || undefined}
                className="min-w-0 flex-1 truncate border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1 py-0.5 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]"
              >
                <option value="" title={a.model ?? undefined}>{`— ${a.model ? labelForModel(a.model) : CURRENT_MODEL} —`}</option>
                {value && !inList && <option value={value} title={value}>{labelForModel(value)}</option>}
                {roleRefs.map((ref) => <option key={ref} value={ref} title={optionTitle(ref)}>{labelForModel(ref)}</option>)}
              </select>
            </div>
          );
        })
      )}
    </div>
  );
}

function AgentTab({ control, tools, loading, onSet }: { control?: AgentControlInfo; tools: AgentToolInfo[]; loading: boolean; onSet: (p: string, v: string | number | boolean) => void }): ReactElement {
  return (
    <div>
      <Grp>Approval mode</Grp>
      <div className="flex gap-1">
        {(control?.approvalModes ?? []).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onSet('tools.approvalMode', m)}
            className={`flex-1 border px-2 py-1 ${control?.approvalMode === m ? 'border-[var(--gs-accent)] text-[var(--gs-accent)]' : 'border-[var(--gs-border)] text-[var(--gs-text-dim)]'}`}
          >
            {m}
          </button>
        ))}
      </div>
      <Grp>Tools — tier · per-tool approval</Grp>
      {tools.length === 0 ? (
        <div className="text-[var(--gs-text-dim)]">{loading ? 'Loading…' : 'No tools (start the agent first).'}</div>
      ) : (
        tools.map((t) => (
          <div key={t.name} className="flex items-center gap-2 py-1">
            <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{t.name}</span>
            <span style={{ color: TIER_COLOR[t.tier] ?? 'var(--gs-text-dim)' }}>{t.tier}</span>
            <button
              type="button"
              onClick={() => onSet(`tools.approval.${t.name}`, APPROVAL_CYCLE[(APPROVAL_CYCLE.indexOf(t.approval) + 1) % APPROVAL_CYCLE.length])}
              className="ml-auto border border-[var(--gs-border)] px-2 py-0.5 text-[var(--gs-text)] hover:border-[var(--gs-accent)]"
            >
              {t.approval}
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function SettingsTab({ schema, loading, onSet }: { schema: AgentSettingSchemaItem[]; loading: boolean; onSet: (p: string, v: string | number | boolean) => void }): ReactElement {
  const editable = useMemo(() => schema.filter((s) => s.kind === 'boolean' || s.kind === 'enum' || s.kind === 'number' || s.kind === 'string'), [schema]);
  const tabs = useMemo(() => [...new Set(editable.map((s) => s.tab))].sort(), [editable]);
  const [sub, setSub] = useState<string>('');
  const activeSub = sub || tabs[0] || '';
  const rows = editable.filter((s) => s.tab === activeSub);
  if (loading && schema.length === 0) return <div className="text-[var(--gs-text-dim)]">Loading settings…</div>;
  if (schema.length === 0) return <div className="text-[var(--gs-text-dim)]">Unavailable (start the agent first).</div>;
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t} type="button" onClick={() => setSub(t)} className={`px-2 py-0.5 capitalize ${activeSub === t ? 'bg-[var(--gs-border)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}>{t}</button>
        ))}
      </div>
      {rows.map((s) => (
        <div key={s.path} className="flex items-start gap-2 border-b border-[var(--gs-border-muted)] py-1.5 last:border-b-0">
          <div className="min-w-0 flex-1">
            <div className="text-[var(--gs-text)]">{s.label}</div>
            {s.description && <div className="text-[var(--gs-text-dim)]">{s.description}</div>}
            <div className="font-[family-name:var(--gs-font-mono)] text-[10px] text-[var(--gs-text-ghost)]">{s.path}</div>
          </div>
          <div className="flex-shrink-0">
            {s.kind === 'boolean' ? (
              <button type="button" onClick={() => onSet(s.path, !(s.value === true))} className={`border px-2 py-0.5 ${s.value === true ? 'border-[var(--gs-accent)] text-[var(--gs-accent)]' : 'border-[var(--gs-border)] text-[var(--gs-text-dim)]'}`}>{s.value === true ? 'on' : 'off'}</button>
            ) : s.kind === 'enum' ? (
              <select value={typeof s.value === 'string' ? s.value : ''} onChange={(e) => onSet(s.path, e.target.value)} className="border border-[var(--gs-border)] bg-[var(--gs-bg)] px-1 py-0.5 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">
                {typeof s.value === 'string' && !(s.options ?? []).includes(s.value) ? <option value={s.value}>{s.value}</option> : null}
                {(s.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : s.kind === 'number' ? (
              <input defaultValue={typeof s.value === 'number' ? s.value : ''} onBlur={(e) => onSet(s.path, Number(e.target.value) || 0)} className="w-20 border border-[var(--gs-border)] bg-[var(--gs-bg)] px-1 py-0.5 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]" />
            ) : (
              <input defaultValue={typeof s.value === 'string' ? s.value : ''} onBlur={(e) => onSet(s.path, e.target.value)} className="w-32 border border-[var(--gs-border)] bg-[var(--gs-bg)] px-1 py-0.5 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]" />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }): ReactElement {
  return (
    <span className="inline-block h-2 flex-1 bg-[var(--gs-border)]">
      <span className="block h-full bg-[var(--gs-info)]" style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </span>
  );
}

const usd = (n: number): string => (n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);

/** How a subagent's model was addressed — the provenance the report exists to show. */
const SELECTION_LABEL: Record<'role' | 'pinned' | 'inherited', { text: string; cls: string }> = {
  role: { text: 'role', cls: 'text-[var(--gs-success)]' },
  pinned: { text: 'pinned', cls: 'text-[var(--gs-warning)]' },
  inherited: { text: 'inherited', cls: 'text-[var(--gs-text-ghost)]' },
};

/** Right-aligned tokens + cost, the shared row tail across every breakdown. */
function UsageFigures({ tokens, costUsd }: { tokens: number; costUsd: number }): ReactElement {
  return (
    <>
      <span className="w-12 shrink-0 text-right font-[family-name:var(--gs-font-mono)] text-[var(--gs-text-dim)]">{k(tokens)}</span>
      <span className="w-14 shrink-0 text-right font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{usd(costUsd)}</span>
    </>
  );
}

function UsageTab({ control, agents = [], onLoadSessionUsage }: {
  control?: AgentControlInfo;
  agents?: AgentDefinitionInfo[];
  onLoadSessionUsage?: () => Promise<AgentSessionUsageReport | null>;
}): ReactElement {
  const u = control?.usage;
  const [report, setReport] = useState<AgentSessionUsageReport | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  // Fetch when the tab mounts (i.e. when the user opens Usage) — it's a local
  // transcript read, not a network call, so no button needed.
  useEffect(() => {
    if (!onLoadSessionUsage) return;
    let cancelled = false;
    setState('loading');
    onLoadSessionUsage()
      .then((r) => { if (!cancelled) { setReport(r); setState('idle'); } })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [onLoadSessionUsage]);

  if (!u && !report) {
    return <div className="text-[var(--gs-text-dim)]">{state === 'loading' ? 'Loading usage…' : 'No usage yet.'}</div>;
  }

  const total = u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0;
  const rows: Array<[string, number]> = u
    ? [['input', u.input], ['output', u.output], ['cache read', u.cacheRead], ['cache write', u.cacheWrite]]
    : [];
  const deep = report?.totalsDeep;
  const hasSubagents = !!deep && !!report && deep.costUsd > report.totals.costUsd + 1e-9;

  return (
    <div>
      <Grp>This session</Grp>
      {u && (
        <>
          <div className="mb-2">
            <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">${u.cost.toFixed(2)}</span>
            <span className="text-[var(--gs-text-dim)]"> · {k(total)} tokens</span>
            {hasSubagents && (
              <span className="text-[var(--gs-text-dim)]"> · with subagents <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{usd(deep!.costUsd)}</span> ({report!.childSessions} sub-session{report!.childSessions === 1 ? '' : 's'})</span>
            )}
          </div>
          {rows.map(([l, v]) => (
            <div key={l} className="flex items-center gap-2 py-1">
              <span className="w-20 text-[var(--gs-text)]">{l}</span>
              <Bar value={v} max={total} />
              <span className="w-12 text-right font-[family-name:var(--gs-font-mono)] text-[var(--gs-text-dim)]">{k(v)}</span>
            </div>
          ))}
          {u.premiumRequests > 0 && <div className="mt-2 text-[var(--gs-text-dim)]">premium requests: {u.premiumRequests}</div>}
        </>
      )}

      {state === 'error' && <div className="mt-3 text-[10px] text-[var(--gs-text-ghost)]">Breakdown unavailable for this session.</div>}

      {report && report.byProviderModel.length > 0 && (
        <>
          <Grp>By provider · model</Grp>
          {report.byProviderModel.map((m) => (
            <div key={`${m.provider}/${m.model}`} className="flex items-center gap-2 py-0.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]" title={`${m.provider}/${m.model}`}>{m.provider}/{m.model}</span>
              <span className="w-10 shrink-0 text-right text-[var(--gs-text-ghost)]">{m.requests}×</span>
              <UsageFigures tokens={m.totalTokens} costUsd={m.costUsd} />
            </div>
          ))}
        </>
      )}

      {report && report.byRole.length > 0 && (
        <>
          <Grp>By model role</Grp>
          {report.byRole.map((r) => (
            <div key={r.role} className="flex items-center gap-2 py-0.5 text-[11px]">
              <span className="w-16 shrink-0 truncate text-[var(--gs-text)]" title={r.models.join(', ')}>{r.role}</span>
              <span className="min-w-0 flex-1 truncate font-[family-name:var(--gs-font-mono)] text-[var(--gs-text-ghost)]">{r.models.join(', ')}</span>
              <span className="w-10 shrink-0 text-right text-[var(--gs-text-ghost)]">{r.requests}×</span>
              <UsageFigures tokens={r.totalTokens} costUsd={r.costUsd} />
            </div>
          ))}
          <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">
            “default” also covers explicit model picks and session restores — it is the unattributed bucket.
          </div>
        </>
      )}

      {report && report.segments.length > 0 && (() => {
        // What each role points at RIGHT NOW, so a past era can be marked as
        // "not what this role resolves to today" — the whole reason the
        // lifetime rollups looked wrong ("I'm not using that model!").
        const currentByRole = new Map(
          (control?.roleCatalog ?? []).map((r) => [r.role, r.model?.split(':')[0] ?? null]),
        );
        const time = (ms: number) =>
          ms > 0 ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
        return (
          <>
            <Grp>Timeline — when each (role · model) era ran</Grp>
            {report.segments.map((s, i) => {
              const selector = `${s.provider}/${s.model}`;
              const currentForRole = currentByRole.get(s.role);
              // Only claim "was" when we actually know the role's current model.
              const stale = currentForRole != null && currentForRole !== selector;
              return (
                <div key={`${s.role}|${selector}|${s.startedAt}|${i}`} className="flex items-center gap-2 py-0.5 text-[11px]">
                  <span className="w-28 shrink-0 truncate text-[var(--gs-text-ghost)]" title={`${time(s.startedAt)} → ${time(s.endedAt)}`}>{time(s.startedAt)}</span>
                  <span className="w-14 shrink-0 truncate text-[var(--gs-text)]" title={s.role}>{s.role}</span>
                  <span className={`min-w-0 flex-1 truncate font-[family-name:var(--gs-font-mono)] ${stale ? 'text-[var(--gs-text-ghost)] line-through' : 'text-[var(--gs-text-dim)]'}`} title={stale ? `${selector} — not what "${s.role}" resolves to now (${currentForRole})` : selector}>
                    {selector}
                  </span>
                  {s.tier === 'fast' && <span className="shrink-0 text-[var(--gs-warning)]" title="fast (priority) tier">⚡</span>}
                  <span className="w-10 shrink-0 text-right text-[var(--gs-text-ghost)]">{s.requests}×</span>
                  <UsageFigures tokens={s.totalTokens} costUsd={s.costUsd} />
                </div>
              );
            })}
            <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">
              Struck-through models are ones that role no longer resolves to — past spend, not current.
            </div>
          </>
        );
      })()}

      {report && report.byServiceTier.length > 0 && (
        <>
          <Grp>By speed — ⚡ fast (priority) vs standard</Grp>
          {report.byServiceTier.map((t) => (
            <div key={t.tier} className="flex items-center gap-2 py-0.5 text-[11px]">
              <span className={`w-16 shrink-0 ${t.tier === 'fast' ? 'font-semibold text-[var(--gs-warning)]' : 'text-[var(--gs-text)]'}`}>
                {t.tier === 'fast' ? '⚡ fast' : 'standard'}
              </span>
              <span className="min-w-0 flex-1 truncate font-[family-name:var(--gs-font-mono)] text-[var(--gs-text-ghost)]">{t.models.join(', ')}</span>
              <span className="w-10 shrink-0 text-right text-[var(--gs-text-ghost)]">{t.requests}×</span>
              <UsageFigures tokens={t.totalTokens} costUsd={t.costUsd} />
            </div>
          ))}
        </>
      )}

      {report && report.paths.length > 0 && (() => {
        // What each AGENT resolves to right now (override > frontmatter >
        // session default). These rows are lifetime aggregates, so a model here
        // is what the agent used AT SPAWN TIME — often not today's config.
        const currentByAgent = new Map(
          agents.map((a) => [a.name, a.resolvedModel?.split(':')[0] ?? null]),
        );
        const day = (ms: number) =>
          ms > 0 ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric' }) : '—';
        return (
          <>
            <Grp>By subagent path — agent · how the model was chosen</Grp>
            {report.paths.map((p) => {
              const sel = SELECTION_LABEL[p.selection];
              const currentForAgent = currentByAgent.get(p.agent);
              const stale = currentForAgent != null && currentForAgent !== p.model;
              const when = p.firstAt > 0
                ? (day(p.firstAt) === day(p.lastAt) ? day(p.firstAt) : `${day(p.firstAt)}–${day(p.lastAt)}`)
                : '—';
              return (
                <div key={`${p.agent}|${p.selection}|${p.model}`} className="flex items-center gap-2 py-0.5 text-[11px]">
                  <span className="w-16 shrink-0 truncate text-[var(--gs-text-ghost)]" title={p.firstAt > 0 ? `${new Date(p.firstAt).toLocaleString()} → ${new Date(p.lastAt).toLocaleString()}` : 'no timestamp'}>{when}</span>
                  <span className="w-20 shrink-0 truncate text-[var(--gs-text)]" title={p.agent}>{p.agent}</span>
                  <span className={`w-14 shrink-0 ${sel.cls}`}>{sel.text}</span>
                  <span
                    className={`min-w-0 flex-1 truncate font-[family-name:var(--gs-font-mono)] ${stale ? 'text-[var(--gs-text-ghost)] line-through' : 'text-[var(--gs-text-dim)]'}`}
                    title={stale ? `${p.model} — "${p.agent}" resolves to ${currentForAgent} now; this is past spend` : p.model}
                  >
                    {p.model}
                  </span>
                  <span className="w-10 shrink-0 text-right text-[var(--gs-text-ghost)]">×{p.spawnCount}</span>
                  <UsageFigures tokens={p.totalTokens} costUsd={p.costUsd} />
                </div>
              );
            })}
            <div className="mt-1 text-[10px] text-[var(--gs-text-ghost)]">
              Lifetime totals for this session — dates show when the path last ran. Struck-through
              models are not what that agent resolves to now.
            </div>
          </>
        );
      })()}

      {report && report.warnings.length > 0 && (
        <div className="mt-2 text-[10px] text-[var(--gs-text-ghost)]">{report.warnings.join(' · ')}</div>
      )}
    </div>
  );
}

function ContextTab({ control, onCompact }: { control?: AgentControlInfo; onCompact: () => void }): ReactElement {
  const c = control?.context;
  return (
    <div>
      <Grp>Context window</Grp>
      {c && c.tokens != null && c.contextWindow > 0 ? (
        <>
          <div className="mb-1"><span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{k(c.tokens)} / {k(c.contextWindow)}</span> <span className="text-[var(--gs-text-dim)]">· {Math.round((c.tokens / c.contextWindow) * 100)}%</span></div>
          <Bar value={c.tokens} max={c.contextWindow} />
        </>
      ) : (
        <div className="text-[var(--gs-text-dim)]">No context info (start the agent first).</div>
      )}
      <div className="mt-4"><button type="button" onClick={onCompact} className="border border-[var(--gs-border)] px-3 py-1 text-[var(--gs-text)] hover:border-[var(--gs-accent)]">Compact now</button></div>
    </div>
  );
}

type AccountUsage = { id: number; email?: string; ok: boolean | null; reason?: string; limits: Array<{ label: string; unit?: string; used?: number; limit?: number; remaining?: number; remainingFraction?: number; resetsAt?: number; status?: string }>; resetCredits?: { availableCount: number } };

/** Fraction of a limit window still available (0..1), from whichever field the
 *  provider reported. Returns null when it can't be derived. */
function remainingFractionOf(l: AccountUsage['limits'][number]): number | null {
  if (typeof l.remainingFraction === 'number') return Math.max(0, Math.min(1, l.remainingFraction));
  if (typeof l.remaining === 'number' && typeof l.limit === 'number' && l.limit > 0) return Math.max(0, Math.min(1, l.remaining / l.limit));
  if (typeof l.used === 'number' && typeof l.limit === 'number' && l.limit > 0) return Math.max(0, Math.min(1, 1 - l.used / l.limit));
  if (l.unit === 'percent' && typeof l.used === 'number') return Math.max(0, Math.min(1, 1 - l.used / 100));
  return null;
}

function ProvidersTab({ providers, loading, oauth, onOAuthLogin, onOAuthRespond, onSetApiKey, onRemoveAccount, onCheckUsage }: {
  providers: AgentAuthProvider[];
  loading: boolean;
  oauth: ActiveOAuth;
  onOAuthLogin: (p: string) => void;
  onOAuthRespond: (v: string) => void;
  onSetApiKey: (p: string, key: string) => Promise<void>;
  onRemoveAccount: (provider: string, credentialId: number) => Promise<void>;
  onCheckUsage: (provider: string) => Promise<AccountUsage[]>;
}): ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [promptValue, setPromptValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [usage, setUsage] = useState<Record<string, AccountUsage[]>>({});
  const [usageLoading, setUsageLoading] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const checkUsage = async (provider: string) => {
    setUsageLoading(provider); setErr(null);
    try { const rows = await onCheckUsage(provider); setUsage((prev) => ({ ...prev, [provider]: rows })); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Usage check failed'); }
    finally { setUsageLoading(null); }
  };
  const saveKey = async (provider: string) => {
    if (!keyValue.trim()) return;
    setSaving(true); setErr(null);
    try { await onSetApiKey(provider, keyValue.trim()); setEditing(null); setKeyValue(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setSaving(false); }
  };
  return (
    <div>
      {oauth && oauth.kind !== 'done' && (
        <div className="mb-3 border border-[var(--gs-accent)] bg-[var(--gs-bg)] p-2">
          <div className="text-[var(--gs-text)]">Signing in to <span className="font-[family-name:var(--gs-font-mono)]">{oauth.provider}</span>…</div>
          {oauth.url && <div className="mt-1"><a href={oauth.url} target="_blank" rel="noreferrer" className="break-all text-[var(--gs-accent)] underline">{oauth.url}</a>{oauth.instructions && <div className="mt-1 text-[var(--gs-text-dim)]">{oauth.instructions}</div>}</div>}
          {oauth.kind === 'prompt' && (
            <div className="mt-2">
              <div className="text-[var(--gs-text-dim)]">{oauth.message}</div>
              <div className="mt-1 flex gap-2">
                <input autoFocus value={promptValue} onChange={(e) => setPromptValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { onOAuthRespond(promptValue); setPromptValue(''); } }} placeholder={oauth.placeholder ?? 'enter value'} className="flex-1 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-2 py-1 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]" />
                <button type="button" onClick={() => { onOAuthRespond(promptValue); setPromptValue(''); }} className="border border-[var(--gs-accent)] px-2 py-1 text-[var(--gs-accent)]">submit</button>
              </div>
            </div>
          )}
        </div>
      )}
      {oauth && oauth.kind === 'done' && !oauth.ok && <div className="mb-2 text-[var(--gs-danger)]">⚠ {oauth.provider} sign-in failed{oauth.error ? `: ${oauth.error}` : ''}</div>}
      {loading && providers.length === 0 ? (
        <div className="text-[var(--gs-text-dim)]">Loading providers…</div>
      ) : (
        providers.map((p) => (
          <div key={p.provider} className="border-b border-[var(--gs-border-muted)] py-1.5 last:border-b-0">
            <div className="flex items-center gap-2">
              <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{p.provider}</span>
              {p.hasAuth
                ? <span className="text-[var(--gs-success)]">✓ {(p.accounts?.length ?? 0) > 1 ? `${p.accounts!.length} accounts` : 'signed in'}</span>
                : <span className="text-[var(--gs-text-dim)]">not signed in</span>}
              <button type="button" onClick={() => onOAuthLogin(p.provider)} className="ml-auto text-[var(--gs-accent)] hover:underline" title="Sign in another account — the SDK keeps them as a pool and rotates on rate limits">{(p.accounts?.length ?? 0) > 0 ? 'add account' : 'sign in'}</button>
              {p.hasAuth && (
                <button type="button" disabled={usageLoading === p.provider} onClick={() => void checkUsage(p.provider)} className="text-[var(--gs-accent)] hover:underline disabled:opacity-50" title="Fetch live plan usage / limits for this provider's accounts">{usageLoading === p.provider ? 'checking…' : 'usage'}</button>
              )}
              <button type="button" onClick={() => { setEditing(editing === p.provider ? null : p.provider); setKeyValue(''); setErr(null); }} className="text-[var(--gs-accent)] hover:underline">{p.hasAuth ? 'update key' : 'add key'}</button>
            </div>
            {/* Account pool: each OAuth/API-key credential for this provider,
                with per-account removal (the SDK auto-rotates across them). */}
            {(p.accounts?.length ?? 0) > 0 && (
              <div className="mt-1 flex flex-col gap-0.5 pl-3">
                {p.accounts!.map((acct) => {
                  const acctUsage = usage[p.provider]?.find((a) => a.id === acct.id);
                  return (
                  <div key={acct.id}>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-[var(--gs-text-ghost)]">{acct.type === 'oauth' ? '◈' : '⚿'}</span>
                      <span className={`min-w-0 flex-1 truncate font-[family-name:var(--gs-font-mono)] ${acct.disabled ? 'text-[var(--gs-text-ghost)] line-through' : 'text-[var(--gs-text-dim)]'}`} title={acct.disabled ? 'disabled (auth failed) — remove and re-add' : acct.label}>{acct.label}{acct.disabled ? ' — disabled' : ''}</span>
                      <button
                        type="button"
                        disabled={removingId === acct.id}
                        onClick={() => { setRemovingId(acct.id); void onRemoveAccount(p.provider, acct.id).catch((e) => setErr(e instanceof Error ? e.message : 'Remove failed')).finally(() => setRemovingId(null)); }}
                        className="flex-shrink-0 text-[var(--gs-text-ghost)] hover:text-[var(--gs-danger)] disabled:opacity-40"
                        title="Remove this account"
                      >
                        {removingId === acct.id ? '…' : '✕'}
                      </button>
                    </div>
                    {acctUsage && (
                      <div className="ml-4 mt-0.5 flex flex-col gap-0.5">
                        {acctUsage.ok === false && <div className="text-[10px] text-[var(--gs-danger)]">⚠ {acctUsage.reason ?? 'usage check failed'}</div>}
                        {acctUsage.ok !== false && acctUsage.limits.length === 0 && <div className="text-[10px] text-[var(--gs-text-ghost)]">no limit data reported</div>}
                        {acctUsage.limits.map((l, i) => {
                          const frac = remainingFractionOf(l);
                          const pct = frac != null ? Math.round(frac * 100) : null;
                          const barColor = frac == null ? 'var(--gs-text-dim)' : frac < 0.15 ? 'var(--gs-danger)' : frac < 0.4 ? 'var(--gs-warning)' : 'var(--gs-success)';
                          return (
                            <div key={i} className="flex items-center gap-1.5 text-[10px] text-[var(--gs-text-dim)]">
                              <span className="w-16 shrink-0 truncate" title={l.label}>{l.label}</span>
                              <div className="h-1.5 w-16 shrink-0 overflow-hidden border border-[var(--gs-border-muted)] bg-[var(--gs-bg)]">
                                {pct != null && <div className="h-full" style={{ width: `${pct}%`, background: barColor }} />}
                              </div>
                              <span className="shrink-0 tabular-nums">{pct != null ? `${pct}% left` : (typeof l.remaining === 'number' ? `${l.remaining} left` : '—')}</span>
                              {typeof l.resetsAt === 'number' && <span className="shrink-0 text-[var(--gs-text-ghost)]">· resets {new Date(l.resetsAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>}
                            </div>
                          );
                        })}
                        {acctUsage.resetCredits && acctUsage.resetCredits.availableCount > 0 && (
                          <div className="flex items-center gap-1.5 text-[10px] text-[var(--gs-text-dim)]">
                            <span className="w-16 shrink-0 truncate" title="Saved rate-limit resets you can redeem on demand">credits</span>
                            <span className="shrink-0 tabular-nums text-[var(--gs-success)]">+{acctUsage.resetCredits.availableCount} banked reset{acctUsage.resetCredits.availableCount === 1 ? '' : 's'}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
            {editing === p.provider && (
              <div className="mt-2 flex gap-2">
                <input type="password" autoFocus value={keyValue} onChange={(e) => setKeyValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(p.provider); }} placeholder={`${p.provider} API key`} className="flex-1 border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]" />
                <button type="button" disabled={saving || !keyValue.trim()} onClick={() => void saveKey(p.provider)} className="border border-[var(--gs-accent)] px-2 py-1 text-[var(--gs-accent)] disabled:opacity-50">{saving ? 'saving…' : 'save'}</button>
              </div>
            )}
          </div>
        ))
      )}
      {err && <div className="mt-2 text-[var(--gs-danger)]">⚠ {err}</div>}
    </div>
  );
}
