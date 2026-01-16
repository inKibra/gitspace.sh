/**
 * Hook for terminal connection to relay with X3DH handshake and E2E encryption
 *
 * Supports two modes after handshake:
 * - "browsing": List workspaces and sessions
 * - "attached": Connected to a PTY session
 */

import { useState, useCallback, useRef, useEffect } from "react";
import {
  createClientHello,
  processServerHello,
  createClientAuth,
  processServerAuth,
  isX3DHResponseMessage,
  isX3DHResultMessage,
  type X3DHClientState,
} from "../lib/crypto/handshake";
import { createFrame, openFrame, MASTER_STREAM_ID } from "../lib/crypto/frames";
import { signRelayMessage } from "../lib/crypto/relay-signing";
import type { Identity, SessionKeys } from "../types/identity";
import type { InboxItem } from "../../../lib/remote-session/protocol";
import { findUtf8Boundary } from "../../../utils/utf8";

/** Stream ID for control messages (resize, detach, etc.) */
const CONTROL_STREAM_ID = 1;

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "handshaking"
  | "established"
  | "error";

/** Mode after handshake is established */
export type SessionMode = "browsing" | "attached";

/** Workspace information from machine */
export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  projectName: string;
  branch?: string;
  sessionCount: number;
  isStale?: boolean;
}

/** Session information from machine */
export interface SessionInfo {
  id: string;
  name: string;
  workspaceId: string;
  attached: boolean;
  createdAt: number;
  processTitle?: string;
  exitCode?: number;
}

/** Script execution state (during workspace attach) */
export interface ScriptState {
  phase: 'pre' | 'setup' | 'select' | 'remove';
  isRunning: boolean;
  error?: string;
  exitCode?: number;
}

/** Project information from machine */
export interface ProjectInfo {
  name: string;
  repository: string;
  workspaceCount: number;
  isCurrent: boolean;
}

interface ConnectionParams {
  ws: WebSocket;        // Existing WebSocket from relay connection
  identity: Identity;   // Client identity
  machineId: string;
  inviteId?: string;    // Short hash for relay lookup (connect_with_invite)
  inviteToken?: string; // Full invite token for X3DH authorization
}

