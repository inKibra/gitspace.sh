/**
 * KanbanBoard TUI - columns and workspace cards for terminal.
 * Figma-aligned: command bar above, full-width columns, horizontal scroll, richer cards.
 */

import type { ScrollBoxRenderable } from '@opentui/core';
import { useRef, useEffect } from 'react';
import type { WorkspaceBoardGroup, MovingState, KanbanWorkspaceItem } from '../machine/controllers/useKanbanViewController.js';
import { PHASE_LABELS } from '../machine/controllers/useKanbanViewController.js';
import type { WorkspaceStatusSummary } from '../app/workspaces/workspace-status.js';
import { getWorkspaceDisplayName } from './KanbanBoard.js';

const COLORS = {
  border: '#2c2c2e',
  selected: '#00AAFF',
  text: '#c9d1d9',
  textDim: '#52525b',
  textMid: '#a1a1aa',
  phaseTitle: '#c9d1d9',
  dot: '#10b981',
  dotBlue: '#3b82f6',
  dotAmber: '#f59e0b',
  dotRed: '#ef4444',
  cardBg: '#161618',
  cardSelectedBg: '#162236',
  ghostBorder: '#FFAA00',
  ghostBg: '#1a1a0a',
  ghostText: '#FFAA00',
};



/** Approximate column width for auto-scroll calculations. */
const LANE_WIDTH = 30;

export interface KanbanBoardTUIProps {
  groups: WorkspaceBoardGroup[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string | null) => void;
  workspaceStatusById?: Record<string, WorkspaceStatusSummary>;
  machineLabel?: string;
  focused?: boolean;
  focusedLaneIndex?: number;
  /** Moving mode state from useWorkspaceBoardState. */
  moving?: MovingState | null;
}

function getPrimaryStatusColor(status: WorkspaceStatusSummary | undefined): string {
  switch (status?.primaryColor) {
    case 'green':
      return COLORS.dot;
    case 'blue':
      return COLORS.dotBlue;
    case 'orange':
      return COLORS.dotAmber;
    case 'red':
      return COLORS.dotRed;
    case 'dim':
    default:
      return COLORS.textDim;
  }
}

function CountChip({ color, count }: { color: string; count: number }) {
  return (
    <box flexDirection="row" gap={0}>
      <text fg={COLORS.textDim}>(</text>
      <text fg={color}>{count}</text>
      <text fg={COLORS.textDim}>)</text>
    </box>
  );
}

function StatusRow({
  label,
  green = 0,
  blue = 0,
  orange = 0,
  red = 0,
}: {
  label: string;
  green?: number;
  blue?: number;
  orange?: number;
  red?: number;
}) {
  const rowLabel = `${label.padEnd(10, ' ')}`;
  const hasAny = green > 0 || blue > 0 || orange > 0 || red > 0;
  return (
    <box flexDirection="row">
      <text fg={COLORS.textMid}>{rowLabel}</text>
      <box flexGrow={1} />
      <box flexDirection="row" gap={1}>
        {green > 0 && <CountChip color={COLORS.dot} count={green} />}
        {blue > 0 && <CountChip color={COLORS.dotBlue} count={blue} />}
        {orange > 0 && <CountChip color={COLORS.dotAmber} count={orange} />}
        {red > 0 && <CountChip color={COLORS.dotRed} count={red} />}
        {!hasAny && <text fg={COLORS.textDim}>(0)</text>}
      </box>
    </box>
  );
}

function formatActorList(logins: string[]): string {
  if (logins.length === 0) return '';
  if (logins.length === 1) return `@${logins[0]}`;
  return `@${logins[0]} +${logins.length - 1}`;
}

function getPullRequestSummary(entry: KanbanWorkspaceItem): { text: string; color: string } | null {
  const pullRequest = entry.pullRequest;
  if (!pullRequest || pullRequest.syncState === 'not_found') {
    return null;
  }
  if (pullRequest.syncState === 'loading') {
    return { text: 'PR loading', color: COLORS.textDim };
  }
  if (pullRequest.syncState === 'cli_missing') {
    return { text: 'install gh', color: COLORS.textDim };
  }
  if (pullRequest.syncState === 'unauthenticated') {
    return { text: 'gh login', color: COLORS.textDim };
  }
  if (pullRequest.syncState === 'unavailable') {
    return { text: 'PR unavailable', color: COLORS.textDim };
  }
  const prefix = pullRequest.number ? `PR#${pullRequest.number}` : 'PR';
  if (pullRequest.reviewDecision === 'changes_requested') {
    return { text: `${prefix} changes`, color: COLORS.dotRed };
  }
  if (pullRequest.reviewDecision === 'approved') {
    return { text: `${prefix} approved`, color: COLORS.dot };
  }
  if (pullRequest.state === 'merged') {
    return { text: `${prefix} merged`, color: COLORS.dotBlue };
  }
  return { text: `${prefix} review`, color: COLORS.dotAmber };
}

