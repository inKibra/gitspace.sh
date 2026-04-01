/** @jsxImportSource react */
/**
 * MachineList - Web Display Component
 *
 * Dumb presentational component for web.
 * Receives all state and actions from useMachineList hook.
 */

import type { UseMachineListReturn } from './MachineList.js';
import { getStatusColor, getMachineLabel } from './MachineList.js';

// ============================================================================
// Component
// ============================================================================

export function MachineListWeb(props: UseMachineListReturn) {
  const {
    items,
    error,
    publicKey,
    isLoading,
    isEmpty,
    hasError,
    selectIndex,
    connectSelected,
    refresh,
  } = props;

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 px-4">
        <div className="text-[var(--gs-text-muted)] text-center">Connecting to relay...</div>
      </div>
    );
  }

  // Error state
  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 px-4">
        <div className="text-[var(--gs-danger)] text-center">{error}</div>
        <button
          onClick={refresh}
          className="px-6 py-3 text-base bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] active:bg-[var(--gs-bg-elevated)] border border-[var(--gs-border)] rounded-lg min-h-[48px] text-[var(--gs-text)]"
        >
          Retry
        </button>
      </div>
    );
  }

  // Empty state
  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-8 sm:py-12 gap-6 px-4">
        <div className="text-[var(--gs-text-muted)] text-lg text-center">No machines available</div>

        <div className="text-center w-full max-w-xl">
          <p className="text-[var(--gs-text-dim)] text-sm mb-3">
            Owner-only access is enabled. Use the same owner identity on this client and your machine.
          </p>
        </div>

        {publicKey && (
          <details className="text-center w-full max-w-xl">
            <summary className="text-[var(--gs-text-dim)] text-xs cursor-pointer hover:text-[var(--gs-text-muted)] py-2">
              Show browser user-root key
            </summary>
            <code className="text-[var(--gs-success)] bg-[var(--gs-bg)] border border-[var(--gs-border)] px-3 py-2 rounded font-mono text-xs break-all block mt-2">
              {publicKey}
            </code>
          </details>
        )}

        <button
          onClick={refresh}
          className="px-6 py-3 text-base bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium shadow-glow rounded-lg min-h-[48px]"
        >
          Refresh
        </button>
      </div>
    );
  }

  // Machine list
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
        <h2 className="text-lg font-medium text-[var(--gs-text)]">Machines</h2>
        <button
          onClick={refresh}
          className="text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] active:text-[var(--gs-accent)] px-3 py-2 -mr-3 min-h-[44px] flex items-center"
        >
          Refresh
        </button>
      </div>

      {/* Machine list */}
      <div className="flex-1 overflow-y-auto">
        {items.map((item, index) => {
          const { machine, isSelected, isConnectable } = item;
          const statusColor = getStatusColor(machine);

          return (
            <div
              key={machine.machineId}
              onClick={() => {
                selectIndex(index);
                // On touch devices, single tap connects (since double-tap is awkward)
                if (isConnectable && 'ontouchstart' in window) {
                  connectSelected();
                }
              }}
              onDoubleClick={() => isConnectable && connectSelected()}
              className={`
                px-4 py-4 cursor-pointer border-b border-[var(--gs-border)] min-h-[60px]
                ${isSelected ? 'bg-[var(--gs-bg-active)]' : 'hover:bg-[var(--gs-bg-elevated)] active:bg-[var(--gs-bg-active)]'}
                ${!isConnectable ? 'opacity-50' : ''}
              `}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Status indicator */}
                  <div
                    className={`w-3 h-3 rounded-full flex-shrink-0 ${
                      statusColor === 'green' ? 'bg-[var(--gs-success)] shadow-glow' :
                      statusColor === 'yellow' ? 'bg-[var(--gs-warning)]' :
                      statusColor === 'red' ? 'bg-[var(--gs-danger)]' :
                      'bg-[var(--gs-text-dim)]'
                    }`}
                  />
                  {/* Machine name */}
                  <div className="min-w-0">
                    <div className="text-[var(--gs-text)] font-medium truncate">
                      {getMachineLabel(machine)}
                    </div>
                    {machine.label && (
                      <div className="text-xs text-[var(--gs-text-muted)] font-mono truncate">
                        {machine.machineId}
                      </div>
                    )}
                  </div>
                </div>

                {/* Status text and connect button on mobile */}
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="text-sm text-[var(--gs-text-muted)] hidden sm:block">
                    {machine.online ? 'Online' : 'Offline'}
                  </div>
                  {isConnectable && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        selectIndex(index);
                        connectSelected();
                      }}
                      className="sm:hidden px-3 py-1.5 text-sm bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium rounded shadow-glow"
                    >
                      Connect
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer - keyboard hints on desktop, action buttons on mobile */}
      <div className="px-4 py-2 border-t border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] safe-bottom">
        {/* Desktop keyboard hints */}
        <div className="hidden sm:flex gap-4 text-xs text-[var(--gs-text-dim)]">
          <span>↑↓ Navigate</span>
          <span>Enter Connect</span>
          <span>r Refresh</span>
        </div>
        {/* Mobile hint */}
        <div className="sm:hidden text-xs text-[var(--gs-text-dim)] text-center">
          Tap a machine to connect
        </div>
      </div>
    </div>
  );
}
