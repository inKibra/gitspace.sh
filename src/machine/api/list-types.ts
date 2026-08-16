/**
 * Shared list-mode workspace and session types.
 *
 * These are the client-side projection types used when listing workspaces,
 * sessions, and agent sessions — before the full machine_snapshot model
 * replaces list-mode APIs entirely.
 *
 * Long-term: MachineWorkspaceRecord, MachineTerminalSessionRecord, and
 * MachineAgentSessionRecord from machine/state/types.ts will supersede these.
 * Keep these here as a transitional layer; do not add new fields.
 */

import type { AgentModelInfo, AgentSessionRenderState, SessionActivity, SessionStatus, TodoPhase } from '../../agents/agent-runtime-types.js';

/** Workspace as returned by list_workspaces / workspace_list */
export type { WorkspaceInfo } from '../../lib/remote-session/protocol.js';

/** Terminal session as returned by list_sessions / session_list */
export type { SessionInfo } from '../../lib/remote-session/protocol.js';

/** Agent session summary — client-side view of a running agent session */
export interface AgentSessionInfo {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
  closedAt?: string;
  /** No live worker, but not dismissed — resumable. See MachineAgentSessionState. */
  dormantSince?: string;
  archivedAt?: string;
  /**
   * The ONE decision about what this session is doing, made by
   * `determineAgentState` at record build. Colour and label are lookups on this
   * — never re-derive it from `activity`/`status`/`closedAt` in a component, or
   * you get another ladder that drifts (which is how `dormant` rendered blue).
   */
  state?: AgentSessionRenderState;
  status?: SessionStatus;
  /** Canonical activity from the daemon. Read this to decide whether a session
   *  is doing or owing anything; `status` only describes the current turn. */
  activity?: SessionActivity;
  pendingPermissionCount?: number;
  pendingQuestionCount?: number;
  errorMessage?: string;
  /** Timestamp (ms) of the last observed activity from the live event stream. */
  lastActivityAt?: number;
  /** Model currently in use (populated when session runs in-process). */
  modelInfo?: AgentModelInfo;
  /** Todo phases (populated when session runs in-process). */
  todoPhases?: TodoPhase[];
}