function WorkspaceCard({
  entry,
  isSelected,
  onSelect,
  status,
  machineLabel,
  ghost = false,
}: {
  key?: string;
  entry: KanbanWorkspaceItem;
  isSelected: boolean;
  onSelect: () => void;
  status?: WorkspaceStatusSummary;
  /** When provided, shows a machine badge below the workspace name */
  machineLabel?: string;
  ghost?: boolean;
}) {
  const name = getWorkspaceDisplayName(entry);

  const borderColor = ghost ? COLORS.ghostBorder : isSelected ? COLORS.selected : COLORS.border;
  const bgColor = ghost ? COLORS.ghostBg : isSelected ? COLORS.cardSelectedBg : COLORS.cardBg;
  const textColor = ghost ? COLORS.ghostText : COLORS.text;
  const dimColor = ghost ? COLORS.ghostText : COLORS.textDim;
  const subtleTextColor = ghost ? COLORS.ghostText : COLORS.textMid;
  const primaryColor = ghost ? COLORS.ghostText : getPrimaryStatusColor(status);
  const pullRequestSummary = getPullRequestSummary(entry);
  const changeAuthors = entry.pullRequest?.changesRequestedBy.map((actor) => actor.login) ?? [];

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      borderStyle={ghost ? 'single' : 'single'}
      borderColor={borderColor}
      backgroundColor={bgColor}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      {/* Title: name + primary workspace status color */}
      <box flexDirection="row">
        <text
          fg={textColor}
          {...(ghost ? {} : { onClick: onSelect } as object)}
        >
          {ghost ? '⇢ ' : isSelected ? '▸ ' : '  '}
          {name}
        </text>
        <box flexGrow={1} />
        <text fg={primaryColor}>●</text>
      </box>
      {machineLabel && <text fg={subtleTextColor}>  ⌂ {machineLabel}</text>}
      {pullRequestSummary && <text fg={pullRequestSummary.color}>  {pullRequestSummary.text}</text>}
      {entry.pullRequest?.author && (
        <text fg={subtleTextColor}>  by @{entry.pullRequest.author.login}</text>
      )}
      {(entry.pullRequest?.requestedReviewers.length ?? 0) > 0 && (
        <text fg={ghost ? COLORS.ghostText : COLORS.dotAmber}>
          {'  '}
          requested {entry.pullRequest?.requestedReviewers.length ?? 0}
        </text>
      )}
      {(entry.pullRequest?.reviewers.length ?? 0) > 0 && (
        <text fg={ghost ? COLORS.ghostText : COLORS.dot}>
          {'  '}
          reviewed {entry.pullRequest?.reviewers.length ?? 0}
        </text>
      )}
      {changeAuthors.length > 0 && (
        <text fg={ghost ? COLORS.ghostText : COLORS.dotRed}>  changes {formatActorList(changeAuthors)}</text>
      )}
      {entry.linear?.syncState === 'ready' && entry.linear.identifier && (
        <text fg={ghost ? COLORS.ghostText : COLORS.dotBlue}>
          {'  '}
          {entry.linear.stateName ? `${entry.linear.identifier} ${entry.linear.stateName}` : entry.linear.identifier}
        </text>
      )}
      {entry.linear?.syncState === 'unconfigured' && (
        <text fg={ghost ? COLORS.ghostText : COLORS.textDim}>  Linear setup</text>
      )}
      {entry.linear?.syncState === 'identifier_missing' && (
        <text fg={ghost ? COLORS.ghostText : COLORS.textDim}>  no issue key</text>
      )}
      <StatusRow
        label="Agents"
        green={status?.agents.green ?? 0}
        blue={status?.agents.blue ?? 0}
        orange={status?.agents.orange ?? 0}
        red={status?.agents.red ?? 0}
      />
      <StatusRow
        label="Services"
        green={status?.services.green ?? 0}
        red={status?.services.red ?? 0}
      />
      <StatusRow
        label="Terminals"
        green={status?.terminals.green ?? 0}
        red={status?.terminals.red ?? 0}
      />
      {/* Moving mode hint on ghost card */}
      {ghost && (
        <text fg={COLORS.ghostText}>  Shift+←/→ move · ↵ confirm · esc cancel</text>
      )}
    </box>
  );
}

