/**
 * KanbanBoard Web - columns and workspace cards for browser.
 * Desktop: side-by-side columns with 1px gap gutters.
 * Mobile (<640px): tab bar at top, one phase visible at a time.
 */

import { useState } from 'react';
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
  workspaceStatusById?: Record<string, WorkspaceStatusSummary>;
  deletingWorkspaceIds?: Record<string, { status: string; progressLabel?: string }>;
	  creatingWorkspaceIds?: Record<string, { status: string; progressLabel?: string; workspaceName: string; phase: WorkspacePhase }>;
  /** When true, lanes stretch vertically to fill the container. */
  fullHeight?: boolean;
}

	function PendingWorkspaceCard({
	  workspaceName,
	  progressLabel,
	}: {
	  workspaceName: string;
	  progressLabel?: string;
	}) {
	  return (
	    <div className="relative w-full px-3 py-2.5 border-l-2 border-l-transparent bg-[var(--gs-bg-surface)] opacity-70 cursor-not-allowed text-left">
	      <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden bg-[var(--gs-border)]">
	        <div
	          className="h-full w-1/2 bg-[var(--gs-info)]"
	          style={{ animation: 'gs-delete-card-progress 1.1s ease-in-out infinite' }}
	        />
	      </div>
	      <div className="flex items-center gap-2">
	        <span className="flex-shrink-0 text-[10px] text-[var(--gs-text-ghost)]">●</span>
	        <span className="font-medium text-[12px] truncate text-[var(--gs-text-dim)]">{workspaceName}</span>
	        <span className="ml-auto text-[9px] uppercase tracking-wide text-[var(--gs-info)]">creating</span>
	      </div>
	      {progressLabel && (
	        <div className="mt-1 pl-[18px] text-[10px] text-[var(--gs-info)] truncate">
	          {progressLabel}
	        </div>
	      )}
	    </div>
	  );
	}


