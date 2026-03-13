/**
 * MachineList - TUI Display Component
 *
 * Dumb presentational component for OpenTUI.
 * Receives all state and actions from useMachineList hook.
 */

import type { UseMachineListReturn } from './MachineList.js';
import { getStatusColor, getMachineLabel, formatLastSeen } from './MachineList.js';

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
  online: '#00FF00',
  offline: '#FF4444',
};

// ============================================================================
// Props
// ============================================================================

interface MachineListTUIProps extends UseMachineListReturn {
  focused?: boolean;
  relayLabel?: string;
  relayError?: string | null;
  isAutoConnected?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function MachineListTUI(props: MachineListTUIProps) {
  const {
    items,
    publicKey,
    copied,
    isLoading,
    isEmpty,
    hasError,
    error,
    focused = true,
    relayLabel,
    relayError,
    isAutoConnected = false,
  } = props;

  // Loading state without fallback machines
  if (isLoading && items.length === 0) {
    return (
      <box
        flexGrow={1}
        border
        borderStyle="single"
        borderColor={focused ? COLORS.borderFocused : COLORS.border}
        justifyContent="center"
        alignItems="center"
      >
        <text fg={COLORS.textDim}>Connecting to relay...</text>
      </box>
    );
  }

  // Error state without fallback machines
  if (hasError && items.length === 0) {
    return (
      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={COLORS.border}
        justifyContent="center"
        alignItems="center"
      >
        <text fg="#FF4444">{error || 'Connection failed'}</text>
        <text fg={COLORS.textDim} paddingTop={1}>[r] Retry</text>
      </box>
    );
  }

  // Empty state
  if (isEmpty) {
    return (
      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={focused ? COLORS.borderFocused : COLORS.border}
        paddingLeft={2}
        paddingTop={1}
      >
        <text fg={COLORS.title}> Machines </text>
        <text fg={COLORS.textDim} paddingTop={1}>No machines available</text>
        {publicKey && (
          <box flexDirection="column" paddingTop={2}>
            <text fg={COLORS.textDim}>Your public key:</text>
            <text fg={COLORS.online} paddingTop={1}>
              {publicKey.slice(0, 40)}...
            </text>
            <text fg={COLORS.textDim} paddingTop={1}>
              {copied ? '[Copied!]' : '[c] Copy key'}
            </text>
          </box>
        )}
        <text fg={COLORS.textDim} paddingTop={2}>
          Owner-only access is enabled.
        </text>
        <text fg={COLORS.textDim}>
          Use the owner identity on both client and machine.
        </text>
      </box>
    );
  }

  // Machine list
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
        {' '}Machines ({items.length}){' '}
      </text>

      {(relayLabel || relayError) && (
        <box flexDirection="column" paddingLeft={1} paddingTop={1}>
          <text fg={COLORS.textDim}>
            {isAutoConnected ? 'Auto-connected relay' : 'Relay'}: {relayLabel ?? 'configured'}
          </text>
          {!!relayError && <text fg={COLORS.offline}>Remote listing unavailable - {relayError}</text>}
          {!!relayError && <text fg={COLORS.textDim}>You can still enter local projects from "This Machine".</text>}
        </box>
      )}

      {/* Machine list */}
      <box flexDirection="column" paddingLeft={1} paddingTop={1} flexGrow={1} overflow="scroll">
        {items.map((item) => {
          const { machine, isSelected, isConnectable } = item;
          const statusColor = getStatusColor(machine);
          const textColor = isSelected ? COLORS.selected : COLORS.text;
          const indicator = statusColor === 'green' ? '●' : statusColor === 'red' ? '○' : '◌';
          const indicatorColor = statusColor === 'green' ? COLORS.online :
                                  statusColor === 'red' ? COLORS.offline : COLORS.textDim;

          return (
            <text
              key={machine.machineId}
              fg={isConnectable ? textColor : COLORS.textDim}
              height={1}
            >
              {isSelected ? '>' : ' '} <text fg={indicatorColor}>{indicator}</text> {getMachineLabel(machine)}
              {machine.lastConnectedAt && (
                <text fg={COLORS.textDim}> ({formatLastSeen(machine.lastConnectedAt)})</text>
              )}
            </text>
          );
        })}
      </box>

      {/* Footer */}
      <text fg={COLORS.textDim} height={1} paddingLeft={1}>
        [↑↓] Navigate  [Enter] Connect  [r] Refresh  [?] Help
      </text>
    </box>
  );
}
