/** @jsxImportSource react */
import type { ReactElement } from 'react';
import type { AgentModelInfo, SessionStatus } from '../agents/agent-runtime-types.js';

/**
 * Slim chrome at the top of an agent pane: current model + provider + live
 * status. Read-only for now; model switching / usage / settings come with the
 * OMP control seam.
 */
export function AgentPaneHeader({ model, status }: { model?: AgentModelInfo; status?: SessionStatus }): ReactElement {
  const kind = status?.type ?? 'idle';
  const dot = kind === 'busy' ? 'bg-[var(--gs-success)] animate-pulse' : kind === 'retry' ? 'bg-[var(--gs-warning)]' : 'bg-[var(--gs-text-dim)]';
  const label = kind === 'busy' ? 'working' : kind === 'retry' ? 'retrying' : 'idle';
  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-1.5 text-[11px]">
      <span className="text-[var(--gs-accent)]">✦</span>
      <span className="font-[family-name:var(--gs-font)] text-[var(--gs-text)]">{model?.name ?? 'agent'}</span>
      {model?.provider && <span className="text-[var(--gs-text-dim)]">{model.provider}</span>}
      {model?.role && model.role !== 'default' && <span className="text-[var(--gs-text-dim)]">· {model.role}</span>}
      <span className="ml-auto flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <span className="text-[var(--gs-text-muted)]">{label}</span>
      </span>
    </div>
  );
}