export function KanbanBoardTUI({
  groups,
  selectedWorkspaceId,
  onSelectWorkspace,
  workspaceStatusById = {},
  machineLabel = 'local',
  focused = false,
  focusedLaneIndex = 0,
  moving = null,
}: KanbanBoardTUIProps) {
  const boardScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Auto-scroll to bring the focused lane into view when it changes
  useEffect(() => {
    if (!focused || !boardScrollRef.current) return;
    const targetX = focusedLaneIndex * LANE_WIDTH;
    boardScrollRef.current.scrollTo({ x: Math.max(0, targetX), y: 0 });
  }, [focused, focusedLaneIndex]);

  // Find the workspace entry for the ghost card
  const movingEntry = moving
    ? groups.flatMap((g) => g.workspaces).find((w) => w.id === moving.workspaceId) ?? null
    : null;

  return (
    <scrollbox
      ref={(el: ScrollBoxRenderable | null) => {
        boardScrollRef.current = el;
      }}
      scrollX={true}
      flexGrow={1}
      width="100%"
    >
      <box flexDirection="row" flexGrow={1} width="100%" gap={2} minWidth={Math.max(112, groups.length * 28)}>
        {groups.map((group, index) => {
          const isMovingTarget = moving && group.phase === moving.targetPhase && group.phase !== moving.originPhase;
          return (
            <box
              key={group.phase}
              flexDirection="column"
              minWidth={28}
              flexGrow={1}
              borderStyle="single"
              borderColor={
                isMovingTarget
                  ? COLORS.ghostBorder
                  : focused && focusedLaneIndex === index
                    ? COLORS.selected
                    : COLORS.border
              }
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
            >
              {/* Uppercase header + count badge */}
              <box flexDirection="row">
                <text fg={
                  isMovingTarget
                    ? COLORS.ghostBorder
                    : focused && focusedLaneIndex === index
                      ? COLORS.selected
                      : COLORS.phaseTitle
                }>
                  {(PHASE_LABELS[group.phase] ?? group.phase).toUpperCase()}
                </text>
                <box flexGrow={1} />
                <text fg={COLORS.textDim}>[{group.workspaces.length}]</text>
              </box>
              <box flexDirection="column" marginTop={1}>
                {/* Ghost card at the target lane (same vertical position) */}
                {isMovingTarget && movingEntry && (
                  <WorkspaceCard
                    entry={movingEntry}
                    isSelected={false}
                    onSelect={() => {}}
                    status={workspaceStatusById[movingEntry.id]}
                    machineLabel={machineLabel}
                    ghost={true}
                  />
                )}
                {group.workspaces.map((w: KanbanWorkspaceItem) => {
                  // Hide the card in its origin lane when in moving mode
                  const isBeingMoved = moving && w.id === moving.workspaceId;
                  if (isBeingMoved && moving.targetPhase !== moving.originPhase) {
                    // Show a dimmed placeholder in the origin lane
                    return (
                      <box
                        key={w.id}
                        marginBottom={1}
                        borderStyle="single"
                        borderColor={COLORS.ghostBorder}
                        paddingLeft={1}
                        paddingRight={1}
                      >
                        <text fg={COLORS.textDim}>  {getWorkspaceDisplayName(w)} (moving...)</text>
                      </box>
                    );
                  }
                  return (
                    <WorkspaceCard
                      key={w.id}
                      entry={w}
                      isSelected={w.id === selectedWorkspaceId}
                      onSelect={() => onSelectWorkspace(w.id === selectedWorkspaceId ? null : w.id)}
                      status={workspaceStatusById[w.id]}
                      machineLabel={w.isRemote ? w.machineLabel : undefined}
                    />
                  );
                })}
              </box>
            </box>
          );
        })}
      </box>
    </scrollbox>
  );
}