export function useTerminal() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [mode, setMode] = useState<SessionMode>("browsing");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [attachedSessionId, setAttachedSessionId] = useState<string | null>(null);
  const [attachedSessionName, setAttachedSessionName] = useState<string | null>(null);
  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [inboxUnreadCount, setInboxUnreadCount] = useState(0);
  const [scriptState, setScriptState] = useState<ScriptState | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const identityRef = useRef<Identity | null>(null);
  const sessionKeysRef = useRef<SessionKeys | null>(null);
  const handshakeStateRef = useRef<X3DHClientState | null>(null);
  const writeCallbackRef = useRef<((data: Uint8Array) => void) | null>(null);
  const connectionParamsRef = useRef<ConnectionParams | null>(null);
  const modeRef = useRef<SessionMode>("browsing"); // For use in callbacks
  const utf8BufferRef = useRef<Uint8Array>(new Uint8Array(0)); // Buffer for incomplete UTF-8 sequences
  const handleDataMessageRef = useRef<((data: string) => void) | null>(null); // For use in handleMessage
  const scriptOutputBufferRef = useRef<Uint8Array[]>([]); // Buffer for script output before terminal mounts

  const connect = useCallback(async (params: ConnectionParams) => {
    try {
      setStatus("connecting");
      connectionParamsRef.current = params;

      // Use the passed WebSocket and identity (from relay connection)
      const { ws, identity } = params;
      wsRef.current = ws;
      identityRef.current = identity;

      // Take over message handling for this WebSocket
      ws.onmessage = (event) => {
        handleMessage(event.data);
      };

      ws.onclose = () => {
        setStatus("disconnected");
        wsRef.current = null;
        sessionKeysRef.current = null;
        handshakeStateRef.current = null;
      };

      ws.onerror = () => {
        setStatus("error");
      };

      setStatus("connected");

      // Send connect request on existing WebSocket
      const connectMsg = params.inviteId
        ? {
            type: "connect_with_invite",
            inviteId: params.inviteId,
            clientIdentityId: identity.id,
          }
        : {
            type: "connect_to_machine",
            machineId: params.machineId,
            clientIdentityId: identity.id,
          };

      const signed = signRelayMessage(connectMsg, identity);
      ws.send(JSON.stringify(signed));
    } catch (e) {
      console.error("Connection failed:", e);
      setStatus("error");
    }
  }, []);

  const handleMessage = useCallback((raw: string) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case "connection_established":
          console.log("Connection established, starting X3DH handshake...");
          setStatus("handshaking");
          startHandshake();
          break;

        case "data":
          // All data messages (handshake and encrypted frames) come through here
          // handleDataMessage will parse and route appropriately
          // Use ref to avoid stale closure (handleMessage has [] deps)
          handleDataMessageRef.current?.(msg.data);
          break;

        case "error":
          console.error("Relay error:", msg.message);
          setStatus("error");
          break;

        case "pong":
          // Keepalive response - connection is alive (from relay ping)
          break;

        default:
          console.log("Unknown message type:", msg.type);
      }
    } catch (e) {
      console.error("Failed to parse message:", e);
    }
  }, []);

  const startHandshake = useCallback(() => {
    if (!wsRef.current || !identityRef.current) return;

    const machineId = connectionParamsRef.current?.machineId;
    const { state, message } = createClientHello(machineId);
    handshakeStateRef.current = state;

    // Send ClientHello wrapped in handshake message
    // Format must match HandshakeMessageEnvelope: { type, phase, data }
    wsRef.current.send(JSON.stringify({
      type: "handshake",
      phase: "client_hello",
      data: message,
    }));
  }, []);

  const handleHandshakeMessage = useCallback((msg: { phase: string; data: Record<string, unknown> }) => {
    const ws = wsRef.current;
    const identity = identityRef.current;
    const state = handshakeStateRef.current;

    if (!ws || !identity || !state) {
      console.error("Missing handshake prerequisites");
      setStatus("error");
      return;
    }

    switch (msg.phase) {
      case "server_hello": {
        if (!isX3DHResponseMessage(msg.data)) {
          console.error("Invalid ServerHello message structure");
          setStatus("error");
          return;
        }
        const response = msg.data;
        const newState = processServerHello(state, response);

        if (!newState) {
          console.error("Failed to process ServerHello");
          setStatus("error");
          return;
        }

        handshakeStateRef.current = newState;

        // Create ClientAuth
        // Use inviteToken (full invite token) for X3DH authorization
        // inviteId is only used for relay's connect_with_invite message
        const inviteToken = connectionParamsRef.current?.inviteToken;
        const authorization = inviteToken
          ? { type: "invite" as const, inviteToken }
          : { type: "access_list" as const };

        const { state: authState, message, sessionKeys } = createClientAuth(
          newState,
          identity,
          authorization
        );

        handshakeStateRef.current = authState;
        sessionKeysRef.current = sessionKeys;

        ws.send(JSON.stringify({
          type: "handshake",
          phase: "client_auth",
          data: message,
        }));
        break;
      }

      case "server_auth": {
        if (!isX3DHResultMessage(msg.data)) {
          console.error("Invalid ServerAuth message structure");
          setStatus("error");
          return;
        }
        const response = msg.data;
        const sessionKeys = sessionKeysRef.current;

        console.log("ServerAuth response:", response);
        console.log("Current state:", {
          peerIdentityKey: state.peerIdentityKey ? "present" : "missing",
          serverNonce: state.serverNonce ? "present" : "missing",
          clientNonce: state.clientNonce ? "present" : "missing",
        });

        if (!sessionKeys) {
          console.error("Missing session keys");
          setStatus("error");
          return;
        }

        const result = processServerAuth(state, response, sessionKeys);

        if (!result) {
          console.error("Failed to process ServerAuth - response:", response);
          if (response.result?.type === "rejected") {
            console.error("Handshake rejected:", response.result);
          }
          setStatus("error");
          return;
        }

        console.log("X3DH handshake complete! Peer:", result.peerIdentityId);
        setStatus("established");
        setMode("browsing");
        modeRef.current = "browsing";

        // Request workspace list now that handshake is complete
        requestWorkspaces();
        break;
      }

      default:
        console.log("Unknown handshake phase:", msg.phase);
    }
  }, []);

  /**
   * Send an encrypted JSON command to the machine
   * Uses CONTROL stream ID for proper routing on server side
   */
  const sendCommand = useCallback(async (command: Record<string, unknown>) => {
    const ws = wsRef.current;
    const sessionKeys = sessionKeysRef.current;

    console.log("[useTerminal] sendCommand called:", command.type, "ws:", !!ws, "wsState:", ws?.readyState, "keys:", !!sessionKeys);

    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionKeys) {
      console.warn("Cannot send command: not connected");
      return;
    }

    try {
      const json = JSON.stringify(command);
      const data = new TextEncoder().encode(json);
      const frame = await createFrame(CONTROL_STREAM_ID, data, sessionKeys.sendKey);
      const base64 = btoa(String.fromCharCode(...frame));
      ws.send(JSON.stringify({ type: "data", data: base64 }));
      console.log("[useTerminal] Command sent successfully:", command.type);
    } catch (e) {
      console.error("Failed to send command:", e);
    }
  }, []);

  /**
   * Request workspace list from machine
   */
  const requestWorkspaces = useCallback(() => {
    sendCommand({ type: "list_workspaces" });
  }, [sendCommand]);

  /**
   * Request session list from machine
   */
  const requestSessions = useCallback((workspaceId?: string) => {
    sendCommand({ type: "list_sessions", workspaceId });
  }, [sendCommand]);

  /**
   * Attach to a session (existing or new in workspace)
   */
  const attachSession = useCallback((params: {
    sessionId?: string;
    workspaceId?: string;
    sessionName?: string;
    cols?: number;
    rows?: number;
  }) => {
    console.log("[useTerminal] attachSession:", params);
    sendCommand({ type: "attach_session", ...params });
  }, [sendCommand]);

  /**
   * Detach from current session (return to browsing)
   */
  const detachSession = useCallback(() => {
    sendCommand({ type: "detach" });
  }, [sendCommand]);

  /**
   * Request project list from machine
   */
  const requestProjects = useCallback(() => {
    sendCommand({ type: "list_projects" });
  }, [sendCommand]);

  /**
   * Kill a session
   */
  const killSession = useCallback((sessionId: string) => {
    sendCommand({ type: "kill_session", sessionId });
  }, [sendCommand]);

  /**
   * Delete a workspace
   */
  const deleteWorkspace = useCallback((projectName: string, workspaceId: string) => {
    sendCommand({ type: "delete_workspace", projectName, workspaceId });
  }, [sendCommand]);

  /**
   * Resize terminal
   */
  const resize = useCallback((cols: number, rows: number) => {
    sendCommand({ type: "resize", cols, rows });
  }, [sendCommand]);

  /**
   * Request inbox items from machine
   */
  const requestInbox = useCallback(() => {
    sendCommand({ type: "get_inbox" });
  }, [sendCommand]);

  /**
   * Clear inbox item(s)
   */
  const clearInboxItem = useCallback((id?: string) => {
    sendCommand({ type: "clear_inbox", id });
  }, [sendCommand]);

  /**
   * Mark inbox item as read
   */
  const markInboxItemRead = useCallback((id: string) => {
    sendCommand({ type: "mark_inbox_read", id });
  }, [sendCommand]);

  /**
   * Select a project (for filtering workspaces)
   */
  const selectProject = useCallback((projectName: string | null) => {
    setSelectedProjectName(projectName);
    if (projectName) {
      // Request workspaces for the selected project
      requestWorkspaces();
    }
  }, [requestWorkspaces]);

  /**
   * Write PTY data to terminal with UTF-8 boundary handling
   * Buffers incomplete UTF-8 sequences to prevent garbled output
   * Also buffers data if terminal hasn't mounted yet (script output during attach)
   */
  const writePtyData = useCallback((data: Uint8Array) => {
    if (!writeCallbackRef.current) {
      // Buffer data until terminal mounts (for script output during attach)
      scriptOutputBufferRef.current.push(data);
      return;
    }

    // Combine with any buffered incomplete UTF-8 bytes
    let combined: Uint8Array;
    if (utf8BufferRef.current.length > 0) {
      combined = new Uint8Array(utf8BufferRef.current.length + data.length);
      combined.set(utf8BufferRef.current, 0);
      combined.set(data, utf8BufferRef.current.length);
      utf8BufferRef.current = new Uint8Array(0);
    } else {
      combined = data;
    }

    // Find UTF-8 boundary
    const boundary = findUtf8Boundary(combined);
    if (boundary < combined.length) {
      // Buffer incomplete sequence for next time
      utf8BufferRef.current = combined.slice(boundary);
      combined = combined.slice(0, boundary);
    }

    if (combined.length > 0) {
      writeCallbackRef.current(combined);
    }
  }, []);

  /**
   * Handle a decrypted browse response (workspace_list, session_list, etc.)
   */
  const handleBrowseResponse = useCallback((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case "project_list":
        console.log("[useTerminal] Received project_list:", (msg.projects as ProjectInfo[]).length, "projects");
        setProjects(msg.projects as ProjectInfo[]);
        break;

      case "workspace_list":
        console.log("[useTerminal] Received workspace_list:", (msg.workspaces as WorkspaceInfo[]).length, "workspaces");
        setWorkspaces(msg.workspaces as WorkspaceInfo[]);
        break;

      case "session_list":
        setSessions(msg.sessions as SessionInfo[]);
        break;

      case "session_killed":
        console.log("Session killed:", msg.sessionId, "in workspace:", msg.workspaceId);
        // Refresh workspace list to update session counts
        requestWorkspaces();
        // Also refresh the sessions for that workspace so the killed session disappears
        if (msg.workspaceId && msg.workspaceId !== "unknown") {
          requestSessions(msg.workspaceId as string);
        }
        break;

      case "workspace_deleted":
        console.log("Workspace deleted:", msg.workspaceId);
        // Refresh workspace list
        requestWorkspaces();
        break;

      case "attached":
        console.log("Attached to session:", msg.sessionId, msg.sessionName);
        setMode("attached");
        modeRef.current = "attached";
        setAttachedSessionId(msg.sessionId as string);
        setAttachedSessionName(msg.sessionName as string || null);
        break;

      case "detached":
        console.log("Detached from session");
        setMode("browsing");
        modeRef.current = "browsing";
        setAttachedSessionId(null);
        setAttachedSessionName(null);
        // Refresh workspace list
        requestWorkspaces();
        break;

      case "session_exited":
        console.log("Session exited:", msg.sessionId, "code:", msg.exitCode);
        setMode("browsing");
        modeRef.current = "browsing";
        setAttachedSessionId(null);
        setAttachedSessionName(null);
        requestWorkspaces();
        break;

      case "inbox_list":
        setInbox(msg.items as InboxItem[]);
        setInboxUnreadCount(msg.unreadCount as number);
        break;

      case "inbox_cleared":
        // Refresh inbox after clearing
        requestInbox();
        break;

      case "inbox_marked_read":
        // Refresh inbox after marking read
        requestInbox();
        break;

      case "script_output": {
        // Handle script output streaming during attach_session
        const phase = msg.phase as ScriptState['phase'];
        const done = msg.done as boolean | undefined;
        const error = msg.error as string | undefined;
        const exitCode = msg.exitCode as number | undefined;

        // Update script state
        if (done) {
          if (error) {
            setScriptState({ phase, isRunning: false, error, exitCode });
          } else {
            // Scripts completed successfully - clear state (attach response will follow)
            setScriptState(null);
          }
        } else {
          setScriptState({ phase, isRunning: true });
        }

        // Decode base64 output data and write to terminal
        const data = msg.data as string;
        if (data && data.length > 0) {
          const ptyData = Uint8Array.from(atob(data), c => c.charCodeAt(0));
          writePtyData(ptyData);
        }
        break;
      }

      case "error":
        console.error("Machine error:", msg.code, msg.message);
        // If we were running scripts, mark as failed
        if (scriptState?.isRunning) {
          setScriptState({
            ...scriptState,
            isRunning: false,
            error: msg.message as string,
          });
        }
        break;

      default:
        console.log("Unknown browse response:", msg.type);
    }
  }, [requestWorkspaces, requestSessions, requestInbox, writePtyData, scriptState]);

  const handleDataMessage = useCallback(async (base64Data: string) => {
    const sessionKeys = sessionKeysRef.current;

    try {
      // Decode base64 to bytes
      const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

      // Try to parse as JSON first - could be a handshake message
      // This is important because session keys are set before server_auth arrives
      try {
        const jsonStr = new TextDecoder().decode(bytes);
        const envelope = JSON.parse(jsonStr);

        if (envelope.type === "handshake") {
          handleHandshakeMessage(envelope);
          return;
        }
      } catch {
        // Not JSON, must be encrypted data - continue to decryption
      }

      // If no session keys, we can't decrypt
      if (!sessionKeys) {
        console.warn("Received encrypted data before session established");
        return;
      }

      // Session established - decrypt as encrypted frame
      const result = await openFrame(bytes, sessionKeys.receiveKey);
      if (!result) {
        console.error("Failed to decrypt frame");
        return;
      }

      // Try to parse as JSON - could be a browse response or PTY output message
      try {
        const jsonStr = new TextDecoder().decode(result.data);
        const msg = JSON.parse(jsonStr);

        // Check if it's a browse response or pty_output
        if (msg.type === "pty_output") {
          // Decode base64 PTY data and forward to terminal with UTF-8 handling
          const ptyData = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
          writePtyData(ptyData);
          return;
        }

        // Handle as browse response
        handleBrowseResponse(msg);
        return;
      } catch {
        // Not JSON - in attached mode, this is raw PTY data
        if (modeRef.current === "attached") {
          writePtyData(result.data);
        }
      }
    } catch (e) {
      console.error("Failed to handle data message:", e);
    }
  }, [handleBrowseResponse, writePtyData]);

  // Keep ref updated to avoid stale closure in handleMessage
  useEffect(() => {
    handleDataMessageRef.current = handleDataMessage;
  }, [handleDataMessage]);

  const send = useCallback(async (data: Uint8Array) => {
    const ws = wsRef.current;
    const sessionKeys = sessionKeysRef.current;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn("WebSocket not connected");
      return;
    }

    if (!sessionKeys) {
      console.warn("Session keys not established");
      return;
    }

    try {
      // Encrypt data into a frame
      const frame = await createFrame(MASTER_STREAM_ID, data, sessionKeys.sendKey);

      // Encode as base64 and send
      const base64 = btoa(String.fromCharCode(...frame));
      ws.send(JSON.stringify({
        type: "data",
        data: base64,
      }));
    } catch (e) {
      console.error("Failed to send data:", e);
    }
  }, []);

  const setWriteCallback = useCallback((fn: (data: Uint8Array) => void) => {
    writeCallbackRef.current = fn;
    // Flush any buffered script output that arrived before terminal mounted
    if (scriptOutputBufferRef.current.length > 0) {
      console.log(`[useTerminal] Flushing ${scriptOutputBufferRef.current.length} buffered script output chunks`);
      for (const chunk of scriptOutputBufferRef.current) {
        writePtyData(chunk);
      }
      scriptOutputBufferRef.current = [];
    }
  }, [writePtyData]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    sessionKeysRef.current = null;
    handshakeStateRef.current = null;
    utf8BufferRef.current = new Uint8Array(0); // Clear UTF-8 buffer
    scriptOutputBufferRef.current = []; // Clear script output buffer
    setStatus("disconnected");
    setMode("browsing");
    modeRef.current = "browsing";
    setProjects([]);
    setWorkspaces([]);
    setSessions([]);
    setAttachedSessionId(null);
    setAttachedSessionName(null);
    setSelectedProjectName(null);
    setInbox([]);
    setInboxUnreadCount(0);
    setScriptState(null);
  }, []);

  return {
    // Connection state
    status,
    mode,

    // Browse data
    projects,
    workspaces,
    sessions,
    attachedSessionId,
    attachedSessionName,
    selectedProjectName,

    // Connection actions
    connect,
    disconnect,

    // Browse actions
    requestProjects,
    requestWorkspaces,
    requestSessions,
    attachSession,
    detachSession,
    selectProject,

    // Session/workspace management
    killSession,
    deleteWorkspace,

    // Terminal I/O (for attached mode)
    send,
    resize,
    setWriteCallback,

    // Inbox
    inbox,
    inboxUnreadCount,
    requestInbox,
    clearInboxItem,
    markInboxItemRead,

    // Script execution state (during attach)
    scriptState,
  };
}
