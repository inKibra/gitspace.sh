/** @jsxImportSource react */
import { useState, type ReactElement } from 'react';
import type { AgentControlInfo, AgentModelInfo, SessionStatus } from '../agents/agent-runtime-types.js';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Chrome at the top of an agent pane: model switcher + usage + live status,
 * driven by the OMP control seam (getAgentControlInfo / setAgentModel).
 */
export function AgentPaneHeader({
  model,
  status,
  control,
  onSetModel,
  error,
}: {
  model?: AgentModelInfo;
  status?: SessionStatus;
  control?: AgentControlInfo;
  onSetModel?: (provider: string, modelId: string) => void;
  error?: string | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const kind = status?.type ?? 'idle';
  const dot = kind === 'busy' ? 'bg-[var(--gs-success)] animate-pulse' : kind === 'retry' ? 'bg-[var(--gs-warning)]' : 'bg-[var(--gs-text-dim)]';
  const label = kind === 'busy' ? 'working' : kind === 'retry' ? 'retrying' : 'idle';

  const current = control?.currentModel ?? null; // "provider/id"
  const displayName = model?.name ?? (current ? current.slice(current.indexOf('/') + 1) : 'agent');
  const currentOpt = current ? control?.models.find((m) => `${m.provider}/${m.id}` === current) : undefined;
  const usage = control?.usage;
  const totalTokens = usage ? usage.input + usage.output : null;
  const models = control?.models ?? [];
  const canSwitch = models.length > 0 && !!onSetModel;

  return (
    <div className="relative flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-1.5 text-[11px]">
      <span className="text-[var(--gs-accent)]">✦</span>
      <button
        type="button"
        disabled={!canSwitch}
        onClick={() => canSwitch && setOpen((o) => !o)}
        className={`font-[family-name:var(--gs-font)] text-[var(--gs-text)] ${canSwitch ? 'cursor-pointer hover:text-[var(--gs-accent)]' : 'cursor-default'}`}
      >
        {displayName}{canSwitch ? ' ▾' : ''}
      </button>
      {model?.provider && <span className="text-[var(--gs-text-dim)]">{model.provider}</span>}
      {totalTokens != null && <span className="text-[var(--gs-text-dim)]">· {fmtTokens(totalTokens)} tok</span>}
      {currentOpt?.contextWindow ? <span className="text-[var(--gs-text-dim)]">· {fmtTokens(currentOpt.contextWindow)} ctx</span> : null}
      {usage && usage.cost > 0 ? <span className="text-[var(--gs-text-dim)]">· ${usage.cost.toFixed(2)}</span> : null}
      {error && <span className="max-w-[40%] truncate text-[var(--gs-danger)]" title={error}>⚠ {error}</span>}
      <span className="ml-auto flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <span className="text-[var(--gs-text-muted)]">{label}</span>
      </span>

      {open && canSwitch && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-2 top-full z-20 mt-1 max-h-72 w-72 overflow-y-auto border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] py-1 shadow-lg">
            {models.map((m) => {
              const ref = `${m.provider}/${m.id}`;
              const active = ref === current;
              return (
                <button
                  key={ref}
                  type="button"
                  onClick={() => { onSetModel?.(m.provider, m.id); setOpen(false); }}
                  className={`block w-full truncate px-3 py-1 text-left font-[family-name:var(--gs-font-mono)] hover:bg-[var(--gs-border)] ${active ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text)]'}`}
                  title={ref}
                >
                  {active ? '● ' : '  '}{ref}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
