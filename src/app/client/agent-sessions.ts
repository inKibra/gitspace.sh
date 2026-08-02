import type { SessionBackend } from '../../session/backend.js';
import type { AppClientContext } from './context.js';
import {
  agentSessionFailure,
  agentSessionSuccess,
  describeAppClientError,
  type AgentSessionCommandResult,
} from './errors.js';
import { getCurrentAgentSessions, resolveAgentSessionRef, resolveWorkspaceRef } from './refs.js';
import type {
  AppClientAgentSessionMutationValue,
  AppClientAgentSessionOpenValue,
  AppClientAgentSessionSummary,
} from './types.js';

export interface OpenAgentSessionArgs {
  workspaceId: string;
  agentSessionId: string;
  attachOptions?: { viewOnly?: boolean; cols?: number; rows?: number; paneId?: string };
}

export interface CreateAndOpenAgentSessionArgs {
  workspaceId: string;
  title?: string;
  attachOptions?: { viewOnly?: boolean; cols?: number; rows?: number; paneId?: string };
}

export interface MutateAgentSessionArgs {
  workspaceId: string;
  agentSessionId: string;
}

export interface AppAgentSessionsClient {
  open: (args: OpenAgentSessionArgs) => Promise<AgentSessionCommandResult<AppClientAgentSessionOpenValue>>;
  createAndOpen: (args: CreateAndOpenAgentSessionArgs) => Promise<AgentSessionCommandResult<AppClientAgentSessionOpenValue>>;
  kill: (args: MutateAgentSessionArgs) => Promise<AgentSessionCommandResult<AppClientAgentSessionMutationValue>>;
  stopAgentTurn: (args: MutateAgentSessionArgs) => Promise<AgentSessionCommandResult<AppClientAgentSessionMutationValue>>;
  close: (args: MutateAgentSessionArgs) => Promise<AgentSessionCommandResult<AppClientAgentSessionMutationValue>>;
  archive: (args: MutateAgentSessionArgs) => Promise<AgentSessionCommandResult<AppClientAgentSessionMutationValue>>;
  restore: (args: MutateAgentSessionArgs) => Promise<AgentSessionCommandResult<AppClientAgentSessionMutationValue>>;
}

export function findCreatedAgentSession(
  previousIds: Set<string>,
  sessions: readonly AppClientAgentSessionSummary[],
): AppClientAgentSessionSummary | undefined {
  return sessions.find((session) => !previousIds.has(session.id))
    ?? [...sessions].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0];
}

function getBackend(
  context: AppClientContext,
  workspaceId: string,
  backendKey: string,
): AgentSessionCommandResult<SessionBackend> {
  const backend = context.multi.getBackend(backendKey);
  if (!backend) {
    return agentSessionFailure({
      code: 'backend-unavailable',
      message: `Backend ${backendKey} is not available`,
      workspaceId,
      backendKey,
    });
  }

  return agentSessionSuccess(backend);
}

async function openResolvedAgentSession(
  context: AppClientContext,
  args: OpenAgentSessionArgs & { workspaceRef: AppClientAgentSessionOpenValue['workspaceRef'] },
): Promise<AgentSessionCommandResult<AppClientAgentSessionOpenValue>> {
  // Verify the backend supports agent attach (surface the error early)
  const backendResult = getBackend(context, args.workspaceId, args.workspaceRef.backendKey);
  if (!backendResult.ok) {
    return backendResult;
  }
  if (!backendResult.value.openAgentSession) {
    return agentSessionFailure({
      code: 'operation-unavailable',
      message: 'Agent attach unavailable',
      workspaceId: args.workspaceId,
      agentSessionId: args.agentSessionId,
      backendKey: args.workspaceRef.backendKey,
    });
  }

  void context.multi.setAgentSessionPreference(args.workspaceRef, args.agentSessionId).catch(() => undefined);

  try {
    // Go through multi (engine) so SET_PENDING_AGENT_ATTACH is dispatched
    await context.multi.openAgentSession(
      { ...args.workspaceRef, agentSessionId: args.agentSessionId },
      args.attachOptions,
    );
    return agentSessionSuccess({
      workspaceRef: args.workspaceRef,
      agentSessionRef: {
        ...args.workspaceRef,
        agentSessionId: args.agentSessionId,
      },
    });
  } catch (error) {
    return agentSessionFailure({
      code: 'attach-failed',
      message: describeAppClientError(error, 'Failed to attach agent session'),
      workspaceId: args.workspaceId,
      agentSessionId: args.agentSessionId,
      backendKey: args.workspaceRef.backendKey,
      cause: error,
    });
  }
}

