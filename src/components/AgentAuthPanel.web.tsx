/** @jsxImportSource react */
import { useState, type ReactElement } from 'react';
import type { AgentAuthProvider } from '../agents/agent-runtime-types.js';

/**
 * Provider auth panel: lists model providers + whether they have stored
 * credentials, and lets you paste an API key to sign in. (OAuth device-flow
 * sign-in is a follow-up.)
 */
export function AgentAuthPanel({
  providers,
  loading,
  onSetApiKey,
  onClose,
}: {
  providers: AgentAuthProvider[];
  loading: boolean;
  onSetApiKey: (provider: string, key: string) => Promise<void>;
  onClose: () => void;
}): ReactElement {
  const [editing, setEditing] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (provider: string) => {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative z-10 flex max-h-[70vh] w-[440px] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--gs-border)] px-4 py-2.5 text-[13px]">
          <span className="font-[family-name:var(--gs-font)] text-[var(--gs-text)]">Provider sign-in</span>
          <button type="button" onClick={onClose} className="text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">✕</button>
        </div>

        <div className="overflow-y-auto px-2 py-2 text-[12px]">
          {loading && providers.length === 0 ? (
            <div className="px-2 py-4 text-center text-[var(--gs-text-dim)]">Loading providers…</div>
          ) : providers.length === 0 ? (
            <div className="px-2 py-4 text-center text-[var(--gs-text-dim)]">No providers found.</div>
          ) : (
            providers.map((p) => (
              <div key={p.provider} className="border-b border-[var(--gs-border-muted)] px-2 py-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <span className="font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)]">{p.provider}</span>
                  {p.hasAuth ? (
                    <span className="text-[var(--gs-success)]">✓ signed in</span>
                  ) : (
                    <span className="text-[var(--gs-text-dim)]">not signed in</span>
                  )}
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
                      onKeyDown={(e) => { if (e.key === 'Enter') void save(p.provider); }}
                      placeholder={`${p.provider} API key`}
                      className="flex-1 border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 font-[family-name:var(--gs-font-mono)] text-[var(--gs-text)] outline-none focus:border-[var(--gs-accent)]"
                    />
                    <button
                      type="button"
                      disabled={saving || !keyValue.trim()}
                      onClick={() => void save(p.provider)}
                      className="border border-[var(--gs-accent)] px-2 py-1 text-[var(--gs-accent)] disabled:opacity-50"
                    >
                      {saving ? 'saving…' : 'save'}
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
          {error && <div className="px-2 py-2 text-[var(--gs-danger)]">⚠ {error}</div>}
        </div>
      </div>
    </div>
  );
}
