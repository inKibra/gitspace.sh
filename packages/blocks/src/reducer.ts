import type { RichContentBlock, SideAgentBlock, ToolCallBlock, TransportBlock, TurnBlock, TurnItem } from './model.js';

export interface TranscriptEventInput {
  sessionId: string;
  ordinal: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt?: Date | string;
}

export interface TransportEventInput {
  offset: number;
  operation: string;
  entity: string;
  entityId: string;
  payload: Record<string, unknown>;
  createdAt?: Date | string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function timestamp(value: Date | string | undefined): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const item = record(part);
    return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
  }).join('');
}

function toolTarget(tool: string, args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'url', 'query', 'command', 'name']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim();
  }
  if (tool === 'task' && Array.isArray(args.tasks)) return `${args.tasks.length} side agents`;
  return undefined;
}

function richText(id: string, text: string, language?: string): RichContentBlock[] {
  return text.trim() ? [{ id, type: 'code', text, ...(language ? { language } : {}) }] : [];
}

function subagentResultSummary(value: string): string {
  const output = /<output>\s*([\s\S]*?)\s*<\/output>/u.exec(value)?.[1];
  if (output) {
    try {
      const parsed = JSON.parse(output) as { summary?: unknown };
      if (typeof parsed.summary === 'string' && parsed.summary.trim()) return parsed.summary.trim();
    } catch {}
  }
  return value.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function subagentResultAgent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /<task-result[^>]*\sagent="([^"]+)"/u.exec(value)?.[1];
}

function sideAgents(details: unknown, turnId: string): SideAgentBlock[] {
  const detail = record(details);
  if (!detail) return [];
  const sources = [
    ...(Array.isArray(detail.results) ? detail.results : []),
    ...(Array.isArray(detail.progress) ? detail.progress : []),
    ...(Array.isArray(detail.jobs) ? detail.jobs : []),
  ];
  return sources.flatMap((value, index) => {
    const result = record(value);
    if (!result) return [];
    const agentId = typeof result.id === 'string' ? result.id : `subagent-${index + 1}`;
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : undefined;
    const rawStatus = typeof result.status === 'string' ? result.status : undefined;
    const status: SideAgentBlock['status'] = exitCode !== undefined
      ? exitCode === 0 ? 'done' : 'failed'
      : rawStatus === 'completed' || rawStatus === 'done' ? 'done'
        : rawStatus === 'failed' ? 'failed'
          : rawStatus === 'blocked' ? 'blocked'
            : rawStatus === 'pending' || rawStatus === 'queued' ? 'queued'
              : 'running';
    const rawSummary = [result.summary, result.output, result.resultText, result.assignment]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    const resultAgent = subagentResultAgent(result.resultText);
    return [{
      id: `${turnId}:subagent:${agentId}:${status}`,
      type: 'side-agent' as const,
      agentId,
      label: typeof result.label === 'string' ? result.label : typeof result.description === 'string' ? result.description : agentId,
      ...(typeof result.agent === 'string' ? { agent: result.agent } : resultAgent ? { agent: resultAgent } : {}),
      ...(typeof result.resolvedModel === 'string' ? { model: result.resolvedModel } : typeof result.model === 'string' ? { model: result.model } : typeof result.modelRole === 'string' ? { model: result.modelRole } : {}),
      status,
      ...(rawSummary ? { summary: subagentResultSummary(rawSummary) } : {}),
    }];
  });
}

function findTool(turn: TurnBlock, toolCallId: string): ToolCallBlock | undefined {
  return turn.items.find((item): item is ToolCallBlock => item.type === 'tool-call' && item.toolCallId === toolCallId);
}

function startTurn(event: TranscriptEventInput): TurnBlock {
  return {
    id: `${event.sessionId}:turn:${event.ordinal}`,
    type: 'turn',
    status: 'running',
    startedAt: timestamp(event.createdAt),
    items: [],
    sideAgents: [],
  };
}

