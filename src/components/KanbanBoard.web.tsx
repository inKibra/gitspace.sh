/**
 * KanbanBoard Web - columns and workspace cards for browser.
 */

import type { WorkspaceBoardGroup, KanbanWorkspaceItem } from '../app/shared/board/types.js';
import { PHASES, PHASE_LABELS } from '../app/shared/board/types.js';
import type { WorkspacePhase } from '../types/config.js';
import { getWorkspaceDisplayName } from './KanbanBoard.js';
import type { WorkspaceStatusSummary } from '../app/workspaces/workspace-status.js';

function PmChip({ label, tone = 'dim' }: { label: string; tone?: 'green' | 'blue' | 'amber' | 'red' | 'dim' }) {
  const toneClass =
    tone === 'green' ? 'border-[var(--gs-chip-green-border)] bg-[var(--gs-chip-green-bg)] text-[var(--gs-chip-green-text)]'
    : tone === 'blue' ? 'border-[var(--gs-chip-blue-border)] bg-[var(--gs-chip-blue-bg)] text-[var(--gs-chip-blue-text)]'
    : tone === 'amber' ? 'border-[var(--gs-chip-amber-border)] bg-[var(--gs-chip-amber-bg)] text-[var(--gs-chip-amber-text)]'
    : tone === 'red' ? 'border-[var(--gs-chip-red-border)] bg-[var(--gs-chip-red-bg)] text-[var(--gs-chip-red-text)]'
    : 'border-[var(--gs-chip-dim-border)] bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)]';
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${toneClass}`}>{label}</span>;
}

function formatActorList(logins: string[]): string {
  if (logins.length === 0) return '';
  if (logins.length === 1) return `@${logins[0]}`;
  return `@${logins[0]} +${logins.length - 1}`;
}

function getPullRequestChip(entry: KanbanWorkspaceItem): { label: string; tone: 'green' | 'blue' | 'amber' | 'red' | 'dim' } | null {
  const pullRequest = entry.pullRequest;
  if (!pullRequest || pullRequest.syncState === 'not_found') {
    return null;
  }
  if (pullRequest.syncState === 'loading') {
    return { label: 'PR loading', tone: 'dim' };
  }
  if (pullRequest.syncState === 'cli_missing') {
    return { label: 'Install gh', tone: 'dim' };
  }
  if (pullRequest.syncState === 'unauthenticated') {
    return { label: 'gh login', tone: 'dim' };
  }
  if (pullRequest.syncState === 'unavailable') {
    return { label: 'PR unavailable', tone: 'dim' };
  }
  const prefix = pullRequest.number ? `PR #${pullRequest.number}` : 'PR';
  if (pullRequest.reviewDecision === 'changes_requested') {
    return { label: `${prefix} changes`, tone: 'red' };
  }
  if (pullRequest.reviewDecision === 'approved') {
    return { label: `${prefix} approved`, tone: 'green' };
  }
  if (pullRequest.state === 'merged') {
    return { label: `${prefix} merged`, tone: 'blue' };
  }
  return { label: `${prefix} review`, tone: 'amber' };
}

export interface KanbanBoardWebProps {
  groups: WorkspaceBoardGroup[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceKey: string | null) => void;
  onPhaseChange?: (workspaceKey: string, phase: WorkspacePhase) => void;
  workspaceStatusById?: Record<string, WorkspaceStatusSummary>;
  /** When true, lanes stretch vertically to fill the container. */
  fullHeight?: boolean;
}

function StatusChip({ label, count, tone }: { label: string; count: number; tone: 'green' | 'blue' | 'amber' | 'red' | 'dim' }) {
  if (count <= 0 && tone !== 'dim') return null;
  return <PmChip label={`${label} ${count}`} tone={tone} />;
}

