import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type {
  PendingQuestion,
  Permission,
  QuestionInfo,
  SessionStatus,
} from '../../../../agents/opencode-event-types.js';
import { sendPiRuntimeUpdate } from '../pi-runtime-status.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseQuestionOptions(input: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((option) => {
    if (typeof option === 'string') {
      return [{ label: option }];
    }
    if (isRecord(option) && typeof option.label === 'string') {
      return [{
        label: option.label,
        description: typeof option.description === 'string' ? option.description : undefined,
      }];
    }
    return [];
  });
}

function parseAskQuestions(input: Record<string, unknown>): QuestionInfo[] {
  if (Array.isArray(input.questions)) {
    const parsed = input.questions.flatMap((question) => {
      if (!isRecord(question)) {
        return [];
      }
      if (typeof question.question !== 'string') {
        return [];
      }
      return [{
        question: question.question,
        header: typeof question.header === 'string' ? question.header : 'Question',
        options: parseQuestionOptions(question.options),
        multiple: question.multiple === true,
        custom: question.custom === true,
      } satisfies QuestionInfo];
    });
    if (parsed.length > 0) {
      return parsed;
    }
  }

  if (typeof input.question === 'string') {
    return [{
      question: input.question,
      header: typeof input.header === 'string' ? input.header : 'Question',
      options: parseQuestionOptions(input.options),
      multiple: input.multiple === true,
      custom: input.custom === true,
    }];
  }

  if (typeof input.prompt === 'string') {
    return [{
      question: input.prompt,
      header: 'Question',
      options: parseQuestionOptions(input.options),
      multiple: input.multiple === true,
      custom: true,
    }];
  }

  return [{
    question: 'Agent requested additional input.',
    header: 'Question',
    options: [],
    custom: true,
  }];
}

function buildPendingQuestion(toolCallId: string, sessionId: string, input: Record<string, unknown>): PendingQuestion {
  return {
    id: toolCallId,
    sessionID: sessionId,
    questions: parseAskQuestions(input),
    tool: {
      messageID: toolCallId,
      callID: toolCallId,
    },
  };
}

function buildPermission(sessionId: string, payload: unknown): Permission {
  const record = isRecord(payload) ? payload : {};
  const id = typeof record.id === 'string'
    ? record.id
    : typeof record.permissionId === 'string'
      ? record.permissionId
      : 'pi-permission';

  return {
    id,
    type: typeof record.type === 'string' ? record.type : 'permission',
    pattern: Array.isArray(record.pattern) || typeof record.pattern === 'string' ? record.pattern : undefined,
    sessionID: sessionId,
    messageID: typeof record.messageID === 'string' ? record.messageID : id,
    callID: typeof record.callID === 'string' ? record.callID : undefined,
    title: typeof record.title === 'string' ? record.title : 'Permission requested',
    metadata: isRecord(record.metadata) ? record.metadata : record,
    time: {
      created: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    },
  };
}

function permissionIdFromPayload(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (typeof payload.id === 'string') {
    return payload.id;
  }
  if (typeof payload.permissionId === 'string') {
    return payload.permissionId;
  }
  return null;
}

