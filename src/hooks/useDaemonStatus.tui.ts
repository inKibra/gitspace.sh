/**
 * Hook for monitoring daemon status (tmux-lite and serve)
 *
 * Provides real-time status of:
 * - tmux-lite server (sessions count, version)
 * - serve daemon (relay connection, clients count)
 */

import { useState, useEffect, useCallback } from 'react';
import { getStatus as getTmuxStatus, isServerRunning as isTmuxRunning } from '../lib/tmux-lite/cli.js';
import { queryServeStatus, isServeRunning } from '../serve/daemon.js';

/** Package version for comparison */
const PACKAGE_VERSION = '1.0.0';

/** Tmux daemon status */
export interface TmuxStatus {
  running: boolean;
  version?: string;
  sessions?: number;
  attached?: number;
  uptime?: number;
}

/** Serve daemon status */
export interface ServeStatus {
  running: boolean;
  version?: string;
  relayUrl?: string;
  relayStatus?: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  clients?: number;
  uptime?: number;
}

/** Combined daemon status */
export interface DaemonStatus {
  tmux: TmuxStatus;
  serve: ServeStatus;
  versionMismatch: boolean;
  packageVersion: string;
}

/** Hook options */
export interface UseDaemonStatusOptions {
  /** Polling interval in ms (default: 5000) */
  pollInterval?: number;
  /** Whether to poll automatically (default: true) */
  autoPoll?: boolean;
}

/** Hook return type */
export interface UseDaemonStatusReturn {
  status: DaemonStatus;
  refresh: () => Promise<void>;
  isLoading: boolean;
}

/**
 * Hook for monitoring daemon status
 */
export function useDaemonStatus(options: UseDaemonStatusOptions = {}): UseDaemonStatusReturn {
  const { pollInterval = 5000, autoPoll = true } = options;

  const [status, setStatus] = useState<DaemonStatus>({
    tmux: { running: false },
    serve: { running: false },
    versionMismatch: false,
    packageVersion: PACKAGE_VERSION,
  });
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      // Query tmux status
      let tmuxStatus: TmuxStatus = { running: false };
      if (await isTmuxRunning()) {
        try {
          const tmux = await getTmuxStatus();
          tmuxStatus = {
            running: true,
            version: tmux.version,
            sessions: tmux.sessions,
            attached: tmux.attached,
            uptime: tmux.uptime,
          };
        } catch {
          tmuxStatus = { running: true }; // Running but couldn't get details
        }
      }

      // Query serve status
      let serveStatus: ServeStatus = { running: false };
      if (isServeRunning()) {
        try {
          const serve = await queryServeStatus();
          if (serve) {
            serveStatus = {
              running: true,
              version: serve.version,
              relayUrl: serve.relay.url,
              relayStatus: serve.relay.status,
              clients: serve.clients,
              uptime: serve.uptime,
            };
          } else {
            serveStatus = { running: true }; // Running but couldn't get details
          }
        } catch {
          serveStatus = { running: true }; // Running but couldn't get details
        }
      }

      // Check version mismatch
      const versionMismatch =
        (tmuxStatus.version && tmuxStatus.version !== PACKAGE_VERSION) ||
        (serveStatus.version && serveStatus.version !== PACKAGE_VERSION);

      setStatus({
        tmux: tmuxStatus,
        serve: serveStatus,
        versionMismatch: !!versionMismatch,
        packageVersion: PACKAGE_VERSION,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Polling
  useEffect(() => {
    if (!autoPoll) return;

    const interval = setInterval(refresh, pollInterval);
    return () => clearInterval(interval);
  }, [autoPoll, pollInterval, refresh]);

  return { status, refresh, isLoading };
}

/**
 * Format uptime in human-readable format
 */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Format relay status for display
 */
export function formatRelayStatus(status: ServeStatus['relayStatus']): string {
  switch (status) {
    case 'connected': return '●';
    case 'connecting': return '◐';
    case 'reconnecting': return '◐';
    case 'disconnected': return '○';
    default: return '?';
  }
}
