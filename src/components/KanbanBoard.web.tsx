/**
 * KanbanBoard Web - columns and workspace cards for browser.
 */

import type { WorkspaceBoardGroup, KanbanWorkspaceItem } from '../app/shared/board/types.js';
import { PHASE_LABELS } from '../app/shared/board/types.js';
import type { WorkspacePhase } from '../types/config.js';
import { getWorkspaceDisplayName } from './KanbanBoard.js';
import type { WorkspaceStatusSummary } from '../app/workspaces/workspace-status.js';

function PmChip({ label, tone = 'dim' }: { label: string; tone?: 'green' | 'blue' | 'amber' | 'red' | 'dim' }) {
  const toneClass =
    tone === 'green' ? 'text-[var(--gs-chip-green-text)] bg-[var(--gs-chip-green-bg)]'
    : tone === 'blue' ? 'text-[var(--gs-chip-blue-text)] bg-[var(--gs-chip-blue-bg)]'
    : tone === 'amber' ? 'text-[var(--gs-chip-amber-text)] bg-[var(--gs-chip-amber-bg)]'
    : tone === 'red' ? 'text-[var(--gs-chip-red-text)] bg-[var(--gs-chip-red-bg)]'
    : 'text-[var(--gs-chip-dim-text)] bg-[var(--gs-chip-dim-bg)]';
  return <span className={`px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase ${toneClass}`}>{label}</span>;
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
  status,
}: {
  entry: KanbanWorkspaceItem;
  isSelected: boolean;
  onSelect: () => void;
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
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      className={
        'cursor-pointer px-3 py-2.5 border-l-2 transition-colors ' +
        (isSelected
          ? 'border-l-[var(--gs-selected-border)] bg-[var(--gs-bg-selected)]'
          : 'border-l-transparent hover:bg-[var(--gs-bg-hover)]')
      }
    >
      <div className="flex items-center gap-2">
        <span className={`flex-shrink-0 text-[10px] ${dotColor}`} title={
          pendingPermissionCount > 0 ? `${pendingPermissionCount} agent(s) need attention`
          : agentCount > 0 ? `${agentCount} agent(s) running`
          : sessionCount > 0 ? `${sessionCount} terminal(s)`
          : 'No active sessions'
        }>●</span>
        <span className="font-medium text-[12px] truncate">{name}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] mt-0.5 pl-[18px]">
        {entry.branch && <span className="truncate text-[var(--gs-text-dim)]" >({entry.branch})</span>}
        {pendingPermissionCount > 0 && (
          <span className="flex-shrink-0 text-[var(--gs-warning-bright)]">⚡{pendingPermissionCount}</span>
        )}
        {agentCount > 0 && (
          <span className="flex-shrink-0 text-[var(--gs-running)]">✦{agentCount}</span>
        )}
        {sessionCount > 0 && (
          <span className="flex-shrink-0">●{sessionCount}</span>
        )}
        {processCount > 0 && (
          <span className="flex-shrink-0 text-[var(--gs-text-muted)]">⚙{processCount}</span>
        )}
      </div>
      {status && (
        <div className="mt-1 flex flex-wrap items-center gap-1 pl-[18px]">
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
        <div className="mt-1 flex flex-wrap items-center gap-1 pl-[18px]">
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
  );
}

export function KanbanBoardWeb({
  groups,
  selectedWorkspaceId,
  onSelectWorkspace,
  workspaceStatusById = {},
  fullHeight = false,
}: KanbanBoardWebProps) {
  return (
    <div className={`flex flex-1 gap-px overflow-x-auto bg-[var(--gs-gap)] ${fullHeight ? 'h-full' : ''}`}>
      {groups.map((group) => (
        <div
          key={group.phase}
          className={`flex min-w-[180px] flex-1 flex-col bg-[var(--gs-bg)] ${fullHeight ? 'h-full overflow-y-auto' : ''}`}
        >
          <div className="flex justify-between items-baseline px-3 py-2.5 text-[10px] tracking-[2px] uppercase text-[var(--gs-text-dim)]">
            <span>{PHASE_LABELS[group.phase] ?? group.phase}</span>
            <span className="text-[var(--gs-text-ghost)]">{group.workspaces.length}</span>
          </div>
          <div className="flex flex-col gap-0">
            {group.workspaces.map((w) => (
              <WorkspaceCard
                key={w.selectionKey}
                entry={w}
                isSelected={w.selectionKey === selectedWorkspaceId}
                onSelect={() => onSelectWorkspace(w.selectionKey === selectedWorkspaceId ? null : w.selectionKey)}
                status={workspaceStatusById[w.selectionKey]}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