export default function gitspaceStatusExtension(pi: ExtensionAPI): void {
  let sessionId = '';
  let workspacePath = '';
  let activeAgentRuns = 0;
  let currentStatus: SessionStatus = { type: 'idle' };
  let pendingPermissions: Permission[] = [];
  let pendingQuestions: PendingQuestion[] = [];
  let errorMessage: string | undefined;
  let publishChain: Promise<void> = Promise.resolve();

  function syncIdentity(ctx: ExtensionContext): void {
    sessionId = ctx.sessionManager.getSessionId();
    workspacePath = ctx.sessionManager.getCwd() || ctx.cwd;
  }

  function queuePublish(): void {
    if (!sessionId || !workspacePath) {
      return;
    }
    publishChain = publishChain
      .catch(() => {})
      .then(() => sendPiRuntimeUpdate({
        sessionId,
        workspacePath,
        status: currentStatus,
        pendingPermissions,
        pendingQuestions,
        errorMessage,
      }))
      .catch((publishError) => {
        pi.logger.warn(`[gitspace-status] failed to publish runtime update: ${publishError instanceof Error ? publishError.message : String(publishError)}`);
      });
  }

  function setIdleIfNotBusy(): void {
    if (activeAgentRuns <= 0) {
      currentStatus = { type: 'idle' };
    }
  }

  function upsertPermission(permission: Permission): void {
    pendingPermissions = [
      ...pendingPermissions.filter((entry) => entry.id !== permission.id),
      permission,
    ];
  }

  function removePermission(permissionId: string | null): void {
    if (!permissionId) {
      pendingPermissions = [];
      return;
    }
    pendingPermissions = pendingPermissions.filter((entry) => entry.id !== permissionId);
  }

  function upsertQuestion(question: PendingQuestion): void {
    pendingQuestions = [
      ...pendingQuestions.filter((entry) => entry.id !== question.id),
      question,
    ];
  }

  function removeQuestion(questionId: string): void {
    pendingQuestions = pendingQuestions.filter((entry) => entry.id !== questionId);
  }

  pi.on('session_start', async (_event, ctx) => {
    syncIdentity(ctx);
    activeAgentRuns = 0;
    currentStatus = { type: 'idle' };
    pendingPermissions = [];
    pendingQuestions = [];
    errorMessage = undefined;
    queuePublish();
  });

  pi.on('session_switch', async (_event, ctx) => {
    syncIdentity(ctx);
    activeAgentRuns = 0;
    currentStatus = { type: 'idle' };
    pendingPermissions = [];
    pendingQuestions = [];
    errorMessage = undefined;
    queuePublish();
  });

  pi.on('agent_start', async (_event, ctx) => {
    syncIdentity(ctx);
    activeAgentRuns += 1;
    errorMessage = undefined;
    currentStatus = { type: 'busy' };
    queuePublish();
  });

  pi.on('agent_end', async (_event, ctx) => {
    syncIdentity(ctx);
    activeAgentRuns = Math.max(0, activeAgentRuns - 1);
    errorMessage = undefined;
    setIdleIfNotBusy();
    queuePublish();
  });

  pi.on('auto_retry_start', async (event, ctx) => {
    syncIdentity(ctx);
    errorMessage = event.errorMessage;
    currentStatus = {
      type: 'retry',
      attempt: event.attempt,
      message: event.errorMessage,
      next: Date.now() + event.delayMs,
    };
    queuePublish();
  });

  pi.on('auto_retry_end', async (event, ctx) => {
    syncIdentity(ctx);
    errorMessage = event.success ? undefined : event.finalError;
    currentStatus = activeAgentRuns > 0 ? { type: 'busy' } : { type: 'idle' };
    queuePublish();
  });

  pi.on('tool_call', async (event, ctx) => {
    syncIdentity(ctx);
    if (event.toolName !== 'ask') {
      return undefined;
    }
    upsertQuestion(buildPendingQuestion(event.toolCallId, sessionId, event.input));
    queuePublish();
    return undefined;
  });

  pi.on('tool_result', async (event, ctx) => {
    syncIdentity(ctx);
    if (event.toolName !== 'ask') {
      return undefined;
    }
    removeQuestion(event.toolCallId);
    queuePublish();
    return undefined;
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    syncIdentity(ctx);
    activeAgentRuns = 0;
    currentStatus = { type: 'idle' };
    pendingPermissions = [];
    pendingQuestions = [];
    errorMessage = undefined;
    queuePublish();
  });

  for (const channel of ['gitspace:permission.waiting', 'permission-gate:waiting']) {
    pi.events.on(channel, (payload: unknown) => {
      if (!sessionId || !workspacePath) {
        return;
      }
      upsertPermission(buildPermission(sessionId, payload));
      queuePublish();
    });
  }

  for (const channel of ['gitspace:permission.resolved', 'permission-gate:resolved']) {
    pi.events.on(channel, (payload: unknown) => {
      if (!sessionId || !workspacePath) {
        return;
      }
      removePermission(permissionIdFromPayload(payload));
      queuePublish();
    });
  }
}
