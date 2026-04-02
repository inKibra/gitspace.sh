/** @jsxImportSource @opentui/react */
/**
 * Inbox - TUI Display Component
 *
 * Dumb presentational component for OpenTUI.
 * Receives all state and actions from useInbox hook.
 */

import type { UseInboxReturn } from './Inbox.js';
import {
  parseSessionName,
  getInboxIcon,
  getInboxTypeLabel,
  formatTimeAgo,
} from './Inbox.js';

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
  statusBar: '#333333',
  loading: '#FFAA00',
  project: '#00FF88',
  workspace: '#FFAA00',
  session: '#888888',
  unread: '#FFFFFF',
  read: '#666666',
};

// ============================================================================
// Props
// ============================================================================

interface InboxTUIProps extends UseInboxReturn {
  focused?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function InboxTUI(props: InboxTUIProps) {
  const {
    displayItems,
    flatItems,
    selectedIndex,
    viewingSessionId,
    sessionThreadItems,
    unreadCount,
    isEmpty,
    isViewingThread,
    focused = true,
  } = props;

  // Thread detail view
  if (isViewingThread && viewingSessionId) {
    const sessionName = sessionThreadItems[0]?.sessionName;
    const sessionParts = sessionName ? parseSessionName(sessionName) : null;
    const sessionLabel = sessionParts
      ? `${sessionParts.project} / ${sessionParts.workspace} / ${sessionParts.session}`
      : 'Session';
    const maxLinesPerItem = 8;

    return (
      <box flexDirection="column" width="100%" height="100%">
        <box
          flexDirection="column"
          border
          borderStyle="single"
          borderColor={focused ? COLORS.borderFocused : COLORS.border}
          flexGrow={1}
          margin={1}
        >
          <text fg={COLORS.title} paddingLeft={1} height={1}>
            {` 📥 ${sessionLabel}${sessionThreadItems.length > 0 ? ` (${sessionThreadItems.length} notification${sessionThreadItems.length > 1 ? 's' : ''})` : ''} `}
          </text>
          <box flexDirection="column" padding={1} flexGrow={1} overflow="scroll">
            {sessionThreadItems.length > 0 ? (
              sessionThreadItems.map((item, itemIdx) => {
                const timeAgo = formatTimeAgo(item.timestamp);
                const typeLabel = getInboxTypeLabel(item);
                const icon = getInboxIcon(item);
                const lines = item.context.split('\n');
                const previewLines = lines.slice(0, maxLinesPerItem);
                const remainingLines = Math.max(0, lines.length - previewLines.length);

                return (
                  <box
                    key={item.id}
                    flexDirection="column"
                    marginBottom={itemIdx === sessionThreadItems.length - 1 ? 0 : 1}
                  >
                    <text fg={COLORS.title} height={1}>
                      {icon} {typeLabel} · {timeAgo}
                    </text>
                    {item.processTitle && (
                      <text fg={COLORS.loading} height={1}>
                        Process: {item.processTitle}
                      </text>
                    )}
                    <box flexDirection="column" paddingLeft={1} marginTop={1}>
                      {previewLines.map((line, lineIdx) => (
                        <text key={lineIdx} fg={COLORS.textDim} height={1}>
                          {line}
                        </text>
                      ))}
                      {remainingLines > 0 && (
                        <text fg={COLORS.textDim} height={1}>
                          ... ({remainingLines} more lines)
                        </text>
                      )}
                    </box>
                  </box>
                );
              })
            ) : (
              <text fg={COLORS.textDim} height={1}>
                No notifications for this session.
              </text>
            )}
          </box>
        </box>
        <box width="100%" height={1} backgroundColor={COLORS.statusBar}>
          <text fg={COLORS.textDim}>
            {' '}[a] Attach to session  [x] Delete  [Esc] Back to list
          </text>
        </box>
      </box>
    );
  }

  // Empty state
  if (isEmpty) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        <box
          flexDirection="column"
          border
          borderStyle="single"
          borderColor={focused ? COLORS.borderFocused : COLORS.border}
          flexGrow={1}
          margin={1}
        >
          <text fg={COLORS.title} paddingLeft={1} height={1}>
            {' '}📥 INBOX{' '}
          </text>
          <box
            flexDirection="column"
            padding={1}
            flexGrow={1}
            justifyContent="center"
            alignItems="center"
          >
            <text fg={COLORS.textDim}>No notifications</text>
          </box>
        </box>
        <box width="100%" height={1} backgroundColor={COLORS.statusBar}>
          <text fg={COLORS.textDim}> [Esc] Back</text>
        </box>
      </box>
    );
  }

  // List view
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={focused ? COLORS.borderFocused : COLORS.border}
        flexGrow={1}
        margin={1}
      >
        <text fg={COLORS.title} paddingLeft={1} height={1}>
          {` 📥 INBOX ${unreadCount > 0 ? `(${unreadCount} unread)` : ''} `}
        </text>
        <box flexDirection="column" padding={1} flexGrow={1} overflow="scroll">
          {displayItems.map((displayItem, displayIdx) => {
            if (displayItem.type === 'project-header') {
              return (
                <box key={`project-${displayItem.project}`} flexDirection="column">
                  {displayIdx > 0 && <text height={1}> </text>}
                  <text fg={COLORS.project} height={1}>
                    ┌─ 📁 {displayItem.project} ({displayItem.totalItems}{' '}
                    notification{displayItem.totalItems > 1 ? 's' : ''})
                  </text>
                </box>
              );
            }

            if (displayItem.type === 'workspace-header') {
              return (
                <box key={`workspace-${displayItem.workspace}`} flexDirection="column">
                  {!displayItem.isFirstWorkspace && (
                    <text fg={COLORS.border} height={1}>
                      │
                    </text>
                  )}
                  <text fg={COLORS.workspace} height={1}>
                    │  ┌─ 📂 {displayItem.workspace}
                  </text>
                </box>
              );
            }

            if (displayItem.type === 'session-header') {
              return (
                <box key={`session-${displayItem.session}`} flexDirection="column">
                  <text fg={COLORS.session} height={1}>
                    │  │  ├─ 💻 {displayItem.session}
                  </text>
                </box>
              );
            }

            // Item
            const { item } = displayItem;
            const isSelected = displayItem.flatIndex === selectedIndex;
            const timeAgo = formatTimeAgo(item.timestamp);
            const icon = getInboxIcon(item);
            const readIndicator = item.read ? ' ' : '•';
            const prefix = isSelected ? '▶' : ' ';
            const processInfo = item.processTitle || '';
            const context = item.context.split('\n')[0].substring(0, 40);

            return (
              <box key={item.id} flexDirection="column">
                <text
                  fg={isSelected ? COLORS.selected : item.read ? COLORS.read : COLORS.unread}
                  height={1}
                >
                  │  │  │   {prefix}
                  {readIndicator} {icon} {processInfo}
                  {processInfo ? ' · ' : ''}
                  {timeAgo}
                </text>
                <text
                  fg={isSelected ? COLORS.selected : COLORS.textDim}
                  height={1}
                >
                  │  │  │      {context}
                </text>
              </box>
            );
          })}
        </box>
      </box>
      <box width="100%" height={1} backgroundColor={COLORS.statusBar}>
        <text fg={COLORS.textDim}>
          {' '}[↑↓] Navigate  [Enter] View  [x] Delete  [c] Clear all  [Esc] Back
        </text>
      </box>
    </box>
  );
}