function WorkspaceCard({
  entry,
  isSelected,
  onSelect,
  status,
  deletionTask,
}: {
  entry: KanbanWorkspaceItem;
  isSelected: boolean;
  onSelect: () => void;
  status?: WorkspaceStatusSummary;
  deletionTask?: { status: string; progressLabel?: string };
}) {
  const name = getWorkspaceDisplayName(entry);
  const prChip = getPullRequestChip(entry);
  const linear = entry.linear;
  const isDeleting = deletionTask?.status === 'running' || deletionTask?.status === 'queued';

  // Dot color: use the same primaryColor from WorkspaceStatusSummary
  // that the workspace detail strip bar uses
  const primaryColor = status?.primaryColor ?? 'dim';
  const dotColor =
    primaryColor === 'orange' ? 'text-[var(--gs-warning-bright)]'
    : primaryColor === 'red' ? 'text-[var(--gs-danger-hover)]'
    : primaryColor === 'blue' ? 'text-[var(--gs-info)]'
    : primaryColor === 'green' ? 'text-[var(--gs-accent)]'
    : 'text-[var(--gs-text-ghost)]';

  // Build readable info chips from status counts
  const agentTotal = status ? status.agents.green + status.agents.blue + status.agents.orange + status.agents.red : 0;
  const serviceNames = entry.processes?.map(p => p.name) ?? [];

  return (
    <button
      type="button"
      onClick={isDeleting ? undefined : onSelect}
      aria-pressed={isSelected}
      disabled={isDeleting}
      className={
        'relative w-full px-3 py-2.5 border-l-2 transition-colors text-left ' +
        (isDeleting ? 'cursor-not-allowed opacity-55 grayscale ' : 'cursor-pointer ') +
        (isSelected
          ? 'border-l-[var(--gs-selected-border)] bg-[var(--gs-bg-selected)]'
          : 'border-l-transparent hover:bg-[var(--gs-bg-hover)]')
      }
    >
      {isDeleting && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden bg-[var(--gs-border)]">
          <div
            className="h-full w-1/2 bg-[var(--gs-warning)]"
            style={{ animation: 'gs-delete-card-progress 1.1s ease-in-out infinite' }}
          />
        </div>
      )}
      {/* Name + dot */}
      <div className="flex items-center gap-2">
        <span className={`flex-shrink-0 text-[10px] ${dotColor}`}>●</span>
        <span className="font-medium text-[12px] truncate">{name}</span>
        {isDeleting && <span className="ml-auto text-[9px] uppercase tracking-wide text-[var(--gs-warning)]">deleting</span>}
      </div>

      {isDeleting && (
        <div className="mt-1 pl-[18px] text-[10px] text-[var(--gs-warning)] truncate">
          {deletionTask.progressLabel ?? 'Deleting workspace...'}
        </div>
      )}

      {/* Branch */}
      {entry.branch && (
        <div className="text-[10px] text-[var(--gs-text-dim)] mt-0.5 pl-[18px] truncate">({entry.branch})</div>
      )}

      {/* Status row: agents, terminals, services — readable text */}
      {(agentTotal > 0 || (status && (status.terminals.green > 0 || status.terminals.red > 0)) || (status && (status.services.green > 0 || status.services.red > 0))) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 pl-[18px]">
          {/* Agents */}
          {status && status.agents.orange > 0 && (
            <PmChip label={`${status.agents.orange} agent${status.agents.orange !== 1 ? 's' : ''} ⚡`} tone="amber" />
          )}
          {status && status.agents.red > 0 && (
            <PmChip label={`${status.agents.red} agent err`} tone="red" />
          )}
          {status && status.agents.green > 0 && (
            <PmChip label={`${status.agents.green} agent${status.agents.green !== 1 ? 's' : ''} busy`} tone="green" />
          )}
          {status && status.agents.blue > 0 && (
            <PmChip label={`${status.agents.blue} agent${status.agents.blue !== 1 ? 's' : ''} idle`} tone="blue" />
          )}

          {/* Terminals */}
          {status && status.terminals.green > 0 && (
            <PmChip label={`${status.terminals.green} term`} tone="dim" />
          )}
          {status && status.terminals.red > 0 && (
            <PmChip label={`${status.terminals.red} term err`} tone="red" />
          )}

          {/* Services — show names without implying per-service health */}
          {status && status.services.green > 0 && (
            <PmChip label={`${status.services.green} svc run`} tone="dim" />
          )}
          {serviceNames.length > 0 && (
            serviceNames.map(svc => (
              <PmChip key={svc} label={svc} tone="dim" />
            ))
          )}
          {status && status.services.red > 0 && (
            <PmChip label={`${status.services.red} svc err`} tone="red" />
          )}
        </div>
      )}

      {/* PR / Linear chips */}
      {(prChip || linear?.syncState === 'ready' || linear?.syncState === 'unconfigured' || linear?.syncState === 'identifier_missing') && (
        <div className="flex flex-wrap items-center gap-1 mt-1 pl-[18px]">
          {prChip && <PmChip label={prChip.label} tone={prChip.tone} />}
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
    </button>
  );
}

