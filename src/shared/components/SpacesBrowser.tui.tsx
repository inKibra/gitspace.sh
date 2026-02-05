/**
 * SpacesBrowser - TUI Display Component
 *
 * Dumb presentational component for OpenTUI.
 * Receives all state and actions from useSpacesBrowser hook.
 */

import type { UseSpacesBrowserReturn } from './SpacesBrowser.js';
import { formatTime } from './SpacesBrowser.js';

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
// Component
// ============================================================================

export function SpacesBrowserTUI(props: SpacesBrowserTUIProps) {
  const {
    items,
    machineName,
    isEmpty,
    focused = true,
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
                {item.name.toUpperCase()} ({item.workspaceCount})
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

          if (item.type === 'process') {
            const textColor = isSelected ? COLORS.selected : COLORS.session;
            const indicator = item.status === 'running' ? '●' : item.status === 'failed' ? '×' : '○';
            const indicatorColor = item.status === 'running' ? COLORS.sessionCount : item.status === 'failed' ? COLORS.sessionAttached : COLORS.textDim;
            const prefix = isSelected ? '>' : ' ';
            const statusLabel = item.status;

            return (
              <box key={`proc-${item.workspaceId}-${item.processName}-${item.instance}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix}   </text>
                <text fg={indicatorColor}>{indicator}</text>
                <text fg={textColor}> {item.processName}#{item.instance}</text>
                <text fg={COLORS.textDim}> [{statusLabel}]</text>
              </box>
            );
          }

          if (item.type === 'session') {
            const session = item.session;
            const textColor = isSelected ? COLORS.selected : session.attached ? COLORS.sessionAttached : COLORS.session;
            const indicator = session.attached ? '○' : '●';
            const indicatorColor = session.attached ? COLORS.sessionAttached : COLORS.sessionCount;
            const displayName = session.processName
              ? `${session.processName}#${session.processInstance ?? 1}`
              : session.name.split(':').pop() || session.name;
            const prefix = isSelected ? '>' : ' ';
            const processInfo = session.processTitle ? ` [${session.processTitle}]` : '';
            const runnerInfo = session.processName ? ' [runner]' : '';
            const timeInfo = session.attached ? '(attached)' : formatTime(session.createdAt);

            return (
              <box key={`session-${session.id}`} flexDirection="row" height={1}>
                <text fg={textColor}>{prefix}   </text>
                <text fg={indicatorColor}>{indicator}</text>
                <text fg={textColor}> {displayName}</text>
                {session.processTitle && <text fg={COLORS.sessionAttached}>{processInfo}</text>}
                {session.processName && <text fg={COLORS.textDim}>{runnerInfo}</text>}
                <text fg={COLORS.textDim}> {timeInfo}</text>
              </box>
            );
          }

          if (item.type === 'events') {
            const textColor = isSelected ? COLORS.selected : COLORS.textDim;
            return (
              <text key={`events-${item.workspaceId}`} fg={textColor} height={1}>
                {isSelected ? '>' : ' '}   ▸ Events
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
        [↑↓] Navigate  [Enter] Select  [s] Start  [x] Stop  [n] New  [r] Refresh  [q] Back
      </text>
    </box>
  );
}
