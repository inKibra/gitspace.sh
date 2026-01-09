/**
 * Hook for relay connection before terminal session
 *
 * Handles:
 * - WebSocket connection to relay
 * - Fetching machine list for the browser's identity
 * - Pre-handshake relay communication
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { getOrCreateIdentity } from "../lib/storage/identity-store";
import { exportPublicKey } from "../lib/crypto/identity";
import { signRelayMessage } from "../lib/crypto/relay-signing";
import type { Identity } from "../types/identity";

/** Ping interval in milliseconds (15 seconds) */
const PING_INTERVAL = 15000;

export type RelayStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface MachineInfo {
  machineId: string;
  label?: string;
  online: boolean;
  /** Whether we're authorized for this machine (checked via X3DH) */
  isAuthorized: boolean;
  lastConnectedAt?: number;
}

interface RelayState {
  status: RelayStatus;
  machines: MachineInfo[];
  error: string | null;
  identity: Identity | null;
  publicKey: string | null;  // Full public key for `gssh access add`
}

export function useRelayConnection() {
  const [state, setState] = useState<RelayState>({
    status: "disconnected",
    machines: [],
    error: null,
    identity: null,
    publicKey: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start ping interval to keep connection alive
  const startPing = useCallback(() => {
    // Clear any existing interval
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
    }

    pingIntervalRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, PING_INTERVAL);
  }, []);

  // Stop ping interval
  const stopPing = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPing();
    };
  }, [stopPing]);

  /**
   * Connect to relay and fetch machine list
   * No token required - authorization happens via signed relay messages + X3DH handshake
   */
  const connect = useCallback(async () => {
    try {
      setState(s => ({ ...s, status: "connecting", error: null }));

      // Get or create browser identity
      const identity = await getOrCreateIdentity();
      const publicKey = exportPublicKey(identity);
      setState(s => ({ ...s, identity, publicKey }));

      // Build WebSocket URL
      const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = new URL(`${wsProtocol}//${location.host}/ws`);
      wsUrl.searchParams.set("role", "client");

      // Connect to relay
      const ws = new WebSocket(wsUrl.toString());
      wsRef.current = ws;

      ws.onopen = () => {
        setState(s => ({ ...s, status: "connected" }));

        // Start keepalive pings
        startPing();

        // Request machine list
        const signed = signRelayMessage({
          type: "list_machines",
          clientIdentityId: identity.id,
        }, identity);
        ws.send(JSON.stringify(signed));
      };

      ws.onmessage = (event) => {
        handleMessage(event.data);
      };

      ws.onclose = () => {
        stopPing();
        setState(s => ({ ...s, status: "disconnected" }));
        wsRef.current = null;
      };

      ws.onerror = () => {
        setState(s => ({ ...s, status: "error", error: "Connection failed" }));
      };
    } catch (e) {
      console.error("Relay connection failed:", e);
      setState(s => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : "Connection failed",
      }));
    }
  }, []);

  /**
   * Handle messages from relay
   */
  const handleMessage = useCallback((raw: string) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case "machine_list":
          setState(s => ({
            ...s,
            machines: msg.machines as MachineInfo[],
          }));
          break;

        case "pong":
          // Keepalive response - connection is alive
          break;

        case "error":
          console.error("Relay error:", msg.message);
          setState(s => ({
            ...s,
            error: msg.message,
          }));
          break;

        default:
          console.log("Unhandled relay message:", msg.type);
      }
    } catch (e) {
      console.error("Failed to parse relay message:", e);
    }
  }, []);

  /**
   * Refresh machine list
   */
  const refreshMachines = useCallback(() => {
    const ws = wsRef.current;
    const identity = state.identity;

    if (!ws || ws.readyState !== WebSocket.OPEN || !identity) {
      return;
    }

    const signed = signRelayMessage({
      type: "list_machines",
      clientIdentityId: identity.id,
    }, identity);
    ws.send(JSON.stringify(signed));
  }, [state.identity]);

  /**
   * Disconnect from relay
   */
  const disconnect = useCallback(() => {
    stopPing();
    wsRef.current?.close();
    wsRef.current = null;
    setState({
      status: "disconnected",
      machines: [],
      error: null,
      identity: null,
      publicKey: null,
    });
  }, [stopPing]);

  /**
   * Get the WebSocket (for reuse in terminal connection)
   */
  const getWebSocket = useCallback(() => wsRef.current, []);

  return {
    ...state,
    connect,
    disconnect,
    refreshMachines,
    getWebSocket,
  };
}
