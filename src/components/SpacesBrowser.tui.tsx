/**
 * SpacesBrowser - TUI Display Component
 *
 * Dumb presentational component for OpenTUI.
 * Receives all state and actions from useSpacesBrowser hook.
 */

import type { UseSpacesBrowserReturn, TreeItem } from './SpacesBrowser.js';
import { formatTime, getAgentSessionDisplayLabel, getAgentSessionDisplayState } from './SpacesBrowser.js';

// ============================================================================
// Colors
// ============================================================================

const COLORS = {
  border: '#555555',
  borderFocused: '#00AAFF',
  text: '#FFFFFF',
  textDim: '#888888',
  selected: '#00AAFF',
  title: '#00FF88',
  project: '#FFAA00',
  workspace: '#FFFFFF',
  branch: '#AA88FF',
  session: '#88FFAA',
  sessionAttached: '#FFAA00',
  newSession: '#00AAFF',
  stale: '#666666',
  sessionCount: '#00FF00',
};

// ============================================================================
// Props
// ============================================================================

interface SpacesBrowserTUIProps extends UseSpacesBrowserReturn {
  focused?: boolean;
}

// ============================================================================
// Hint Helper
// ============================================================================

function getSpacesBrowserHint(selectedItem: TreeItem | null | undefined): string {
  if (selectedItem?.type === 'session') {
    return '[↑↓] Navigate  [Enter] Attach  [x] Kill  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'replay-section') {
    return selectedItem.expanded
      ? '[↑↓] Navigate  [Enter] Collapse  [h] Hidden  [r] Refresh  [q] Back'
      : '[↑↓] Navigate  [Enter] Expand History  [h] Hidden  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'orphaned-replay-section') {
    return selectedItem.expanded
      ? '[↑↓] Navigate  [Enter] Collapse  [h] Hidden  [r] Refresh  [q] Back'
      : '[↑↓] Navigate  [Enter] Expand Orphaned History  [h] Hidden  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'replay') {
    return '[↑↓] Navigate  [Enter] Open  [d] Dismiss  [h] Hidden  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'process') {
    return selectedItem.status === 'running'
      ? '[↑↓] Navigate  [Enter] View  [x] Stop  [r] Refresh  [q] Back'
      : '[↑↓] Navigate  [Enter] Start  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'process-disabled') {
    return '[↑↓] Navigate  [Enter] Disabled  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'process-config-error') {
    return '[↑↓] Navigate  [Enter] Fix Config  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'workspace') {
    return '[↑↓] Navigate  [Enter] Expand  [n] New  [d] Delete  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'edit-processes') {
    return '[↑↓] Navigate  [Enter] Edit Processes Config  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'bundle-config') {
    return '[↑↓] Navigate  [Enter] Edit Bundle Config  [b] Bundle  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'agents') {
    return selectedItem.expanded
      ? '[↑↓] Navigate  [Enter] Collapse Agents  [r] Refresh  [q] Back'
      : '[↑↓] Navigate  [Enter] Expand Agents  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'agent-session') {
    return selectedItem.session.closed
      ? '[↑↓] Navigate  [d] Clear Closed Agent  [r] Refresh  [q] Back'
      : '[↑↓] Navigate  [Enter] Open Agent Session  [x] Close Agent  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'new-agent-session') {
    return '[↑↓] Navigate  [Enter] New Agent Session  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'events') {
    return '[↑↓] Navigate  [Enter] Open Events  [r] Refresh  [q] Back';
  }
  if (selectedItem?.type === 'new-session') {
    return '[↑↓] Navigate  [Enter] New Session  [r] Refresh  [q] Back';
  }
  return '[↑↓] Navigate  [Enter] Select  [n] New  [b] Bundle  [r] Refresh  [q] Back';
}

// ============================================================================
// Component
// ============================================================================