async function mutateAgentSession(
  context: AppClientContext,
  args: MutateAgentSessionArgs,
  operation: 'kill' | 'stopAgentTurn' | 'close' | 'archive' | 'restore',
): Promise<AgentSessionCommandResult<AppClientAgentSessionMutationValue>> {
  const refResult = resolveAgentSessionRef(context, args.workspaceId, args.agentSessionId);
  if (!refResult.ok) {
    return refResult;
  }

  const { workspaceRef, agentSessionRef } = refResult.value;
  const backendResult = getBackend(context, args.workspaceId, workspaceRef.backendKey);
  if (!backendResult.ok) {
    return backendResult;
  }

  const backend = backendResult.value;

  try {
    if (operation === 'kill') {
      if (!backend.abortAgentSession) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: 'Agent kill unavailable',
          workspaceId: args.workspaceId,
          agentSessionId: args.agentSessionId,
          backendKey: workspaceRef.backendKey,
        });
      }

      // backend.abortAgentSession is the wire-level kill command — name stays.
      const killed = await backend.abortAgentSession(args.workspaceId, args.agentSessionId);
      if (!killed) {
        return agentSessionFailure({
          code: 'kill-failed',
          message: `Agent session ${args.agentSessionId} could not be killed`,
          workspaceId: args.workspaceId,
          agentSessionId: args.agentSessionId,
          backendKey: workspaceRef.backendKey,
        });
      }

      return agentSessionSuccess({ workspaceRef, agentSessionRef });
    }

    if (operation === 'stopAgentTurn') {
      if (!backend.interruptAgentSession) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: 'Agent turn interrupt unavailable',
          workspaceId: args.workspaceId,
          agentSessionId: args.agentSessionId,
          backendKey: workspaceRef.backendKey,
        });
      }

      // backend.interruptAgentSession is the wire-level interrupt command — name stays.
      const stopped = await backend.interruptAgentSession(args.workspaceId, args.agentSessionId);
      if (!stopped) {
        return agentSessionFailure({
          code: 'stop-turn-failed',
          message: `Agent turn for session ${args.agentSessionId} could not be stopped`,
          workspaceId: args.workspaceId,
          agentSessionId: args.agentSessionId,
          backendKey: workspaceRef.backendKey,
        });
      }

      return agentSessionSuccess({ workspaceRef, agentSessionRef });
    }

    if (operation === 'close') {
      if (!backend.closeAgentSession) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: 'Agent close unavailable',
          workspaceId: args.workspaceId,
          agentSessionId: args.agentSessionId,
          backendKey: workspaceRef.backendKey,
        });
      }

      const sessions = await backend.closeAgentSession(args.workspaceId, args.agentSessionId);
      return agentSessionSuccess({ workspaceRef, agentSessionRef, sessions });
    }

    if (operation === 'archive') {
      if (!backend.archiveAgentSession) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: 'Agent archive unavailable',
          workspaceId: args.workspaceId,
          agentSessionId: args.agentSessionId,
          backendKey: workspaceRef.backendKey,
        });
      }

      const sessions = await backend.archiveAgentSession(args.workspaceId, args.agentSessionId);
      return agentSessionSuccess({ workspaceRef, agentSessionRef, sessions });
    }

    if (!backend.restoreAgentSession) {
      return agentSessionFailure({
        code: 'operation-unavailable',
        message: 'Agent restore unavailable',
        workspaceId: args.workspaceId,
        agentSessionId: args.agentSessionId,
        backendKey: workspaceRef.backendKey,
      });
    }

    const sessions = await backend.restoreAgentSession(args.workspaceId, args.agentSessionId);
    return agentSessionSuccess({ workspaceRef, agentSessionRef, sessions });
  } catch (error) {
    return agentSessionFailure({
      code: operation === 'close'
        ? 'close-failed'
        : operation === 'archive'
          ? 'archive-failed'
          : operation === 'restore'
            ? 'restore-failed'
            : operation === 'kill'
              ? 'kill-failed'
              : 'stop-turn-failed',
      message: describeAppClientError(error, `Failed to ${operation} agent session`),
      workspaceId: args.workspaceId,
      agentSessionId: args.agentSessionId,
      backendKey: workspaceRef.backendKey,
      cause: error,
    });
  }
}

export function createAppAgentSessionsClient(context: AppClientContext): AppAgentSessionsClient {
  return {
    open: async (args) => {
      const refResult = resolveAgentSessionRef(context, args.workspaceId, args.agentSessionId);
      if (!refResult.ok) {
        return refResult;
      }

      return openResolvedAgentSession(context, {
        ...args,
        workspaceRef: refResult.value.workspaceRef,
      });
    },
    createAndOpen: async (args) => {
      const workspaceResult = resolveWorkspaceRef(context, args.workspaceId);
      if (!workspaceResult.ok) {
        return workspaceResult;
      }

      const workspaceRef = workspaceResult.value;
      const backendResult = getBackend(context, args.workspaceId, workspaceRef.backendKey);
      if (!backendResult.ok) {
        return backendResult;
      }

      const backend = backendResult.value;
      if (!backend.createAgentSession) {
        return agentSessionFailure({
          code: 'operation-unavailable',
          message: 'Agent session creation unavailable',
          workspaceId: args.workspaceId,
          backendKey: workspaceRef.backendKey,
        });
      }

      const previousIds = new Set(getCurrentAgentSessions(context, workspaceRef).map((session) => session.id));
      let sessions: AppClientAgentSessionSummary[];
      try {
        sessions = await backend.createAgentSession(args.workspaceId, args.title);
      } catch (error) {
        return agentSessionFailure({
          code: 'create-failed',
          message: describeAppClientError(error, 'Failed to create agent session'),
          workspaceId: args.workspaceId,
          backendKey: workspaceRef.backendKey,
          cause: error,
        });
      }

      const created = findCreatedAgentSession(previousIds, sessions);
      if (!created) {
        return agentSessionFailure({
          code: 'create-failed',
          message: 'Created agent session could not be identified',
          workspaceId: args.workspaceId,
          backendKey: workspaceRef.backendKey,
        });
      }

      return openResolvedAgentSession(context, {
        workspaceId: args.workspaceId,
        agentSessionId: created.id,
        attachOptions: args.attachOptions,
        workspaceRef,
      });
    },
    kill: (args) => mutateAgentSession(context, args, 'kill'),
    stopAgentTurn: (args) => mutateAgentSession(context, args, 'stopAgentTurn'),
    close: (args) => mutateAgentSession(context, args, 'close'),
    archive: (args) => mutateAgentSession(context, args, 'archive'),
    restore: (args) => mutateAgentSession(context, args, 'restore'),
  };
}
