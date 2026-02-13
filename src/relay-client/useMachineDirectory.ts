import { useCallback, useEffect, useRef, useState } from 'react';
import type { MachineInfo } from '../components/MachineList.js';
import { SpacesError } from '../types/errors.js';
import {
  RelayMachineDirectoryClient,
  type RelaySigner,
  type RelaySocketAdapter,
  type RelayStatus,
} from './machine-directory-client.js';

export interface MachineDirectoryClientConfig<TIdentity, TContext = undefined> {
  relayUrl: string;
  clientIdentityId: string;
  signer?: RelaySigner;
  identity: TIdentity;
  context?: TContext;
}

export interface UseMachineDirectoryOptions<
  TSocket,
  TIdentity,
  TContext = undefined,
> {
  enabled?: boolean;
  autoConnect?: boolean;
  socketAdapter: RelaySocketAdapter<TSocket>;
  resolveClientConfig: () => Promise<MachineDirectoryClientConfig<TIdentity, TContext>>;
  mapMachines?: (machines: MachineInfo[]) => MachineInfo[];
  onError?: (error: Error) => void;
}

export interface UseMachineDirectoryReturn<TSocket, TIdentity, TContext = undefined> {
  status: RelayStatus;
  error: string | null;
  machines: MachineInfo[];
  identity: TIdentity | null;
  context: TContext | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshMachines: () => void;
  getSocket: () => TSocket | null;
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new SpacesError(fallback, 'SYSTEM_ERROR', 2);
}

export function useMachineDirectory<TSocket, TIdentity, TContext = undefined>(
  options: UseMachineDirectoryOptions<TSocket, TIdentity, TContext>
): UseMachineDirectoryReturn<TSocket, TIdentity, TContext> {
  const {
    enabled = true,
    autoConnect = false,
    socketAdapter,
    resolveClientConfig,
    mapMachines,
    onError,
  } = options;

  const [status, setStatus] = useState<RelayStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [identity, setIdentity] = useState<TIdentity | null>(null);
  const [context, setContext] = useState<TContext | null>(null);
  const clientRef = useRef<RelayMachineDirectoryClient<TSocket> | null>(null);
  const socketAdapterRef = useRef(socketAdapter);
  const resolveClientConfigRef = useRef(resolveClientConfig);
  const mapMachinesRef = useRef(mapMachines);
  const onErrorRef = useRef(onError);

  socketAdapterRef.current = socketAdapter;
  resolveClientConfigRef.current = resolveClientConfig;
  mapMachinesRef.current = mapMachines;
  onErrorRef.current = onError;

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus('disconnected');
    setError(null);
    setMachines([]);
    setIdentity(null);
    setContext(null);
  }, []);

  const connect = useCallback(async () => {
    if (!enabled) {
      disconnect();
      return;
    }

    try {
      clientRef.current?.disconnect();
      clientRef.current = null;

      setStatus('connecting');
      setError(null);

      const config = await resolveClientConfigRef.current();
      setIdentity(config.identity);
      setContext((config.context ?? null) as TContext | null);

      const client = new RelayMachineDirectoryClient<TSocket>({
        relayUrl: config.relayUrl,
        clientIdentityId: config.clientIdentityId,
        socketAdapter: socketAdapterRef.current,
        signer: config.signer,
        onStatusChange: (nextStatus) => {
          setStatus(nextStatus);
        },
        onMachineList: (nextMachines) => {
          const mapper = mapMachinesRef.current;
          setMachines(mapper ? mapper(nextMachines) : nextMachines);
        },
        onError: (message) => {
          setError(message);
          onErrorRef.current?.(new SpacesError(message, 'SYSTEM_ERROR', 2));
        },
      });

      clientRef.current = client;
      await client.connect();
    } catch (error) {
      const nextError = toError(error, 'Failed to connect to relay');
      setStatus('error');
      setError(nextError.message);
      setMachines([]);
      setIdentity(null);
      setContext(null);
      onErrorRef.current?.(nextError);
    }
  }, [disconnect, enabled]);

  const refreshMachines = useCallback(() => {
    if (!enabled) {
      return;
    }
    clientRef.current?.refreshMachines();
  }, [enabled]);

  const getSocket = useCallback(() => {
    return clientRef.current?.getSocket() ?? null;
  }, []);

  useEffect(() => {
    if (!enabled) {
      disconnect();
      return;
    }

    if (autoConnect) {
      void connect();
    }

    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [autoConnect, connect, disconnect, enabled]);

  return {
    status,
    error,
    machines,
    identity,
    context,
    connect,
    disconnect,
    refreshMachines,
    getSocket,
  };
}