export function KanbanBoardWeb({
  groups,
  selectedWorkspaceId,
  onSelectWorkspace,
	  workspaceStatusById = {},
	  deletingWorkspaceIds = {},
	  creatingWorkspaceIds = {},
	  fullHeight = false,
}: KanbanBoardWebProps) {
  const [mobilePhaseIndex, setMobilePhaseIndex] = useState(0);
  const safeIndex = Math.min(mobilePhaseIndex, groups.length - 1);
  const mobileGroup = groups[safeIndex];

	  const creatingForPhase = (phase: WorkspacePhase) =>
	    Object.values(creatingWorkspaceIds).filter((task) => task.phase === phase && task.status === 'creating');
  return (
    <>
      <style>{`@keyframes gs-delete-card-progress { 0% { transform: translateX(-105%); } 100% { transform: translateX(205%); } }`}</style>
      {/* ── Mobile: tab bar + single phase ── */}
      <div className={`flex flex-col sm:hidden ${fullHeight ? 'h-full' : 'flex-1'}`}>
        {/* Phase tab bar */}
        <div className="flex border-b border-[var(--gs-border)]">
          {groups.map((group, i) => {
	            const isActive = i === safeIndex;
	            const count = group.workspaces.length + creatingForPhase(group.phase).length;
	            return (
              <button
                key={group.phase}
                type="button"
                onClick={() => setMobilePhaseIndex(i)}
                className={
                  'flex-1 py-2.5 text-[10px] tracking-[1.5px] uppercase text-center transition-colors ' +
                  (isActive
                    ? 'text-[var(--gs-text)] border-b-2 border-b-[var(--gs-selected-border)]'
                    : 'text-[var(--gs-text-dim)]')
                }
              >
                {PHASE_LABELS[group.phase]?.slice(0, 4) ?? group.phase}
                {count > 0 && <span className="ml-1 text-[var(--gs-text-ghost)]">{count}</span>}
              </button>
            );
          })}
        </div>

        {/* Cards for active phase */}
        <div className="flex-1 overflow-y-auto">
	          {mobileGroup && (mobileGroup.workspaces.length > 0 || creatingForPhase(mobileGroup.phase).length > 0) ? (
	            <div className="flex flex-col">
	              {creatingForPhase(mobileGroup.phase).map((task) => (
	                <PendingWorkspaceCard
	                  key={`creating-${task.workspaceName}`}
	                  workspaceName={task.workspaceName}
	                  progressLabel={task.progressLabel}
	                />
	              ))}
	              {mobileGroup.workspaces.map((w) => (
	                <WorkspaceCard
	                  key={w.selectionKey}
	                  entry={w}
	                  isSelected={w.selectionKey === selectedWorkspaceId}
	                  onSelect={() => onSelectWorkspace(w.selectionKey === selectedWorkspaceId ? null : w.selectionKey)}
	                  status={workspaceStatusById[w.selectionKey]}
                  deletionTask={deletingWorkspaceIds[w.selectionKey]}
	                />
	              ))}
	            </div>
	          ) : (
	            <div className="flex items-center justify-center py-12 text-[var(--gs-text-ghost)] text-xs">
	              No workspaces in {PHASE_LABELS[mobileGroup?.phase] ?? 'this phase'}
	            </div>
	          )}
        </div>
      </div>

      {/* ── Desktop: side-by-side columns ── */}
      <div className={`hidden sm:flex flex-1 gap-px overflow-x-auto bg-[var(--gs-gap)] ${fullHeight ? 'h-full' : ''}`}>
        {groups.map((group) => (
          <div
            key={group.phase}
            className={`flex min-w-[180px] flex-1 flex-col bg-[var(--gs-bg)] ${fullHeight ? 'h-full overflow-y-auto' : ''}`}
          >
	            <div className="flex justify-between items-baseline px-3 py-2.5 text-[10px] tracking-[2px] uppercase text-[var(--gs-text-dim)]">
	              <span>{PHASE_LABELS[group.phase] ?? group.phase}</span>
	              <span className="text-[var(--gs-text-ghost)]">{group.workspaces.length + creatingForPhase(group.phase).length}</span>
	            </div>
	            <div className="flex flex-col gap-0">
	              {creatingForPhase(group.phase).map((task) => (
	                <PendingWorkspaceCard
	                  key={`creating-${task.workspaceName}`}
	                  workspaceName={task.workspaceName}
	                  progressLabel={task.progressLabel}
	                />
	              ))}
	              {group.workspaces.map((w) => (
	                <WorkspaceCard
	                  key={w.selectionKey}
	                  entry={w}
	                  isSelected={w.selectionKey === selectedWorkspaceId}
	                  onSelect={() => onSelectWorkspace(w.selectionKey === selectedWorkspaceId ? null : w.selectionKey)}
	                  status={workspaceStatusById[w.selectionKey]}
                  deletionTask={deletingWorkspaceIds[w.selectionKey]}
	                />
	              ))}
	            </div>
          </div>
        ))}
      </div>
    </>
  );
}
