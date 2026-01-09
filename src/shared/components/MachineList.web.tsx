/** @jsxImportSource react */
/**
 * MachineList - Web Display Component
 *
 * Dumb presentational component for web.
 * Receives all state and actions from useMachineList hook.
 */

import { useState } from 'react';
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

  const [commandCopied, setCommandCopied] = useState(false);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 px-4">
        <div className="text-gray-400 text-center">Connecting to relay...</div>
      </div>
    );
  }

  // Error state
  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 px-4">
        <div className="text-red-400 text-center">{error}</div>
        <button
          onClick={refresh}
          className="px-6 py-3 text-base bg-gray-700 hover:bg-gray-600 active:bg-gray-500 rounded-lg min-h-[48px]"
        >
          Retry
        </button>
      </div>
    );
  }

  // Empty state
  if (isEmpty) {
    const accessCommand = `gssh access add "${publicKey || '...'}"`;

    const copyCommand = () => {
      if (publicKey) {
        navigator.clipboard.writeText(accessCommand);
        setCommandCopied(true);
        setTimeout(() => setCommandCopied(false), 2000);
      }
    };

    return (
      <div className="flex flex-col items-center justify-center h-full py-8 sm:py-12 gap-6 px-4">
        <div className="text-gray-400 text-lg text-center">No machines available</div>

        <div className="text-center w-full max-w-xl">
          <p className="text-gray-500 text-sm mb-3">
            To connect, run this command on your machine:
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-gray-800 rounded-lg p-3">
            <code className="flex-1 text-yellow-400 px-2 py-2 font-mono text-xs sm:text-sm break-all text-left">
              {accessCommand}
            </code>
            <button
              onClick={copyCommand}
              className="px-4 py-3 text-sm bg-gray-700 hover:bg-gray-600 active:bg-gray-500 rounded-lg whitespace-nowrap min-h-[48px]"
            >
              {commandCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>

        {publicKey && (
          <details className="text-center w-full max-w-xl">
            <summary className="text-gray-500 text-xs cursor-pointer hover:text-gray-400 py-2">
              Show public key
            </summary>
            <code className="text-green-400 bg-gray-900 px-3 py-2 rounded font-mono text-xs break-all block mt-2">
              {publicKey}
            </code>
          </details>
        )}

        <button
          onClick={refresh}
          className="px-6 py-3 text-base bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg min-h-[48px]"
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
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="text-lg font-medium text-white">Machines</h2>
        <button
          onClick={refresh}
          className="text-sm text-gray-400 hover:text-white active:text-blue-400 px-3 py-2 -mr-3 min-h-[44px] flex items-center"
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
                px-4 py-4 cursor-pointer border-b border-gray-800 min-h-[60px]
                ${isSelected ? 'bg-gray-700' : 'hover:bg-gray-800 active:bg-gray-700'}
                ${!isConnectable ? 'opacity-50' : ''}
              `}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* Status indicator */}
                  <div
                    className={`w-3 h-3 rounded-full flex-shrink-0 ${
                      statusColor === 'green' ? 'bg-green-500' :
                      statusColor === 'yellow' ? 'bg-yellow-500' :
                      statusColor === 'red' ? 'bg-red-500' :
                      'bg-gray-500'
                    }`}
                  />
                  {/* Machine name */}
                  <div className="min-w-0">
                    <div className="text-white font-medium truncate">
                      {getMachineLabel(machine)}
                    </div>
                    {machine.label && (
                      <div className="text-xs text-gray-500 font-mono truncate">
                        {machine.machineId}
                      </div>
                    )}
                  </div>
                </div>

                {/* Status text and connect button on mobile */}
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="text-sm text-gray-400 hidden sm:block">
                    {machine.online ? 'Online' : 'Offline'}
                  </div>
                  {isConnectable && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        selectIndex(index);
                        connectSelected();
                      }}
                      className="sm:hidden px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded text-white"
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
      <div className="px-4 py-2 border-t border-gray-700 safe-bottom">
        {/* Desktop keyboard hints */}
        <div className="hidden sm:flex gap-4 text-xs text-gray-500">
          <span>↑↓ Navigate</span>
          <span>Enter Connect</span>
          <span>r Refresh</span>
        </div>
        {/* Mobile hint */}
        <div className="sm:hidden text-xs text-gray-500 text-center">
          Tap a machine to connect
        </div>
      </div>
    </div>
  );
}
