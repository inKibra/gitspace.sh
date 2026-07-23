/** @jsxImportSource react */
import { useState, type ReactElement } from 'react';
import type { AgentControlInfo, AgentModelInfo, SessionStatus } from '../agents/agent-runtime-types.js';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

type MenuId = 'model' | 'thinking' | 'settings';

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
  awaitingInput,
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
  /** Session is blocked on the user (an ask dialog / pending permission).
   *  Overrides busy→green so the header agrees with the board and the visible
   *  dialog — a mid-turn ask keeps status.type='busy', so without this the dot
   *  reads green while a question is on screen. */
  awaitingInput?: boolean;
}): ReactElement {
  const [menu, setMenu] = useState<MenuId | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const toggle = (id: MenuId) => {
    setMenu((m) => (m === id ? null : id));
    if (id === 'model') setModelQuery('');
  };
  const kind = status?.type ?? 'idle';
  // Match the canonical agent status colors used across the app (board, session
  // rows): awaiting-input = amber (blocked on the user — matches board's
  // permission-needed, and takes precedence exactly as determineAgentState does)
  // > error/retry = red > busy/compacting = green (pulsing) > idle = blue.
  const hasError = !!error || kind === 'retry';
  const dot = awaitingInput
    ? 'bg-[var(--gs-warning-bright)]'
    : hasError
      ? 'bg-[var(--gs-danger)]'
      : kind === 'busy' || kind === 'compacting'
        ? 'bg-[var(--gs-success)] animate-pulse'
        : 'bg-[var(--gs-info)]';
  const label = awaitingInput ? 'waiting' : hasError ? 'error' : kind === 'compacting' ? 'compacting' : kind === 'busy' ? 'working' : 'idle';

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
  // Cycle roles (control.roles) whose resolved model is `ref` — drives the
  // green in-cycle dots in the model picker. Role models may carry a
  // ":thinking" suffix; match on the base ref.
  const cycleRolesFor = (ref: string): string[] =>
    roles.filter((r) => r.model === ref || (r.model?.startsWith(`${ref}:`) ?? false)).map((r) => r.name);

  return (
    <div className="relative flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-1.5 text-[11px]">
      {/* Status indicator, left of the model name — colored by agent state. */}
      <span className={`inline-block h-2 w-2 flex-none rounded-full ${dot}`} title={label} />

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
                    const inCycle = cycleRolesFor(ref);
                    return (
                      <button
                        key={ref}
                        type="button"
                        onClick={() => { onSetModel?.(m.provider, m.id); setMenu(null); }}
                        className={`flex w-full items-center gap-1.5 px-3 py-1 text-left font-[family-name:var(--gs-font-mono)] hover:bg-[var(--gs-border)] ${active ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text)]'}`}
                        title={ref}
                      >
                        <span className="w-3 flex-none">{active ? '●' : ''}</span>
                        {/* Green dot: this model is assigned to a role in the cycle. */}
                        <span
                          className="h-1.5 w-1.5 flex-none rounded-full"
                          style={{ background: inCycle.length > 0 ? 'var(--gs-success)' : 'transparent' }}
                          title={inCycle.length > 0 ? `in cycle: ${inCycle.join(', ')}` : undefined}
                        />
                        <span className="truncate">{ref}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </span>

      {/* thinking effort — surfaced in the bar (real control seam), styled to match */}
      {control?.thinkingLevels?.length && onSetThinkingLevel ? (
        <span className="relative">
          <button
            type="button"
            onClick={() => toggle('thinking')}
            title="Thinking effort"
            className="flex items-center gap-1 text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]"
          >
            <span className="text-[10px]">think</span>
            <span className="font-mono text-[var(--gs-text)]">{control.thinkingLevel ?? 'auto'}</span>
            <span>▾</span>
          </button>
          {menu === 'thinking' && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
              <div className="absolute left-0 top-full z-20 mt-1 w-32 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] py-1 shadow-lg">
                {control.thinkingLevels.map((l) => {
                  const active = l === control.thinkingLevel;
                  return (
                    <button
                      key={l}
                      type="button"
                      onClick={() => { onSetThinkingLevel(l); setMenu(null); }}
                      className={`block w-full px-3 py-1 text-left font-mono hover:bg-[var(--gs-border)] ${active ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text)]'}`}
                    >
                      {active ? '● ' : '  '}{l}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </span>
      ) : null}

      {/* model role — a plain CYCLE button: shows the current quick-cycle
          role, click advances to the next (same seam as the ⚙ role-cycle
          button), styled to match the model/think controls */}
      {currentRole && onCycleRole ? (
        <button
          type="button"
          disabled={!canCycleRole}
          onClick={onCycleRole}
          title="cycle model role"
          className={`flex items-center gap-1 text-[var(--gs-text-dim)] ${canCycleRole ? 'hover:text-[var(--gs-text)]' : 'cursor-default'}`}
        >
          <span className="text-[10px]">role</span>
          <span className="font-mono text-[var(--gs-text)]">{currentRole.name}</span>
        </button>
      ) : null}

      {/* context — slim progress bar + tokens (mock .chat-ctx) */}
      {ctx && ctx.tokens != null && ctx.contextWindow > 0 ? (() => {
        const pct = Math.min(100, Math.max(0, Math.round((ctx.tokens! / ctx.contextWindow) * 100)));
        return (
          <span className="flex items-center gap-1.5" title={`context window · ${pct}%`}>
            <span className="text-[10px] text-[var(--gs-text-dim)]">ctx</span>
            <span className="h-[5px] w-16 flex-none overflow-hidden bg-[var(--gs-bg-active)]">
              <span className="block h-full bg-[var(--gs-info)]" style={{ width: `${pct}%` }} />
            </span>
            <span className="font-mono text-[10px] text-[var(--gs-text-dim)]">{fmtTokens(ctx.tokens!)} / {fmtTokens(ctx.contextWindow)}</span>
          </span>
        );
      })() : currentOpt?.contextWindow ? (
        <span className="text-[var(--gs-text-dim)]">· {fmtTokens(currentOpt.contextWindow)} ctx</span>
      ) : null}

      {/* session usage — total tokens · cost (mock .chat-usage) */}
      {(() => {
        if (!usage) return null;
        const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (total <= 0 && usage.cost <= 0) return null;
        return (
          <span className="font-mono text-[10px] text-[var(--gs-text-dim)]" title="session tokens · cost">
            session {fmtTokens(total)} · ${usage.cost.toFixed(2)}
          </span>
        );
      })()}

      {error && <span className="max-w-[35%] truncate text-[var(--gs-danger)]" title={error}>⚠ {error}</span>}
      <span className="ml-auto flex items-center gap-2">

        {/* Direct controls (surfaced, not buried in the ⚙ menu): fast + undo. */}
        {onToggleFast && control?.fastCapable && (() => {
          const fastOn = control?.serviceTier === 'priority';
          return (
            <button
              type="button"
              onClick={onToggleFast}
              title={fastOn ? 'Fast mode ON — click to turn off' : 'Fast mode OFF — click to turn on'}
              className={`flex items-center gap-1 px-1 text-[11px] ${fastOn ? 'font-semibold text-[var(--gs-warning)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}
            >
              ⚡ fast{fastOn ? ' on' : ''}
            </button>
          );
        })()}
        {onOpenHistory && (
          <button
            type="button"
            onClick={onOpenHistory}
            title="History — rewind / undo the conversation"
            className="flex h-6 w-6 items-center justify-center text-[13px] text-[var(--gs-text-dim)] hover:text-[var(--gs-accent)]"
          >
            ⟲
          </button>
        )}

        {(onOpenAuth || canCycleRole || onSetApprovalMode) && (
          <span className="relative">
            <button
              type="button"
              onClick={() => toggle('settings')}
              title="Agent controls & settings"
              className="flex h-6 w-6 items-center justify-center border border-[var(--gs-border)] text-[12px] text-[var(--gs-text-dim)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]"
            >
              ⚙
            </button>
            {menu === 'settings' && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-60 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] py-1 shadow-lg">
                  {canCycleRole && (
                    <button
                      type="button"
                      onClick={onCycleRole}
                      title="Cycle model role"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--gs-text-dim)] hover:bg-[var(--gs-border)]"
                    >
                      ⟳ role <span className="font-mono text-[var(--gs-text)]">{currentRole?.name ?? 'role'}</span>
                    </button>
                  )}
                  {control?.approvalModes?.length && onSetApprovalMode ? (
                    <SettingsPickerSection
                      label="approve"
                      value={control.approvalMode}
                      options={control.approvalModes}
                      onPick={(v) => { onSetApprovalMode(v); setMenu(null); }}
                    />
                  ) : null}
                  {(canCycleRole || control?.approvalModes?.length) && onOpenAuth ? (
                    <div className="my-1 border-t border-[var(--gs-border)]" />
                  ) : null}
                  {onOpenAuth && (
                    <button
                      type="button"
                      onClick={() => { setMenu(null); onOpenAuth(); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--gs-text-dim)] hover:bg-[var(--gs-border)] hover:text-[var(--gs-text)]"
                    >
                      ⚙ Agent settings…
                    </button>
                  )}
                </div>
              </>
            )}
          </span>
        )}
      </span>
    </div>
  );
}