export function reduceTranscriptToTurns(events: readonly TranscriptEventInput[]): TurnBlock[] {
  const turns: TurnBlock[] = [];
  let current: TurnBlock | null = null;
  const ensureTurn = (event: TranscriptEventInput): TurnBlock => {
    current ??= startTurn(event);
    return current;
  };
  const commit = (status: TurnBlock['status'], endedAt?: string): void => {
    if (!current) return;
    current.status = status;
    current.endedAt = endedAt;
    if (current.user || current.items.length > 0 || current.sideAgents.length > 0) turns.push(current);
    current = null;
  };

  for (const event of [...events].sort((left, right) => left.ordinal - right.ordinal)) {
    if (event.kind === 'turn_start') {
      commit('done', timestamp(event.createdAt));
      current = startTurn(event);
      continue;
    }
    if (event.kind === 'turn_end' || event.kind === 'agent_end') {
      commit('done', timestamp(event.createdAt));
      continue;
    }
    if (event.kind === 'session_compact' || event.kind === 'compaction') {
      const turn = ensureTurn(event);
      turn.items.push({ id: `${turn.id}:compact:${event.ordinal}`, type: 'interruption', reason: 'compacted', title: 'Context compacted', recovered: true });
      continue;
    }
    if (event.kind === 'message_update') {
      const message = record(event.payload.message);
      if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const turn = ensureTurn(event);
      for (const [index, rawPart] of message.content.entries()) {
        const part = record(rawPart);
        if (!part || typeof part.type !== 'string') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          const id = `${turn.id}:stream:message:${index}`;
          const existing = turn.items.find((item) => item.id === id);
          if (existing?.type === 'message') {
            existing.text = part.text;
            existing.pending = true;
          } else if (part.text) {
            turn.items.push({ id, type: 'message', role: 'assistant', text: part.text, pending: true });
          }
        } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
          const id = `${turn.id}:stream:thinking:${index}`;
          const existing = turn.items.find((item) => item.id === id);
          if (existing?.type === 'thinking') existing.text = part.thinking;
          else if (part.thinking) turn.items.push({ id, type: 'thinking', text: part.thinking });
        }
      }
      continue;
    }
    if (event.kind === 'message_end') {
      const message = record(event.payload.message);
      if (!message || typeof message.role !== 'string') continue;
      if (message.role === 'user') {
        const text = contentText(message.content);
        if (!text) continue;
        // Rehydrated transcripts carry no turn_start/turn_end, so a user message
        // landing on a turn that already has content is the next turn's opener.
        if (current && (current.user || current.items.length > 0)) commit('done', timestamp(event.createdAt));
        const turn = ensureTurn(event);
        turn.user = { id: `${turn.id}:user`, type: 'message', role: 'user', text };
        continue;
      }
      const turn = ensureTurn(event);
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const [index, rawPart] of message.content.entries()) {
          const part = record(rawPart);
          if (!part || typeof part.type !== 'string') continue;
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            const streaming = turn.items.find((item) => item.id === `${turn.id}:stream:message:${index}`);
            if (streaming?.type === 'message') {
              streaming.text = part.text;
              streaming.pending = false;
            } else {
              turn.items.push({ id: `${turn.id}:message:${event.ordinal}:${index}`, type: 'message', role: 'assistant', text: part.text });
            }
          } else if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
            const streaming = turn.items.find((item) => item.id === `${turn.id}:stream:thinking:${index}`);
            if (streaming?.type === 'thinking') streaming.text = part.thinking;
            else turn.items.push({ id: `${turn.id}:thinking:${event.ordinal}:${index}`, type: 'thinking', text: part.thinking });
          } else if (part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
            const args = record(part.arguments) ?? {};
            if (!findTool(turn, part.id)) turn.items.push({
              id: `${turn.id}:tool:${part.id}`,
              type: 'tool-call',
              toolCallId: part.id,
              tool: part.name,
              target: toolTarget(part.name, args),
              status: 'running',
              args,
              input: typeof args.command === 'string' ? richText(`${turn.id}:tool:${part.id}:input`, args.command, 'bash') : undefined,
            });
          }
        }
        continue;
      }
      if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
        const tool = findTool(turn, message.toolCallId);
        if (!tool) continue;
        tool.status = message.isError === true ? 'error' : 'done';
        tool.endedAt = timestamp(event.createdAt);
        tool.details = message.details;
        tool.result = richText(`${tool.id}:result`, contentText(message.content));
        if (tool.tool === 'task' || tool.tool === 'hub') turn.sideAgents.push(...sideAgents(message.details, turn.id));
      }
      continue;
    }
    if (event.kind === 'tool_execution_start') {
      const turn = ensureTurn(event);
      const toolCallId = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : `tool-${event.ordinal}`;
      const tool = typeof event.payload.toolName === 'string' ? event.payload.toolName : 'tool';
      const args = record(event.payload.args) ?? {};
      if (!findTool(turn, toolCallId)) turn.items.push({
        id: `${turn.id}:tool:${toolCallId}`,
        type: 'tool-call',
        toolCallId,
        tool,
        target: toolTarget(tool, args),
        status: 'running',
        startedAt: timestamp(event.createdAt),
        args,
      });
      continue;
    }
    if (event.kind === 'tool_execution_update') {
      const turn = ensureTurn(event);
      const toolCallId = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : '';
      const tool = findTool(turn, toolCallId);
      if (!tool) continue;
      const partial = event.payload.partialResult;
      const text = typeof partial === 'string' ? partial : partial === undefined ? '' : JSON.stringify(partial, null, 2);
      tool.result = richText(`${tool.id}:result`, text);
      continue;
    }
    if (event.kind === 'tool_execution_end') {
      const turn = ensureTurn(event);
      const toolCallId = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : '';
      const tool = findTool(turn, toolCallId);
      if (!tool) continue;
      tool.status = event.payload.isError === true ? 'error' : 'done';
      tool.endedAt = timestamp(event.createdAt);
      tool.details = event.payload.details;
      tool.result = richText(`${tool.id}:result`, typeof event.payload.result === 'string' ? event.payload.result : '');
      if (tool.tool === 'task' || tool.tool === 'hub') turn.sideAgents.push(...sideAgents(event.payload.details, turn.id));
      continue;
    }
    if (event.kind === 'error') {
      const turn = ensureTurn(event);
      turn.items.push({ id: `${turn.id}:error:${event.ordinal}`, type: 'interruption', reason: 'aborted', title: 'Agent turn failed', detail: typeof event.payload.message === 'string' ? event.payload.message : undefined });
      turn.status = 'error';
    }
  }
  const inferredStatus = current?.status === 'error'
    ? 'error'
    : current?.items.some((item) => item.type === 'message' && item.pending || item.type === 'tool-call' && item.status === 'running')
      ? 'running'
      : 'done';
  commit(inferredStatus);
  return turns;
}