function WorkspaceCard({
  entry,
  isSelected,
  onSelect,
  onPhaseChange,
  status,
}: {
  entry: KanbanWorkspaceItem;
  isSelected: boolean;
  onSelect: () => void;
  onPhaseChange?: (workspaceKey: string, phase: WorkspacePhase) => void;
  status?: WorkspaceStatusSummary;
}) {
  const name = getWorkspaceDisplayName(entry);
  const sessionCount = entry.sessionCount ?? 0;
  const processCount = entry.processes?.length ?? 0;
  const agentCount = entry.agentCount ?? 0;
  const pendingPermissionCount = entry.pendingPermissionCount ?? 0;
  const prChip = getPullRequestChip(entry);
  const linear = entry.linear;
  const changeAuthors = entry.pullRequest?.changesRequestedBy.map((actor) => actor.login) ?? [];

  // Primary status dot: orange = needs attention, green = active, dim = idle
  const dotColor = status?.primaryColor === 'orange'
    ? 'text-[var(--gs-warning-bright)]'   // orange — agent waiting for permission
    : status?.primaryColor === 'red'
      ? 'text-[var(--gs-danger-hover)]'
      : status?.primaryColor === 'blue'
        ? 'text-[var(--gs-info)]'
        : (sessionCount > 0 || agentCount > 0 || processCount > 0)
      ? 'text-[var(--gs-accent)]' // green — something is running
      : 'text-[var(--gs-text-ghost)]'; // dim — nothing active

  return (
    <div className="rounded border border-transparent hover:border-[var(--gs-border)]">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => e.key === 'Enter' && onSelect()}
        className={
          'cursor-pointer rounded-t px-2 py-1.5 text-sm ' +
          (isSelected ? 'bg-[var(--gs-info)] text-white' : 'text-[var(--gs-text-secondary)] hover:bg-[var(--gs-border)]')
        }
      >
        <div className="flex items-center gap-1.5">
          <span className={`flex-shrink-0 ${dotColor}`} title={
            pendingPermissionCount > 0 ? `${pendingPermissionCount} agent(s) need attention`
            : agentCount > 0 ? `${agentCount} agent(s) running`
            : sessionCount > 0 ? `${sessionCount} terminal(s)`
            : 'No active sessions'
          }>●</span>
          <span className="font-medium truncate">{name}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs opacity-90 mt-0.5 pl-3.5">
          {entry.branch && <span className="truncate">({entry.branch})</span>}
          {pendingPermissionCount > 0 && (
            <span title={`${pendingPermissionCount} agent(s) need attention`} className="flex-shrink-0 text-[var(--gs-warning-bright)]">
              ⚡{pendingPermissionCount}
            </span>
          )}
          {agentCount > 0 && (
            <span title={`${agentCount} agent(s)`} className="flex-shrink-0 text-[var(--gs-running)]">
              ✦{agentCount}
            </span>
          )}
          {sessionCount > 0 && (
            <span title={`${sessionCount} session(s)`} className="flex-shrink-0">
              ●{sessionCount}
            </span>
          )}
          {processCount > 0 && (
            <span title={`${processCount} process(es)`} className="flex-shrink-0 text-[var(--gs-text-muted)]">
              ⚙{processCount}
            </span>
          )}
        </div>
        {status && (
          <div className="mt-1 flex flex-wrap items-center gap-1 pl-3.5">
            <StatusChip label="A" count={status.agents.orange} tone="amber" />
            <StatusChip label="A" count={status.agents.green} tone="green" />
            <StatusChip label="A" count={status.agents.blue} tone="blue" />
            <StatusChip label="A" count={status.agents.red} tone="red" />
            <StatusChip label="S" count={status.services.green} tone="green" />
            <StatusChip label="S" count={status.services.red} tone="red" />
            <StatusChip label="T" count={status.terminals.green} tone="green" />
            <StatusChip label="T" count={status.terminals.red} tone="red" />
          </div>
        )}
        {(prChip || linear?.syncState === 'ready' || linear?.syncState === 'unconfigured' || linear?.syncState === 'identifier_missing' || changeAuthors.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-1 pl-3.5">
            {prChip && <PmChip label={prChip.label} tone={prChip.tone} />}
            {entry.pullRequest?.author && (
              <PmChip label={`by @${entry.pullRequest.author.login}`} tone="dim" />
            )}
            {(entry.pullRequest?.requestedReviewers.length ?? 0) > 0 && (
              <PmChip label={`requested ${entry.pullRequest?.requestedReviewers.length ?? 0}`} tone="amber" />
            )}
            {(entry.pullRequest?.reviewers.length ?? 0) > 0 && (
              <PmChip label={`reviewed ${entry.pullRequest?.reviewers.length ?? 0}`} tone="green" />
            )}
            {changeAuthors.length > 0 && (
              <PmChip label={`changes ${formatActorList(changeAuthors)}`} tone="red" />
            )}
            {linear?.syncState === 'ready' && linear.identifier && (
              <PmChip
                label={linear.stateName ? `${linear.identifier} ${linear.stateName}` : linear.identifier}
                tone="blue"
              />
            )}
            {linear?.syncState === 'unconfigured' && (
              <PmChip label="Linear setup" tone="dim" />
            )}
            {linear?.syncState === 'identifier_missing' && (
              <PmChip label="No issue key" tone="dim" />
            )}
          </div>
        )}
      </div>
      {onPhaseChange && (
        <div className="flex gap-0.5 px-2 pb-1.5 pt-0.5 rounded-b bg-[var(--gs-bg-elevated)]" onClick={(e) => e.stopPropagation()}>
          {PHASES.map((phase) => (
            <button
              key={phase}
              type="button"
              title={`Move to ${PHASE_LABELS[phase]}`}
              onClick={() => entry.phase !== phase && onPhaseChange(entry.selectionKey, phase)}
              className={
                'text-xs px-1.5 py-0.5 rounded ' +
                (entry.phase === phase
                  ? 'bg-[var(--gs-info)] text-white'
                  : 'text-[var(--gs-text-dim)] hover:bg-[var(--gs-border)] hover:text-[var(--gs-text)]')
              }
            >
              {PHASE_LABELS[phase].slice(0, 1)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function KanbanBoardWeb({
  groups,
  selectedWorkspaceId,
  onSelectWorkspace,
  onPhaseChange,
  workspaceStatusById = {},
  fullHeight = false,
}: KanbanBoardWebProps) {
  return (
    <div className={`flex flex-1 gap-4 overflow-x-auto ${fullHeight ? 'h-full' : ''}`}>
      {groups.map((group) => (
        <div
          key={group.phase}
          className={`flex min-w-[180px] flex-1 flex-col rounded border border-[var(--gs-border)] bg-[var(--gs-bg-active)] p-2 ${fullHeight ? 'h-full overflow-y-auto' : ''}`}
        >
          <div className="font-semibold text-[var(--gs-info)]">
            {PHASE_LABELS[group.phase] ?? group.phase}
          </div>
          <div className="text-xs text-[var(--gs-text-dim)]">
            {group.workspaces.length} workspace(s)
          </div>
          <div className="mt-2 flex flex-col gap-0.5">
            {group.workspaces.map((w) => (
              <WorkspaceCard
                key={w.selectionKey}
                entry={w}
                isSelected={w.selectionKey === selectedWorkspaceId}
                onSelect={() => onSelectWorkspace(w.selectionKey === selectedWorkspaceId ? null : w.selectionKey)}
                onPhaseChange={onPhaseChange}
                status={workspaceStatusById[w.selectionKey]}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
