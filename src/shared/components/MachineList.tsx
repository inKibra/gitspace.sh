/**
 * MachineList - Shared Hook
 *
 * Hook that manages machine list state and actions.
 * Used by both web and TUI renderers.
 */

import { useState, useCallback, useMemo } from 'react';

// ============================================================================
// Types
// ============================================================================

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Machine info from relay */
export interface MachineInfo {
  machineId: string;
  label?: string;
  online: boolean;
  /** Whether we're authorized for this machine (authorization happens via X3DH) */
  isAuthorized: boolean;
  lastConnectedAt?: number;
}

/** Props for useMachineList hook */
export interface UseMachineListProps {
  machines: MachineInfo[];
  status: ConnectionStatus;
  error: string | null;
  publicKey?: string | null;
  onConnect: (machine: MachineInfo) => void;
  onRefresh: () => void;
}

/** Machine list item with selection state */
export interface MachineListItem {
  machine: MachineInfo;
  isSelected: boolean;
  isConnectable: boolean;
}

/** Return type of useMachineList hook */
export interface UseMachineListReturn {
  // Display data
  items: MachineListItem[];
  selectedIndex: number;
  selectedMachine: MachineInfo | null;

  // Status
  status: ConnectionStatus;
  error: string | null;
  publicKey: string | null;
  copied: boolean;

  // Computed flags
  isLoading: boolean;
  isEmpty: boolean;
  hasError: boolean;

  // Actions
  moveUp: () => void;
  moveDown: () => void;
  selectIndex: (index: number) => void;
  connectSelected: () => void;
  copyPublicKey: () => Promise<void>;
  refresh: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useMachineList(props: UseMachineListProps): UseMachineListReturn {
  const { machines, status, error, publicKey, onConnect, onRefresh } = props;

  // Local UI state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copied, setCopied] = useState(false);

  // Computed values
  const isLoading = status === 'connecting';
  const hasError = status === 'error';
  const isEmpty = machines.length === 0 && status === 'connected';

  // Build items with selection state
  const items: MachineListItem[] = useMemo(() => {
    return machines.map((machine, index) => ({
      machine,
      isSelected: index === selectedIndex,
      // If machine is visible, user has access (relay filters by access)
      isConnectable: machine.online, // Authorization happens via X3DH handshake
    }));
  }, [machines, selectedIndex]);

  // Selected machine
  const selectedMachine = machines[selectedIndex] ?? null;

  // Actions
  const moveUp = useCallback(() => {
    setSelectedIndex(i => Math.max(0, i - 1));
  }, []);

  const moveDown = useCallback(() => {
    setSelectedIndex(i => Math.min(machines.length - 1, i + 1));
  }, [machines.length]);

  const selectIndex = useCallback((index: number) => {
    setSelectedIndex(Math.max(0, Math.min(index, machines.length - 1)));
  }, [machines.length]);

  const connectSelected = useCallback(() => {
    // Allow connection attempt - authorization happens via X3DH handshake
    if (selectedMachine && selectedMachine.online) {
      onConnect(selectedMachine);
    }
  }, [selectedMachine, onConnect]);

  const copyPublicKey = useCallback(async () => {
    if (!publicKey) return;

    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  }, [publicKey]);

  const refresh = useCallback(() => {
    onRefresh();
  }, [onRefresh]);

  return {
    // Display data
    items,
    selectedIndex,
    selectedMachine,

    // Status
    status,
    error,
    publicKey: publicKey ?? null,
    copied,

    // Computed flags
    isLoading,
    isEmpty,
    hasError,

    // Actions
    moveUp,
    moveDown,
    selectIndex,
    connectSelected,
    copyPublicKey,
    refresh,
  };
}

// ============================================================================
// Utilities
// ============================================================================

/** Format last seen time */
export function formatLastSeen(timestamp?: number): string {
  if (!timestamp) return 'Never';

  const diff = Date.now() - timestamp;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/** Get status indicator color */
export function getStatusColor(machine: MachineInfo): 'green' | 'yellow' | 'red' | 'gray' {
  if (!machine.online) return 'red';
  if (!machine.isAuthorized) return 'yellow'; // Online but not authorized
  return 'green';
}

/** Get display label for machine */
export function getMachineLabel(machine: MachineInfo): string {
  return machine.label || machine.machineId;
}