export function coalesceTransportEvents(events: readonly TransportEventInput[]): TransportBlock[] {
  const ordered = [...events].sort((left, right) => left.offset - right.offset);
  const blocks: TransportBlock[] = [];
  let disconnected: TransportEventInput | null = null;
  for (const event of ordered) {
    if (event.operation === 'connection-lost') {
      disconnected = event;
      continue;
    }
    if (event.operation === 'connected' && disconnected) {
      const start = disconnected.createdAt ? new Date(disconnected.createdAt).getTime() : 0;
      const end = event.createdAt ? new Date(event.createdAt).getTime() : start;
      const durationMs = Math.max(0, end - start);
      if (durationMs >= 2_000) blocks.push({
        id: `transport:${disconnected.offset}:${event.offset}`,
        type: 'transport',
        status: 'restored',
        title: 'Connection restored',
        durationMs,
      });
      disconnected = null;
      continue;
    }
    if (event.operation === 'code-version') {
      blocks.push({
        id: `transport:${event.offset}`,
        type: 'transport',
        status: 'replaced',
        title: event.entity === 'frontend-generation' ? 'Interface updated' : 'Machine replaced',
        generation: event.entityId,
        detail: event.payload.replacing === true ? 'Agent paused and resumed on the next generation.' : undefined,
      });
    }
  }
  if (disconnected) blocks.push({ id: `transport:${disconnected.offset}`, type: 'transport', status: 'reconnecting', title: 'Reconnecting…' });
  return blocks;
}
