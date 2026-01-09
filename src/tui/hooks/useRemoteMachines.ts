/**
 * TUI Hook for Remote Machine Connections
 *
 * Manages relay connection and provides a unified interface for
 * both local and remote machine operations.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import WebSocket from 'ws';
import type { MachineInfo } from '../../shared/components/index.js';
import type { MachineProvider } from '../../shared/providers/index.js';
import { getLocalMachineProvider, createRemoteMachineProvider } from '../../shared/providers/index.js';
import type WS from 'ws';

export interface RelayConfig {
  url: string;
}

export interface UseRemoteMachinesOptions {
  relayConfig?: RelayConfig;
  onError?: (error: Error) => void;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface UseRemoteMachinesReturn {
  // Connection state
  status: ConnectionStatus;
  error: string | null;

  // Machine list
  machines: MachineInfo[];
  selectedMachine: MachineInfo | null;

  // Actions
  connect: () => Promise<void>;
  disconnect: () => void;
  selectMachine: (machine: MachineInfo) => Promise<MachineProvider | null>;
  refreshMachines: () => Promise<void>;

  // Mode
  isRemoteMode: boolean;
  isLocal: (machine: MachineInfo) => boolean;
}

export function useRemoteMachines(options: UseRemoteMachinesOptions = {}): UseRemoteMachinesReturn {
  const { relayConfig, onError } = options;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [selectedMachine, setSelectedMachine] = useState<MachineInfo | null>(null);
  const wsRef = useRef<WS | null>(null);

  const isRemoteMode = !!relayConfig;

  // Local machine info
  const localMachine: MachineInfo = {
    machineId: 'local',
    label: 'This Machine',
    online: true,
    isAuthorized: true,
  };

  // Check if machine is local
  const isLocal = useCallback((machine: MachineInfo) => {
    return machine.machineId === 'local';
  }, []);

  // Connect to relay
  const connect = useCallback(async () => {
    if (!relayConfig) {
      // No relay config - just use local machine
      setMachines([localMachine]);
      setStatus('connected');
      return;
    }

    setStatus('connecting');
    setError(null);

    try {
      const socket = new WebSocket(relayConfig.url);

      socket.on('open', () => {
        // Request machine list (auth happens via challenge-response)
        socket.send(JSON.stringify({ type: 'list-machines' }));
      });

      socket.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'machines') {
            setStatus('connected');
            // Combine local with remote machines
            const remoteMachines: MachineInfo[] = message.machines.map((m: any) => ({
              machineId: m.machineId,
              label: m.label,
              online: m.online,
              hasAccess: m.hasAccess,
              lastConnectedAt: m.lastConnectedAt,
            }));
            setMachines([localMachine, ...remoteMachines]);
          } else if (message.type === 'error') {
            setError(message.message);
            if (onError) onError(new Error(message.message));
          }
        } catch (e) {
          // Ignore parse errors
        }
      });

      socket.on('error', (err) => {
        setError(err.message);
        setStatus('error');
        if (onError) onError(err);
      });

      socket.on('close', () => {
        setStatus('disconnected');
        wsRef.current = null;
      });

      wsRef.current = socket;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to connect');
      setError(error.message);
      setStatus('error');
      if (onError) onError(error);
    }
  }, [relayConfig, localMachine, onError]);

  // Disconnect from relay
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus('disconnected');
    setMachines([]);
    setSelectedMachine(null);
  }, []);

  // Select a machine and get its provider
  const selectMachine = useCallback(async (machine: MachineInfo): Promise<MachineProvider | null> => {
    setSelectedMachine(machine);

    if (isLocal(machine)) {
      // Return local provider
      return getLocalMachineProvider();
    }

    // Return remote provider
    if (!relayConfig || !wsRef.current) {
      setError('Not connected to relay');
      return null;
    }

    return createRemoteMachineProvider({
      relayUrl: relayConfig.url,
      machineId: machine.machineId,
    });
  }, [isLocal, relayConfig]);

  // Refresh machine list
  const refreshMachines = useCallback(async () => {
    if (!relayConfig) {
      setMachines([localMachine]);
      return;
    }

    const ws = wsRef.current;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'list-machines' }));
    }
  }, [relayConfig, localMachine]);

  // Auto-connect on mount if relay config is provided
  useEffect(() => {
    if (relayConfig) {
      connect();
    } else {
      // Just show local machine
      setMachines([localMachine]);
      setStatus('connected');
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []); // Only run on mount

  return {
    status,
    error,
    machines,
    selectedMachine,
    connect,
    disconnect,
    selectMachine,
    refreshMachines,
    isRemoteMode,
    isLocal,
  };
}
