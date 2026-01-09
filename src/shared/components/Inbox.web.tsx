/** @jsxImportSource react */
/**
 * Inbox - Web Display Component
 *
 * Dumb presentational component for web.
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
// Component
// ============================================================================

export function InboxWeb(props: UseInboxReturn) {
  const {
    displayItems,
    selectedIndex,
    viewingSessionId,
    sessionThreadItems,
    unreadCount,
    isEmpty,
    isViewingThread,
    selectIndex,
    openThread,
    closeThread,
    deleteSelected,
    deleteThread,
    clearAll,
    attachToSession,
    close,
  } = props;

  // Thread detail view
  if (isViewingThread && viewingSessionId) {
    const sessionName = sessionThreadItems[0]?.sessionName;
    const sessionParts = sessionName ? parseSessionName(sessionName) : null;
    const sessionLabel = sessionParts
      ? `${sessionParts.project} / ${sessionParts.workspace} / ${sessionParts.session}`
      : 'Session';

    return (
      <div className="h-full flex flex-col bg-gray-900">
        <Header
          title={`📥 ${sessionLabel}`}
          subtitle={
            sessionThreadItems.length > 0
              ? `${sessionThreadItems.length} notification${sessionThreadItems.length > 1 ? 's' : ''}`
              : undefined
          }
          onBack={closeThread}
        />

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {sessionThreadItems.length > 0 ? (
            sessionThreadItems.map((item) => {
              const timeAgo = formatTimeAgo(item.timestamp);
              const typeLabel = getInboxTypeLabel(item);
              const icon = getInboxIcon(item);
              const lines = item.context.split('\n').slice(0, 10);
              const remainingLines = Math.max(0, item.context.split('\n').length - 10);

              return (
                <div key={item.id} className="border border-gray-700 rounded p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-lg">{icon}</span>
                    <span className="text-white font-medium">{typeLabel}</span>
                    <span className="text-gray-500">·</span>
                    <span className="text-gray-400 text-sm">{timeAgo}</span>
                  </div>
                  {item.processTitle && (
                    <div className="text-yellow-400 text-sm mb-2">
                      Process: {item.processTitle}
                    </div>
                  )}
                  <div className="bg-gray-800 rounded p-2 font-mono text-sm text-gray-300">
                    {lines.map((line, idx) => (
                      <div key={idx}>{line}</div>
                    ))}
                    {remainingLines > 0 && (
                      <div className="text-gray-500">
                        ... ({remainingLines} more lines)
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-gray-400 text-center py-8">
              No notifications for this session.
            </div>
          )}
        </div>

        <Footer
          items={[
            { key: 'a', label: 'Attach', onClick: attachToSession },
            { key: 'x', label: 'Delete All', onClick: deleteThread },
            { key: 'Esc', label: 'Back', onClick: closeThread },
          ]}
        />
      </div>
    );
  }

  // Empty state
  if (isEmpty) {
    return (
      <div className="h-full flex flex-col bg-gray-900">
        <Header title="📥 Inbox" onBack={close} />
        <div className="flex-1 flex items-center justify-center text-gray-400">
          No notifications
        </div>
        <Footer items={[{ key: 'Esc', label: 'Back', onClick: close }]} />
      </div>
    );
  }

  // List view
  return (
    <div className="h-full flex flex-col bg-gray-900">
      <Header
        title="📥 Inbox"
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : undefined}
        onBack={close}
        actions={[
          { label: 'Clear All', onClick: clearAll },
        ]}
      />

      <div className="flex-1 overflow-y-auto">
        {displayItems.map((displayItem, displayIdx) => {
          if (displayItem.type === 'project-header') {
            return (
              <div
                key={`project-${displayIdx}-${displayItem.project}`}
                className="px-4 py-3 bg-gray-800 border-b border-gray-700 text-green-400 font-medium min-h-[44px] flex items-center"
              >
                📁 {displayItem.project}
                <span className="text-gray-500 text-sm ml-2">
                  ({displayItem.totalItems})
                </span>
              </div>
            );
          }

          if (displayItem.type === 'workspace-header') {
            return (
              <div
                key={`workspace-${displayIdx}-${displayItem.workspace}`}
                className="px-5 sm:px-6 py-2 bg-gray-850 text-yellow-400 text-sm min-h-[36px] flex items-center"
              >
                📂 {displayItem.workspace}
              </div>
            );
          }

          if (displayItem.type === 'session-header') {
            return (
              <div
                key={`session-${displayIdx}-${displayItem.session}`}
                className="px-6 sm:px-8 py-1.5 text-gray-500 text-xs min-h-[28px] flex items-center"
              >
                💻 {displayItem.session}
              </div>
            );
          }

          // Item
          const { item } = displayItem;
          const isSelected = displayItem.flatIndex === selectedIndex;
          const timeAgo = formatTimeAgo(item.timestamp);
          const icon = getInboxIcon(item);
          const processInfo = item.processTitle || '';
          const context = item.context.split('\n')[0].substring(0, 60);

          return (
            <div
              key={item.id}
              onClick={() => {
                selectIndex(displayItem.flatIndex);
                openThread();
              }}
              className={`
                px-4 sm:px-10 py-3 cursor-pointer border-b border-gray-800 flex items-start gap-3 min-h-[56px]
                ${isSelected ? 'bg-blue-600 border-l-4 border-l-blue-400 text-white' : 'hover:bg-gray-800 active:bg-gray-700'}
              `}
            >
              <div className="flex-shrink-0 flex items-center gap-2 pt-0.5">
                {!item.read && (
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                )}
                <span className="text-lg">{icon}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm flex-wrap">
                  {processInfo && (
                    <span className="text-yellow-400 truncate max-w-[150px]">{processInfo}</span>
                  )}
                  <span className="text-gray-500 flex-shrink-0">{timeAgo}</span>
                </div>
                <div className="text-gray-400 text-sm truncate">{context}</div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  selectIndex(displayItem.flatIndex);
                  deleteSelected();
                }}
                className="text-gray-600 hover:text-red-400 active:text-red-500 p-2 -mr-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <Footer
        items={[
          { key: '↑↓', label: 'Navigate' },
          { key: 'Enter', label: 'View' },
          { key: 'x', label: 'Delete', onClick: deleteSelected },
          { key: 'c', label: 'Clear All', onClick: clearAll },
          { key: 'Esc', label: 'Back', onClick: close },
        ]}
      />
    </div>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function Header({
  title,
  subtitle,
  onBack,
  actions,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  actions?: Array<{ label: string; onClick: () => void }>;
}) {
  return (
    <div className="bg-gray-800 px-4 py-3 flex items-center justify-between border-b border-gray-700 min-h-[52px] gap-2">
      <div className="flex items-center gap-2 sm:gap-4 min-w-0 flex-1">
        <button
          onClick={onBack}
          className="text-sm text-gray-400 hover:text-white active:text-blue-400 py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
        >
          ← <span className="hidden sm:inline ml-1">Back</span>
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white font-medium truncate">{title}</span>
          {subtitle && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-900 text-blue-300 flex-shrink-0">
              {subtitle}
            </span>
          )}
        </div>
      </div>
      {actions && actions.length > 0 && (
        <div className="flex gap-2 flex-shrink-0">
          {actions.map((action, idx) => (
            <button
              key={idx}
              onClick={action.onClick}
              className="text-sm text-gray-400 hover:text-white active:text-blue-400 py-2 px-2 min-h-[44px] flex items-center"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Footer({
  items,
}: {
  items: Array<{ key: string; label: string; onClick?: () => void }>;
}) {
  // Filter to only clickable items for mobile
  const clickableItems = items.filter(item => item.onClick);

  return (
    <div className="bg-gray-800 px-4 py-2 border-t border-gray-700 safe-bottom">
      {/* Desktop keyboard hints */}
      <div className="hidden sm:flex gap-4 text-xs text-gray-500 flex-wrap">
        {items.map((item, idx) => (
          <span key={idx}>
            {item.onClick ? (
              <button onClick={item.onClick} className="hover:text-white">
                {item.key} {item.label}
              </button>
            ) : (
              <>
                {item.key} {item.label}
              </>
            )}
          </span>
        ))}
      </div>
      {/* Mobile action buttons */}
      <div className="sm:hidden flex justify-center gap-4">
        {clickableItems.map((item, idx) => (
          <button
            key={idx}
            onClick={item.onClick}
            className="px-4 py-2 text-sm text-gray-400 hover:text-white active:text-blue-400"
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