export function SpacesBrowserTUI(props: SpacesBrowserTUIProps) {
  const {
    items,
    machineName,
    isEmpty,
    focused = true,
    selectedItem,
  } = props;

  // Empty state
  if (isEmpty) {
    return (
      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={focused ? COLORS.borderFocused : COLORS.border}
      >
        <text fg={COLORS.title} paddingLeft={1}>
          {' '}{machineName || 'Workspaces'}{' '}
        </text>
        <box flexDirection="column" paddingLeft={1} paddingTop={1} flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={COLORS.textDim}>No workspaces found</text>
          <box flexDirection="row" paddingTop={1}>
            <text fg={COLORS.textDim}>Press </text>
            <text fg={COLORS.sessionCount}>[n]</text>
            <text fg={COLORS.textDim}> to create a workspace</text>
          </box>
        </box>
        <text fg={COLORS.textDim} height={1} paddingLeft={1}>
          [n] New  [r] Refresh  [q] Back
        </text>
      </box>
    );
  }

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? COLORS.borderFocused : COLORS.border}
    >
      {/* Header */}
      <text fg={COLORS.title} paddingLeft={1}>
        {' '}{machineName || 'Workspaces'}{' '}
      </text>

      {/* Tree list */}
      <box flexDirection="column" paddingLeft={1} paddingTop={1} flexGrow={1} overflow="scroll">
        {items.map((item) => {
          const { isSelected } = item;

          if (item.type === 'project') {
            return (
              <text key={`project-${item.name}`} fg={COLORS.project} height={1}>
                {`${item.name.toUpperCase()} (${item.workspaceCount})`}
              </text>
            );
          }

          if (item.type === 'workspace') {
            const ws = item.workspace;
            const textColor = isSelected ? COLORS.selected : ws.isStale ? COLORS.stale : COLORS.workspace;
            const arrow = item.expanded ? '▼' : '▶';
            const prefix = isSelected ? '>' : ' ';
            const branchInfo = ws.branch ? ` [${ws.branch}]` : '';
            const sessionInfo = ws.sessionCount > 0 ? ` (${ws.sessionCount})` : '';

            return (
              <box key={`ws-${ws.id}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix} {arrow} {ws.name}</text>
                {ws.branch && <text fg={COLORS.branch}>{branchInfo}</text>}
                {ws.sessionCount > 0 && <text fg={COLORS.sessionCount}>{sessionInfo}</text>}
              </box>
            );
          }

          if (item.type === 'session') {
            const session = item.session;
            const textColor = isSelected ? COLORS.selected : session.attached ? COLORS.sessionAttached : COLORS.session;
            const indicator = session.attached ? '○' : '●';
            const indicatorColor = session.attached ? COLORS.sessionAttached : COLORS.sessionCount;
            const displayName = session.name.split(':').pop() || session.name;
            const prefix = isSelected ? '>' : ' ';
            const processInfo = session.processTitle ? ` [${session.processTitle}]` : '';
            const timeInfo = session.attached ? '(attached)' : formatTime(session.createdAt);

            return (
              <box key={`session-${session.id}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix}   </text>
                <text fg={indicatorColor}>{indicator}</text>
                <text fg={textColor}> {displayName}</text>
                {session.processTitle && <text fg={COLORS.sessionAttached}>{processInfo}</text>}
                <text fg={COLORS.textDim}> {timeInfo}</text>
              </box>
            );
          }

          if (item.type === 'replay-section') {
            const textColor = isSelected ? COLORS.selected : '#8B949E';
            const prefix = isSelected ? '>' : ' ';
            const arrow = item.expanded ? '▾' : '▸';
            return (
              <box key={`replay-section-${item.workspaceId}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix}   {arrow} </text>
                <text fg={textColor}>History</text>
                <text fg={COLORS.textDim}> ({item.count})</text>
              </box>
            );
          }

          if (item.type === 'orphaned-replay-section') {
            const textColor = isSelected ? COLORS.selected : '#D29922';
            const prefix = isSelected ? '>' : ' ';
            const arrow = item.expanded ? '▾' : '▸';
            return (
              <box key={`orphaned-replay-section-${item.projectName}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix}   {arrow} </text>
                <text fg={textColor}>Orphaned History</text>
                <text fg={COLORS.textDim}> ({item.count})</text>
              </box>
            );
          }

          if (item.type === 'replay') {
            const replay = item.replay;
            const textColor = isSelected ? COLORS.selected : replay.status === 'crashed' ? '#FF8888' : '#6CB6FF';
            const prefix = isSelected ? '>' : ' ';
            const statusLabel = replay.status === 'crashed' ? 'crashed' : 'replay';
            const timeInfo = replay.endedAt ? formatTime(replay.endedAt) : formatTime(replay.startedAt);
            const dismissedMark = replay.dismissedAt ? ' [hidden]' : '';

            return (
              <box key={`replay-${replay.replayId}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix}     ↺ {replay.sessionName}</text>
                <text fg={COLORS.textDim}> ({statusLabel}, {timeInfo}{dismissedMark})</text>
              </box>
            );
          }

          if (item.type === 'process') {
            const statusIcon = item.status === 'running' ? '▶' : item.status === 'failed' ? '✗' : '■';
            const statusColor = item.status === 'running' ? '#00FF00' : item.status === 'failed' ? '#FF4444' : COLORS.textDim;
            const textColor = isSelected ? COLORS.selected : COLORS.text;
            const prefix = isSelected ? '>' : ' ';
            const portInfo = item.ports?.length ? ` :${item.ports.map(p => p.port).join(',')}` : '';

            return (
              <box key={`process-${item.workspaceId}-${item.processName}-${item.instance}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix}   </text>
                <text fg={statusColor}>{statusIcon}</text>
                <text fg={textColor}> {item.processName}#{item.instance}</text>
                {portInfo && <text fg={COLORS.textDim}>{portInfo}</text>}
                <text fg={statusColor}> ({item.status})</text>
              </box>
            );
          }

          if (item.type === 'process-disabled') {
            const textColor = isSelected ? COLORS.selected : '#D29922';
            const prefix = isSelected ? '>' : ' ';
            return (
              <box key={`process-disabled-${item.workspaceId}-${item.processName}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix}   </text>
                <text fg="#D29922">⏸</text>
                <text fg={textColor}> {item.processName} (disabled)</text>
              </box>
            );
          }

          if (item.type === 'edit-processes') {
            const textColor = isSelected ? COLORS.selected : '#FFAA55';
            const prefix = isSelected ? '>' : ' ';
            return (
              <text key={`edit-processes-${item.workspaceId}`} fg={textColor} height={1}>
                {prefix}   ⚙ Edit Processes Config
              </text>
            );
          }

          if (item.type === 'bundle-config') {
            const textColor = isSelected ? COLORS.selected : '#58A6FF';
            const prefix = isSelected ? '>' : ' ';
            return (
              <text key={`bundle-config-${item.workspaceId}`} fg={textColor} height={1}>
                {prefix}   ◇ Edit Bundle Config
              </text>
            );
          }

          if (item.type === 'agents') {
            const textColor = isSelected ? COLORS.selected : '#C678DD';
            const prefix = isSelected ? '>' : ' ';
            const arrow = item.expanded ? '▾' : '▸';
            const count = (item.count ?? 0) > 0 ? ` (${item.count})` : '';
            const permBadge = (item.pendingPermissions ?? 0) > 0 ? ` ⚡${item.pendingPermissions}` : '';
            return (
              <text key={`agents-${item.workspaceId}`} fg={textColor} height={1}>
                {prefix}   {arrow} ✦ Agent Sessions{count}{permBadge}
              </text>
            );
          }

          if (item.type === 'agent-session') {
            const textColor = isSelected ? COLORS.selected : item.session.closed ? COLORS.textDim : '#C678DD';
            const prefix = isSelected ? '>' : ' ';
            const state = getAgentSessionDisplayState(item.session);
            const label = getAgentSessionDisplayLabel(item.session);
            const signal =
              state === 'closed' ? '■'
              : state === 'needs-permission' ? '⚡'
              : state === 'error' ? '!'
              : state === 'running' ? '●'
              : state === 'retrying' ? '↻'
              : '◦';
            const timeInfo = item.session.updatedAt ? formatTime(new Date(item.session.updatedAt).getTime()) : '';
            return (
              <box key={`agent-session-${item.workspaceId}-${item.session.id}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix}     ✦ {item.session.title}</text>
                <text fg={COLORS.textDim}> {signal} {label}</text>
                {timeInfo && <text fg={COLORS.textDim}> {timeInfo}</text>}
              </box>
            );
          }

          if (item.type === 'new-agent-session') {
            const textColor = isSelected ? COLORS.selected : '#C678DD';
            return (
              <text key={`new-agent-${item.workspaceId}`} fg={textColor} height={1}>
                {isSelected ? '>' : ' '}     + New Agent Session
              </text>
            );
          }

          if (item.type === 'process-config-error') {
            const textColor = isSelected ? COLORS.selected : '#FF6666';
            const prefix = isSelected ? '>' : ' ';
            return (
              <text key={`process-config-error-${item.workspaceId}`} fg={textColor} height={1}>
                {prefix}   ⚠ Invalid processes config
              </text>
            );
          }

          if (item.type === 'events') {
            const textColor = isSelected ? COLORS.selected : '#AA88FF';
            const prefix = isSelected ? '>' : ' ';
            return (
              <text key={`events-${item.workspaceId}`} fg={textColor} height={1}>
                {prefix}   ◆ Events
              </text>
            );
          }

          if (item.type === 'new-session') {
            const textColor = isSelected ? COLORS.selected : COLORS.newSession;
            return (
              <text key={`new-${item.workspaceId}`} fg={textColor} height={1}>
                {isSelected ? '>' : ' '}   + New Session
              </text>
            );
          }

          return null;
        })}
      </box>

      {/* Footer hint */}
      <text fg={COLORS.textDim} height={1} paddingLeft={1}>
        {getSpacesBrowserHint(selectedItem)}
      </text>
    </box>
  );
}
