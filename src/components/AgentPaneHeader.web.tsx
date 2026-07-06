/** @jsxImportSource react */
import { useState, type ReactElement } from 'react';
import type { AgentControlInfo, AgentModelInfo, SessionStatus } from '../agents/agent-runtime-types.js';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

type MenuId = 'model' | 'settings';

/** A titled option-picker section inside the ⚙ settings popover. */
function SettingsPickerSection({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string | null;
  options: string[];
  onPick: (v: string) => void;
}): ReactElement {
  return (
    <div className="px-3 py-1.5">
      <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onPick(o)}
            className={`border px-1.5 py-0.5 font-mono text-[10px] ${o === value
              ? 'border-[var(--gs-accent)] text-[var(--gs-accent)]'
              : 'border-[var(--gs-border)] text-[var(--gs-text-muted)] hover:text-[var(--gs-text)]'}`}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Chrome at the top of an agent pane: model · thinking · approval · context ·
 * cost · status, driven by the OMP control seam.
 */
export function AgentPaneHeader({
  model,
  status,
  control,
  onSetModel,
  onSetThinkingLevel,
  onSetApprovalMode,
  onCycleRole,
  onToggleFast,
  onOpenHistory,
  onOpenAuth,
  error,
}: {
  model?: AgentModelInfo;
  status?: SessionStatus;
  control?: AgentControlInfo;
  onSetModel?: (provider: string, modelId: string) => void;
  onSetThinkingLevel?: (level: string) => void;
  onSetApprovalMode?: (mode: string) => void;
  onCycleRole?: () => void;
  onToggleFast?: () => void;
  onOpenHistory?: () => void;
  onOpenAuth?: () => void;
  error?: string | null;
}): ReactElement {
  const [menu, setMenu] = useState<MenuId | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const toggle = (id: MenuId) => {
    setMenu((m) => (m === id ? null : id));
    if (id === 'model') setModelQuery('');
  };
  const kind = status?.type ?? 'idle';
  // Compaction is active work — keep the dot green (pulsing) like a normal turn,
  // and surface an explicit "compacting" label so it's clear what's happening.
  const dot =
    kind === 'busy' || kind === 'compacting'
      ? 'bg-[var(--gs-success)] animate-pulse'
      : kind === 'retry'
        ? 'bg-[var(--gs-warning)]'
        : 'bg-[var(--gs-text-dim)]';
  const label = kind === 'compacting' ? 'compacting' : kind === 'busy' ? 'working' : kind === 'retry' ? 'retrying' : 'idle';

  const current = control?.currentModel ?? null; // "provider/id"
  const displayName = model?.name ?? (current ? current.slice(current.indexOf('/') + 1) : 'agent');
  const currentOpt = current ? control?.models.find((m) => `${m.provider}/${m.id}` === current) : undefined;
  const usage = control?.usage;
  const ctx = control?.context;
  const models = control?.models ?? [];
  const canSwitch = models.length > 0 && !!onSetModel;
  const mq = modelQuery.trim().toLowerCase();
  const shownModels = mq ? models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(mq)) : models;
  const roles = control?.roles ?? [];
  const currentRole = roles.find((r) => r.current) ?? roles[0];
  const canCycleRole = roles.length > 1 && !!onCycleRole;

  return (
    <div className="relative flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-1.5 text-[11px]">
      <span className="text-[var(--gs-accent)]">✦</span>

      {/* model */}
      <span className="relative">
        <button
          type="button"
          disabled={!canSwitch}
          onClick={() => canSwitch && toggle('model')}
          className={`font-[family-name:var(--gs-font)] text-[var(--gs-text)] ${canSwitch ? 'cursor-pointer hover:text-[var(--gs-accent)]' : 'cursor-default'}`}
        >
          {displayName}{canSwitch ? ' ▾' : ''}
        </button>
        {menu === 'model' && canSwitch && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
            <div className="absolute left-0 top-full z-20 mt-1 flex max-h-80 w-72 flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] shadow-lg">
              <input
                type="text"
                autoFocus
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
                placeholder="Search models…"
                className="sticky top-0 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-1.5 text-[var(--gs-text)] outline-none placeholder:text-[var(--gs-text-ghost)]"
              />
              <div className="overflow-y-auto py-1">
                {shownModels.length === 0 ? (
                  <div className="px-3 py-2 text-[var(--gs-text-dim)]">No matching models</div>
                ) : (
                  shownModels.map((m) => {
                    const ref = `${m.provider}/${m.id}`;
                    const active = ref === current;
                    return (
                      <button
                        key={ref}
                        type="button"
                        onClick={() => { onSetModel?.(m.provider, m.id); setMenu(null); }}
                        className={`block w-full truncate px-3 py-1 text-left font-[family-name:var(--gs-font-mono)] hover:bg-[var(--gs-border)] ${active ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text)]'}`}
                        title={ref}
                      >
                        {active ? '● ' : '  '}{ref}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </span>

      {/* role cycle (the cmd-P role selector) */}
      {canCycleRole && (
        <button type="button" onClick={onCycleRole} title="Cycle model role" className="text-[var(--gs-text-dim)] hover:text-[var(--gs-accent)]">
          ⟳ <span className="text-[var(--gs-text)]">{currentRole?.name ?? 'role'}</span>
        </button>
      )}

      {/* thinking level */}
      {control?.thinkingLevels?.length && onSetThinkingLevel ? (
        <PickerMenu
          label="think"
          value={control.thinkingLevel}
          options={control.thinkingLevels}
          open={menu === 'thinking'}
          onToggle={() => toggle('thinking')}
          onPick={(v) => { onSetThinkingLevel(v); setMenu(null); }}
        />
      ) : null}

      {/* approval mode */}
      {control?.approvalModes?.length && onSetApprovalMode ? (
        <PickerMenu
          label="approve"
          value={control.approvalMode}
          options={control.approvalModes}
          open={menu === 'approval'}
          onToggle={() => toggle('approval')}
          onPick={(v) => { onSetApprovalMode(v); setMenu(null); }}
        />
      ) : null}

      {/* fast mode — per-family service tier (priority). Only shown when the
          current model's family supports it; label always states on/off. */}
      {onToggleFast && control?.fastCapable && (() => {
        const fastOn = control?.serviceTier === 'priority';
        return (
          <button
            type="button"
            onClick={onToggleFast}
            title={fastOn ? 'Fast mode ON — click to turn off' : 'Fast mode OFF — click to turn on'}
            className={fastOn
              ? 'rounded-sm bg-[var(--gs-warning)] px-1.5 py-0.5 font-semibold text-[var(--gs-bg)]'
              : 'rounded-sm border border-[var(--gs-border)] px-1.5 py-0.5 text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}
          >
            ⚡ fast {fastOn ? 'on' : 'off'}
          </button>
        );
      })()}

      {/* context + cost */}
      {ctx && ctx.tokens != null && ctx.contextWindow > 0 ? (
        <span className="text-[var(--gs-text-dim)]">· {fmtTokens(ctx.tokens)}/{fmtTokens(ctx.contextWindow)} ({Math.round((ctx.tokens / ctx.contextWindow) * 100)}%)</span>
      ) : currentOpt?.contextWindow ? (
        <span className="text-[var(--gs-text-dim)]">· {fmtTokens(currentOpt.contextWindow)} ctx</span>
      ) : null}
      {usage && usage.cost > 0 ? <span className="text-[var(--gs-text-dim)]">· ${usage.cost.toFixed(2)}</span> : null}

      {error && <span className="max-w-[35%] truncate text-[var(--gs-danger)]" title={error}>⚠ {error}</span>}
      <span className="ml-auto flex items-center gap-2">
        {onOpenHistory && (
          <button type="button" onClick={onOpenHistory} title="History — rewind the conversation" className="text-[var(--gs-text-dim)] hover:text-[var(--gs-accent)]">⟲</button>
        )}
        {onOpenAuth && (
          <button type="button" onClick={onOpenAuth} title="Agent settings" className="text-[var(--gs-text-dim)] hover:text-[var(--gs-accent)]">⚙</button>
        )}
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <span className="text-[var(--gs-text-muted)]">{label}</span>
      </span>
    </div>
  );
}
