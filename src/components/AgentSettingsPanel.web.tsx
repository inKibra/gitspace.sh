/** @jsxImportSource react */
import { useMemo, useState, type ReactElement } from 'react';
import type {
  AgentAuthProvider,
  AgentControlInfo,
  AgentDefinitionInfo,
  AgentOAuthEvent,
  AgentSettingSchemaItem,
  AgentToolInfo,
} from '../agents/agent-runtime-types.js';

type ActiveOAuth = (AgentOAuthEvent & { provider: string }) | null;
type Tab = 'models' | 'agent' | 'settings' | 'usage' | 'context' | 'providers';
const TABS: Tab[] = ['models', 'agent', 'settings', 'usage', 'context', 'providers'];
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
  onApplyRole,
  onSetSetting,
  onSetApiKey,
  onOAuthLogin,
  onOAuthRespond,
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
  onApplyRole: (role: string) => void;
  onSetSetting: (path: string, value: string | number | boolean) => Promise<void>;
  onSetApiKey: (provider: string, key: string) => Promise<void>;
  onOAuthLogin: (provider: string) => void;
  onOAuthRespond: (value: string) => void;
  onCompact: () => void;
  onClose: () => void;
}): ReactElement {
  const [tab, setTab] = useState<Tab>('models');
  const [error, setError] = useState<string | null>(null);

  const set = (path: string, value: string | number | boolean) => {
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
          {tab === 'models' && <ModelsTab control={control} onSetModel={onSetModel} onApplyRole={onApplyRole} onSet={set} />}
          {tab === 'agent' && <AgentTab control={control} tools={tools} agents={agents} loading={loading} onSet={set} />}
          {tab === 'settings' && <SettingsTab schema={schema} loading={loading} onSet={set} />}
          {tab === 'usage' && <UsageTab control={control} />}
          {tab === 'context' && <ContextTab control={control} onCompact={onCompact} />}
          {tab === 'providers' && (
            <ProvidersTab providers={providers} loading={loading} oauth={oauth} onOAuthLogin={onOAuthLogin} onOAuthRespond={onOAuthRespond} onSetApiKey={onSetApiKey} />
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

function ModelsTab({ control, onSetModel, onApplyRole, onSet }: { control?: AgentControlInfo; onSetModel: (p: string, id: string) => void; onApplyRole: (role: string) => void; onSet: (path: string, value: string | number | boolean) => void }): ReactElement {
  const models = control?.models ?? [];
  const current = control?.currentModel ?? null;
  const roles = control?.roleCatalog ?? [];
  const thinkingLevels = control?.thinkingLevels ?? [];
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
          <Grp>Model roles — ◉ applies now · model + thinking per role</Grp>
          {roles.map((r) => {
            const { base, think } = splitRole(r.model);
            // Keep the assigned base selectable even if its provider isn't authed.
            const inList = base ? models.some((m) => `${m.provider}/${m.id}` === base) : true;
            const isCurrent = !!base && (r.model === current || base === current);
            return (
              <div key={r.role} className="flex items-center gap-2 px-1 py-1">
                <button
                  type="button"
                  onClick={() => onApplyRole(r.role)}
                  title="Apply this role's model to the session now"
                  className={isCurrent ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}
                >
                  {isCurrent ? '◉' : '○'}
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

function AgentTab({ control, tools, agents, loading, onSet }: { control?: AgentControlInfo; tools: AgentToolInfo[]; agents: AgentDefinitionInfo[]; loading: boolean; onSet: (p: string, v: string | number | boolean) => void }): ReactElement {
  const models = control?.models ?? [];
  const roles = control?.roleCatalog ?? [];
  return (
    <div>
      <Grp>Agents — subagent defs · model override per agent</Grp>
      {agents.length === 0 ? (
        <div className="text-[var(--gs-text-dim)]">{loading ? 'Loading…' : 'No agents discovered.'}</div>
      ) : (
        agents.map((a) => {
          // The select holds the OVERRIDE (task.agentModelOverrides.<name>);
          // '' = no override → the definition's own model (or session default).
          const value = a.overrideModel ?? '';
          const roleRefs = roles.map((r) => `pi/${r.role}`);
          const inList = !value || roleRefs.includes(value) || models.some((m) => `${m.provider}/${m.id}` === value);
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
                title={a.resolvedModel ? `Resolves to: ${a.resolvedModel}` : undefined}
                className="min-w-0 flex-1 truncate border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-1 py-0.5 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]"
              >
                <option value="">{`— ${a.model ?? 'session model'} —`}</option>
                {value && !inList && <option value={value}>{value}</option>}
                {roleRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
                {models.map((m) => {
                  const ref = `${m.provider}/${m.id}`;
                  return <option key={ref} value={ref}>{ref}</option>;
                })}
              </select>
            </div>
          );
        })
      )}
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

function UsageTab({ control }: { control?: AgentControlInfo }): ReactElement {
  const u = control?.usage;
  if (!u) return <div className="text-[var(--gs-text-dim)]">No usage yet.</div>;
  const total = u.input + u.output + u.cacheRead + u.cacheWrite;
  const rows: Array<[string, number]> = [['input', u.input], ['output', u.output], ['cache read', u.cacheRead], ['cache write', u.cacheWrite]];
  return (
    <div>
      <Grp>This session</Grp>
      <div className="mb-2"><span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">${u.cost.toFixed(2)}</span> <span className="text-[var(--gs-text-dim)]">· {k(total)} tokens</span></div>
      {rows.map(([l, v]) => (
        <div key={l} className="flex items-center gap-2 py-1">
          <span className="w-20 text-[var(--gs-text)]">{l}</span>
          <Bar value={v} max={total} />
          <span className="w-12 text-right font-[family-name:var(--gs-font-mono)] text-[var(--gs-text-dim)]">{k(v)}</span>
        </div>
      ))}
      {u.premiumRequests > 0 && <div className="mt-2 text-[var(--gs-text-dim)]">premium requests: {u.premiumRequests}</div>}
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

function ProvidersTab({ providers, loading, oauth, onOAuthLogin, onOAuthRespond, onSetApiKey }: {
  providers: AgentAuthProvider[];
  loading: boolean;
  oauth: ActiveOAuth;
  onOAuthLogin: (p: string) => void;
  onOAuthRespond: (v: string) => void;
  onSetApiKey: (p: string, key: string) => Promise<void>;
}): ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [promptValue, setPromptValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
              {p.hasAuth ? <span className="text-[var(--gs-success)]">✓ signed in</span> : <span className="text-[var(--gs-text-dim)]">not signed in</span>}
              <button type="button" onClick={() => onOAuthLogin(p.provider)} className="ml-auto text-[var(--gs-accent)] hover:underline">sign in</button>
              <button type="button" onClick={() => { setEditing(editing === p.provider ? null : p.provider); setKeyValue(''); setErr(null); }} className="text-[var(--gs-accent)] hover:underline">{p.hasAuth ? 'update key' : 'add key'}</button>
            </div>
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
