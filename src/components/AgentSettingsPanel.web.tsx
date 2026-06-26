/** @jsxImportSource react */
import { useState, type ReactElement } from 'react';
import type { AgentAuthProvider, AgentSettingItem } from '../agents/agent-runtime-types.js';

/**
 * Agent settings panel (opened from the chrome gear): curated settings
 * (toggles / enums) plus provider sign-in (API key; OAuth is a follow-up).
 */
export function AgentSettingsPanel({
  settings,
  providers,
  loading,
  onSetSetting,
  onSetApiKey,
  onClose,
}: {
  settings: AgentSettingItem[];
  providers: AgentAuthProvider[];
  loading: boolean;
  onSetSetting: (path: string, value: string | boolean) => Promise<void>;
  onSetApiKey: (provider: string, key: string) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveKey = async (provider: string) => {
    if (!keyValue.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSetApiKey(provider, keyValue.trim());
      setEditing(null);
      setKeyValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  const setSetting = (path: string, value: string | boolean) => {
    setError(null);
    void onSetSetting(path, value).catch((e) => setError(e instanceof Error ? e.message : 'Failed to set'));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative z-10 flex max-h-[78vh] w-[460px] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--gs-border)] px-4 py-2.5 text-[13px]">
          <span className="font-[family-name:var(--gs-font)] text-[var(--gs-text)]">Agent settings</span>
          <button type="button" onClick={onClose} className="text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">✕</button>
        </div>

        <div className="overflow-y-auto text-[12px]">
          {/* Settings */}
          <div className="px-4 py-2">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--gs-text-ghost)]">Settings</div>
            {settings.length === 0 ? (
              <div className="py-2 text-[var(--gs-text-dim)]">{loading ? 'Loading…' : 'Unavailable (start the agent first).'}</div>
            ) : (
              settings.map((s) => (
                <div key={s.path} className="flex items-center gap-2 py-1.5">
                  <span className="text-[var(--gs-text)]">{s.label}</span>
                  <span className="ml-auto">
                    {s.kind === 'boolean' ? (
                      <button
                        type="button"
                        onClick={() => setSetting(s.path, !(s.value === true))}
                        className={`border px-2 py-0.5 ${s.value === true ? 'border-[var(--gs-accent)] text-[var(--gs-accent)]' : 'border-[var(--gs-border)] text-[var(--gs-text-dim)]'}`}
                      >
                        {s.value === true ? 'on' : 'off'}
                      </button>
                    ) : (
                      <select
                        value={typeof s.value === 'string' ? s.value : ''}
                        onChange={(e) => setSetting(s.path, e.target.value)}
                        className="border border-[var(--gs-border)] bg-[var(--gs-bg)] px-1 py-0.5 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)] outline-none"
                      >
                        {typeof s.value === 'string' ? null : <option value="">—</option>}
                        {(s.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Providers */}
          <div className="border-t border-[var(--gs-border)] px-2 py-2">
            <div className="mb-1 px-2 text-[10px] uppercase tracking-wide text-[var(--gs-text-ghost)]">Provider sign-in</div>
            {loading && providers.length === 0 ? (
              <div className="px-2 py-3 text-center text-[var(--gs-text-dim)]">Loading providers…</div>
            ) : (
              providers.map((p) => (
                <div key={p.provider} className="border-b border-[var(--gs-border-muted)] px-2 py-1.5 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{p.provider}</span>
                    {p.hasAuth ? <span className="text-[var(--gs-success)]">✓ signed in</span> : <span className="text-[var(--gs-text-dim)]">not signed in</span>}
                    <button
                      type="button"
                      onClick={() => { setEditing(editing === p.provider ? null : p.provider); setKeyValue(''); setError(null); }}
                      className="ml-auto text-[var(--gs-accent)] hover:underline"
                    >
                      {p.hasAuth ? 'update key' : 'add key'}
                    </button>
                  </div>
                  {editing === p.provider && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="password"
                        autoFocus
                        value={keyValue}
                        onChange={(e) => setKeyValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(p.provider); }}
                        placeholder={`${p.provider} API key`}
                        className="flex-1 border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]"
                      />
                      <button type="button" disabled={saving || !keyValue.trim()} onClick={() => void saveKey(p.provider)} className="border border-[var(--gs-accent)] px-2 py-1 text-[var(--gs-accent)] disabled:opacity-50">
                        {saving ? 'saving…' : 'save'}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {error && <div className="px-4 py-2 text-[var(--gs-danger)]">⚠ {error}</div>}
        </div>
      </div>
    </div>
  );
}
