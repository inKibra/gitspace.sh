/**
 * KanbanBoard Web - columns and workspace cards for browser.
 */

import type { WorkspaceBoardGroup, KanbanWorkspaceItem } from '../machine/controllers/useKanbanViewController.js';
import { PHASES, PHASE_LABELS } from '../machine/controllers/useKanbanViewController.js';
import type { WorkspacePhase } from '../types/config.js';
import { getWorkspaceDisplayName } from './KanbanBoard.js';
import type { WorkspaceStatusSummary } from '../app/workspaces/workspace-status.js';

function PmChip({ label, tone = 'dim' }: { label: string; tone?: 'green' | 'blue' | 'amber' | 'red' | 'dim' }) {
  const toneClass =
    tone === 'green' ? 'border-[#1f6f43] bg-[#0d2d1a] text-[#3fb950]'
    : tone === 'blue' ? 'border-[#1f6feb] bg-[#0d1f33] text-[#58a6ff]'
    : tone === 'amber' ? 'border-[#9a6700] bg-[#2d2100] text-[#d29922]'
    : tone === 'red' ? 'border-[#a40e26] bg-[#2d1117] text-[#ff7b72]'
    : 'border-[#30363d] bg-[#161b22] text-[#8b949e]';
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
  onSelectWorkspace: (workspaceId: string | null) => void;
  onPhaseChange?: (workspaceId: string, phase: WorkspacePhase) => void;
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
  onPhaseChange?: (workspaceId: string, phase: WorkspacePhase) => void;
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
    ? 'text-[#f59e0b]'   // orange — agent waiting for permission
    : status?.primaryColor === 'red'
      ? 'text-[#ff7b72]'
      : status?.primaryColor === 'blue'
        ? 'text-[#58a6ff]'
        : (sessionCount > 0 || agentCount > 0 || processCount > 0)
      ? 'text-[#22c55e]' // green — something is running
      : 'text-[#374151]'; // dim — nothing active

  return (
    <div className="rounded border border-transparent hover:border-[#30363d]">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(e) => e.key === 'Enter' && onSelect()}
        className={
          'cursor-pointer rounded-t px-2 py-1.5 text-sm ' +
          (isSelected ? 'bg-[#388bfd] text-white' : 'text-[#c9d1d9] hover:bg-[#30363d]')
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
            <span title={`${pendingPermissionCount} agent(s) need attention`} className="flex-shrink-0 text-[#f59e0b]">
              ⚡{pendingPermissionCount}
            </span>
          )}
          {agentCount > 0 && (
            <span title={`${agentCount} agent(s)`} className="flex-shrink-0 text-[#10b981]">
              ✦{agentCount}
            </span>
          )}
          {sessionCount > 0 && (
            <span title={`${sessionCount} session(s)`} className="flex-shrink-0">
              ●{sessionCount}
            </span>
          )}
          {processCount > 0 && (
            <span title={`${processCount} process(es)`} className="flex-shrink-0 text-[#8b949e]">
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
        <div className="flex gap-0.5 px-2 pb-1.5 pt-0.5 rounded-b bg-[#161b22]" onClick={(e) => e.stopPropagation()}>
          {PHASES.map((phase) => (
            <button
              key={phase}
              type="button"
              title={`Move to ${PHASE_LABELS[phase]}`}
              onClick={() => entry.phase !== phase && onPhaseChange(entry.id, phase)}
              className={
                'text-xs px-1.5 py-0.5 rounded ' +
                (entry.phase === phase
                  ? 'bg-[#388bfd] text-white'
                  : 'text-[#6e7681] hover:bg-[#30363d] hover:text-[#e6edf3]')
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
          className={`flex min-w-[180px] flex-1 flex-col rounded border border-[#30363d] bg-[#21262d] p-2 ${fullHeight ? 'h-full overflow-y-auto' : ''}`}
        >
          <div className="font-semibold text-[#58a6ff]">
            {PHASE_LABELS[group.phase] ?? group.phase}
          </div>
          <div className="text-xs text-[#6e7681]">
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
