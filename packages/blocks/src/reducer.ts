import type { AskBlock, MessageImage, RichContentBlock, ToolCallBlock, TransportBlock, TurnBlock } from './model.js';
import type { TranscriptItem } from './history.js';
import { executionIdentity, executionSettled, extractExecutions, mergeExecution } from './execution.js';

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

const IMAGE_MIME_TYPES: Record<MessageImage['mimeType'], true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
};

function contentImages(content: unknown): MessageImage[] {
  if (!Array.isArray(content)) return [];
  const images: MessageImage[] = [];
  for (const part of content) {
    const item = record(part);
    if (
      item?.type !== 'image'
      || typeof item.data !== 'string'
      || !item.data
      || typeof item.mimeType !== 'string'
      || IMAGE_MIME_TYPES[item.mimeType as MessageImage['mimeType']] !== true
    ) continue;
    images.push({ data: item.data, mimeType: item.mimeType as MessageImage['mimeType'] });
  }
  return images;
}

function richImages(id: string, content: unknown): RichContentBlock[] {
  return contentImages(content).map((image, index) => ({
    id: `${id}:${index}`,
    type: 'image',
    url: `data:${image.mimeType};base64,${image.data}`,
    alt: `Tool output image ${index + 1}`,
  }));
}

function toolTarget(tool: string, args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'file_path', 'url', 'query', 'command', 'name']) {
    if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim();
  }
  if (tool === 'task' && Array.isArray(args.tasks)) return `${args.tasks.length} side agents`;
  return undefined;
}
function askQuestions(args: Record<string, unknown>): AskBlock['questions'] {
  if (!Array.isArray(args.questions)) return [];
  return args.questions.flatMap((rawQuestion, index) => {
    const question = record(rawQuestion);
    if (!question || typeof question.question !== 'string') return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          if (typeof rawOption === 'string') return [{ id: rawOption, title: rawOption }];
          const option = record(rawOption);
          if (!option || typeof option.label !== 'string') return [];
          return [{
            id: option.label,
            title: option.label,
            ...(typeof option.description === 'string' ? { description: option.description } : {}),
            ...(typeof option.preview === 'string' ? { preview: option.preview } : {}),
          }];
        })
      : undefined;
    return [{
      id: typeof question.id === 'string' ? question.id : `question-${index + 1}`,
      prompt: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(options?.length ? { options } : {}),
      ...(question.multi === true ? { multiple: true } : {}),
      ...(typeof question.recommended === 'number' && Number.isInteger(question.recommended) && question.recommended >= 0
        ? { recommended: question.recommended } : {}),
    }];
  });
}
function applyAskAnswers(ask: AskBlock, details: unknown): void {
  const root = record(details);
  if (!root) return;
  const results = Array.isArray(root.results) ? root.results : [root];
  for (const rawResult of results) {
    const result = record(rawResult);
    if (!result) continue;
    const question = typeof result.id === 'string'
      ? ask.questions.find((candidate) => candidate.id === result.id)
      : typeof result.question === 'string'
        ? ask.questions.find((candidate) => candidate.prompt === result.question)
        : ask.questions.length === 1
          ? ask.questions[0]
          : undefined;
    if (!question) continue;
    const selected = Array.isArray(result.selectedOptions)
      ? result.selectedOptions.filter((option): option is string => typeof option === 'string')
      : [];
    const custom = typeof result.customInput === 'string' && result.customInput.trim()
      ? [result.customInput.trim()]
      : [];
    const answer = [...selected, ...custom];
    if (answer.length === 1 && !question.multiple) question.answer = answer[0];
    else if (answer.length > 0) question.answer = answer;
  }
}

function richText(id: string, text: string, language?: string): RichContentBlock[] {
  return text.trim() ? [{ id, type: 'code', text, ...(language ? { language } : {}) }] : [];
}


export interface TranscriptProjectionStore {
  read(id: string): TranscriptItem | undefined;
  owner(id: string): string | undefined;
  write(turnId: string, item: TranscriptItem): void;
  turn(id: string, status: TurnBlock['status']): void;
  /** Preserve original source rows; return true only for a newly inserted membership. */
  linkExecution(executionId: string, rowId: string, hide: boolean): boolean;
  /** Prior source membership wins over the latest raw-runtime-ID binding. */
  executionRun(identity: string, rowId: string): string | undefined;
  bindExecutionRun(identity: string, executionId: string): void;
}

interface ProjectionTurn {
  id: string;
  hasContent: boolean;
  pending: number;
  failed: boolean;
}

interface ProjectionMessage {
  ordinal: number;
  parts: Map<number, 'message' | 'thinking'>;
}

function pendingItem(item: TranscriptItem | undefined): number {
  return Number(item?.type === 'message' && item.pending === true
    || item?.type === 'tool-call' && item.status === 'running'
    || item?.type === 'ask' && item.status === 'pending');
}

/**
 * Incremental, ordered-event projection. Only current-message identities and
 * turn counters live here; the store owns every full item, including old tools.
 * Replay the same source ordinals into a fresh projector when rebuilding.
 */
export class TranscriptProjector {
  #current: ProjectionTurn | undefined;
  #message: ProjectionMessage | undefined;

  constructor(private readonly sessionId: string, private readonly store: TranscriptProjectionStore) {}

  #ensureTurn(event: TranscriptEventInput): ProjectionTurn {
    if (!this.#current) {
      this.#current = { id: `${this.sessionId}:turn:${event.ordinal}`, hasContent: false, pending: 0, failed: false };
      this.store.turn(this.#current.id, 'running');
    }
    return this.#current;
  }

  #commit(status: TurnBlock['status']): void {
    if (this.#current) this.store.turn(this.#current.id, status);
    this.#current = undefined;
    this.#message = undefined;
  }

  #write(item: TranscriptItem, previous = this.store.read(item.id)): void {
    const turn = this.#current!;
    if (!previous || this.store.owner(item.id) === turn.id) turn.pending += pendingItem(item) - pendingItem(previous);
    if (item.type !== 'side-agent') turn.hasContent = true;
    this.store.write(turn.id, item);
  }

  #executions(source: ToolCallBlock, final: boolean, customType?: string): void {
    const extracted = extractExecutions({
      sessionId: this.sessionId, tool: source.tool, args: source.args, details: source.details,
      startedAt: source.startedAt, observedAt: source.endedAt, isError: source.status === 'error', customType,
    });
    let represented = extracted.represented;
    const correlated = extracted.observations.filter((observation) => {
      if (observation.kind !== 'job') return true;
      const identity = observation.executionId;
      const bound = this.store.executionRun(identity, source.id);
      const boundItem = bound ? this.store.read(bound) : undefined;
      const originId = `${identity}:run:${encodeURIComponent(source.id)}`;
      const exactId = observation.runStartedAt ? `${identity}:run:${encodeURIComponent(observation.runStartedAt)}` : undefined;
      if (!observation.launch && !exactId && boundItem?.type === 'execution'
        && executionSettled(boundItem.status) && !executionSettled(observation.status)) {
        // bg_N is reusable after eviction or restart. Without a new launch/run
        // token, this could be either stale progress or a different runtime run.
        represented = false;
        return false;
      }
      const executionId = observation.launch
        ? this.store.read(originId)?.type === 'execution' ? originId : exactId ?? originId
        : exactId ?? bound ?? `${identity}:run:observed:${encodeURIComponent(source.id)}`;
      if (!this.store.read(executionId)) this.store.bindExecutionRun(identity, executionId);
      observation.executionId = executionId;
      return true;
    });
    for (const observation of correlated) {
      const previous = this.store.read(observation.executionId);
      const inserted = this.store.linkExecution(observation.executionId, source.id, final && represented);
      this.#write(mergeExecution(previous?.type === 'execution' ? previous : undefined, observation, inserted), previous);
    }
    // These are live registry agents explicitly lacking a backing job, not arbitrary job rows.
    const details = record(source.details);
    if (source.tool === 'hub' && Array.isArray(details?.agents)) for (const value of details.agents) {
      const agent = record(value);
      if (typeof agent?.id !== 'string') continue;
      if (this.store.read(executionIdentity(this.sessionId, 'agent', agent.id))?.type === 'execution') continue;
      this.#write({
        id: `${this.sessionId}:side-agent:${encodeURIComponent(agent.id)}`, type: 'side-agent', agentId: agent.id,
        label: agent.id, status: agent.live === false ? 'queued' : 'running',
        ...(typeof agent.activity === 'string' ? { summary: agent.activity.slice(0, 600) } : {}),
      });
    }
  }

  #toolId(toolCallId: string, type: 'tool' | 'ask'): string {
    return `${this.sessionId}:${type}:${toolCallId}`;
  }

  #findTool(toolCallId: string): ToolCallBlock | undefined {
    const item = this.store.read(this.#toolId(toolCallId, 'tool'));
    return item?.type === 'tool-call' ? item : undefined;
  }

  #findAsk(toolCallId: string): AskBlock | undefined {
    const item = this.store.read(this.#toolId(toolCallId, 'ask'));
    return item?.type === 'ask' ? item : undefined;
  }

  #startTool(toolCallId: string, tool: string, args: Record<string, unknown>, startedAt?: string, includeInput = false): void {
    if (tool === 'ask') {
      if (!this.#findAsk(toolCallId)) this.#write({
        id: this.#toolId(toolCallId, 'ask'),
        type: 'ask',
        toolCallId,
        status: 'pending',
        questions: askQuestions(args),
      });
    } else if (!this.#findTool(toolCallId)) {
      const id = this.#toolId(toolCallId, 'tool');
      this.#write({
        id,
        type: 'tool-call',
        toolCallId,
        tool,
        target: toolTarget(tool, args),
        status: 'running',
        ...(startedAt ? { startedAt } : {}),
        args,
        ...(includeInput && typeof args.command === 'string' ? { input: richText(`${id}:input`, args.command, 'bash') } : {}),
      });
    }
  }

  #answerAsk(toolCallId: string, isError: boolean, details: unknown): boolean {
    const previous = this.#findAsk(toolCallId);
    if (!previous) return false;
    const ask: AskBlock = {
      ...previous,
      status: isError ? 'dismissed' : 'answered',
      questions: previous.questions.map((question) => ({ ...question })),
    };
    applyAskAnswers(ask, details);
    this.#write(ask, previous);
    return true;
  }

  #assistantParts(event: TranscriptEventInput, content: unknown[], final: boolean): void {
    const turn = this.#ensureTurn(event);
    const message = this.#message ??= { ordinal: event.ordinal, parts: new Map() };
    for (const [index, rawPart] of content.entries()) {
      const part = record(rawPart);
      if (!part || typeof part.type !== 'string') continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        const id = `${turn.id}:message:${message.ordinal}:${index}`;
        const previous = this.store.read(id);
        if (previous?.type === 'message' || (final ? part.text.trim() : part.text)) {
          this.#write({
            id,
            type: 'message',
            role: 'assistant',
            text: part.text,
            ...(!final ? { pending: true } : previous?.type === 'message' ? { pending: false } : {}),
          }, previous);
          message.parts.set(index, 'message');
        }
      } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
        const id = `${turn.id}:thinking:${message.ordinal}:${index}`;
        const previous = this.store.read(id);
        if (previous?.type === 'thinking' || (final ? part.thinking.trim() : part.thinking)) {
          this.#write({ id, type: 'thinking', text: part.thinking }, previous);
          message.parts.set(index, 'thinking');
        }
      } else if (final && part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') {
        this.#startTool(part.id, part.name, record(part.arguments) ?? {}, undefined, true);
      }
    }
    if (final) this.#finishMessage();
  }

  #finishMessage(): void {
    if (!this.#message || !this.#current) return;
    for (const [index, type] of this.#message.parts) {
      if (type !== 'message') continue;
      const id = `${this.#current.id}:message:${this.#message.ordinal}:${index}`;
      const previous = this.store.read(id);
      if (previous?.type === 'message' && previous.pending) this.#write({ ...previous, pending: false }, previous);
    }
    this.#message = undefined;
  }

  apply(event: TranscriptEventInput): void {
    if (event.kind === 'turn_start') {
      this.#commit('done');
      this.#ensureTurn(event);
      return;
    }
    if (event.kind === 'turn_end' || event.kind === 'agent_end') {
      this.#commit('done');
      return;
    }
    if (event.kind === 'session_compact' || event.kind === 'compaction') {
      const turn = this.#ensureTurn(event);
      this.#write({ id: `${turn.id}:compact:${event.ordinal}`, type: 'interruption', reason: 'compacted', title: 'Context compacted', recovered: true });
      return;
    }
    if (event.kind === 'message_start') {
      if (record(event.payload.message)?.role === 'assistant') {
        this.#ensureTurn(event);
        this.#finishMessage();
        this.#message = { ordinal: event.ordinal, parts: new Map() };
      }
      return;
    }
    if (event.kind === 'message_update') {
      const message = record(event.payload.message);
      if (message?.role === 'assistant' && Array.isArray(message.content)) this.#assistantParts(event, message.content, false);
      return;
    }
    if (event.kind === 'message_end') {
      const message = record(event.payload.message);
      if (!message || typeof message.role !== 'string') return;
      if (message.role === 'user') {
        const text = contentText(message.content);
        const images = contentImages(message.content);
        if (!text && images.length === 0) return;
        // Saved transcripts omit turn markers: the next user opens a new turn.
        if (this.#current?.hasContent) this.#commit('done');
        const turn = this.#ensureTurn(event);
        this.#write({ id: `${turn.id}:user`, type: 'message', role: 'user', text, ...(images.length ? { images } : {}) });
        return;
      }
      const turn = this.#ensureTurn(event);
      if (message.role === 'custom' && message.customType === 'gitspace-instructions-changed' && message.display === true) {
        this.#write({ id: `${turn.id}:instructions:${event.ordinal}`, type: 'interruption', reason: 'rule', title: 'Workspace instructions changed', detail: contentText(message.content), recovered: true });
        return;
      }
      if (message.role === 'custom' && (message.display === true || message.customType === 'async-result' || message.customType === 'launch-completion')) {
        const id = `${turn.id}:custom:${event.ordinal}`;
        const source: ToolCallBlock = {
          id, type: 'tool-call', toolCallId: id, tool: typeof message.customType === 'string' ? message.customType : 'custom',
          status: 'done', endedAt: timestamp(event.createdAt), details: message.details,
          result: [...richText(`${id}:result`, contentText(message.content)), ...richImages(`${id}:image`, message.content)],
        };
        this.#write(source);
        this.#executions(source, true, source.tool);
        return;
      }
      if (message.role === 'assistant') {
        if (Array.isArray(message.content)) this.#assistantParts(event, message.content, true);
        else if (typeof message.content === 'string') this.#assistantParts(event, [{ type: 'text', text: message.content }], true);
        else this.#finishMessage();
        return;
      }
      if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
        if (this.#answerAsk(message.toolCallId, message.isError === true, message.details)) return;
        const tool = this.#findTool(message.toolCallId);
        if (!tool) return;
        const completed: ToolCallBlock = {
          ...tool,
          status: message.isError === true ? 'error' : 'done',
          endedAt: timestamp(event.createdAt),
          details: message.details ?? tool.details,
          result: [
            ...richText(`${tool.id}:result`, contentText(message.content)),
            ...richImages(`${tool.id}:result:image`, message.content),
          ],
        };
        this.#write(completed, tool);
        this.#executions(completed, true);
      }
      return;
    }
    if (event.kind === 'tool_execution_start') {
      this.#ensureTurn(event);
      this.#startTool(
        typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : `tool-${event.ordinal}`,
        typeof event.payload.toolName === 'string' ? event.payload.toolName : 'tool',
        record(event.payload.args) ?? {},
        timestamp(event.createdAt),
      );
      return;
    }
    if (event.kind === 'tool_execution_update') {
      this.#ensureTurn(event);
      const tool = this.#findTool(typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : '');
      if (!tool) return;
      const partial = event.payload.partialResult;
      const result = record(partial);
      const text = typeof partial === 'string' ? partial : result?.content !== undefined
        ? contentText(result.content) : partial === undefined ? '' : JSON.stringify(partial, null, 2);
      const updated: ToolCallBlock = {
        ...tool, details: result?.details ?? tool.details,
        result: [...richText(`${tool.id}:result`, text), ...richImages(`${tool.id}:result:image`, result?.content)],
      };
      this.#write(updated, tool);
      this.#executions(updated, false);
      return;
    }
    if (event.kind === 'tool_execution_end') {
      this.#ensureTurn(event);
      const toolCallId = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : '';
      if (this.#answerAsk(toolCallId, event.payload.isError === true, event.payload.details)) return;
      const tool = this.#findTool(toolCallId);
      if (!tool) return;
      const result = record(event.payload.result);
      const completed: ToolCallBlock = {
        ...tool,
        status: event.payload.isError === true ? 'error' : 'done',
        endedAt: timestamp(event.createdAt),
        details: event.payload.details ?? result?.details ?? tool.details,
        result: [
          ...richText(`${tool.id}:result`, typeof event.payload.result === 'string' ? event.payload.result : contentText(result?.content)),
          ...richImages(`${tool.id}:result:image`, result?.content),
        ],
      };
      this.#write(completed, tool);
      this.#executions(completed, true);
      return;
    }
    if (event.kind === 'error') {
      const turn = this.#ensureTurn(event);
      this.#write({ id: `${turn.id}:error:${event.ordinal}`, type: 'interruption', reason: 'aborted', title: 'Agent turn failed', detail: typeof event.payload.message === 'string' ? event.payload.message : undefined });
      turn.failed = true;
      this.store.turn(turn.id, 'error');
    }
  }

  /** Publish the inferred status without ending the active turn or message. */
  flush(): void {
    if (this.#current) this.store.turn(this.#current.id, this.#current.failed ? 'error' : this.#current.pending > 0 ? 'running' : 'done');
  }
}

export interface CollectedTranscriptProjection {
  turns: TurnBlock[];
  rows: { turnId: string; item: TranscriptItem }[];
  links: { executionId: string; rowId: string; hide: boolean }[];
}

/** Full ordered sources and memberships for disk/cloud indexing; turns are the visible view only. */
export function collectTranscriptProjection(events: readonly TranscriptEventInput[]): CollectedTranscriptProjection {
  const ordered = [...events].sort((left, right) => left.ordinal - right.ordinal);
  const turns = new Map<string, TurnBlock>();
  const items = new Map<string, { turnId: string; item: TranscriptItem }>();
  const memberships = new Map<string, Map<string, boolean>>();
  const hidden = new Set<string>();
  const runs = new Map<string, string>();
  const rowExecutions = new Map<string, Set<string>>();
  let currentEvent: TranscriptEventInput | undefined;
  const projector = new TranscriptProjector(ordered[0]?.sessionId ?? '', {
    read: (id) => items.get(id)?.item,
    owner: (id) => items.get(id)?.turnId,
    turn: (id, status) => {
      let turn = turns.get(id);
      if (!turn) {
        turn = { id, type: 'turn', status, startedAt: timestamp(currentEvent?.createdAt), items: [], sideAgents: [] };
        turns.set(id, turn);
      }
      turn.status = status;
      if (status === 'done' && currentEvent && (currentEvent.kind === 'turn_start' || currentEvent.kind === 'turn_end'
        || currentEvent.kind === 'agent_end' || currentEvent.kind === 'message_end' && record(currentEvent.payload.message)?.role === 'user')) {
        turn.endedAt = timestamp(currentEvent.createdAt);
      }
    },
    write: (turnId, item) => {
      items.set(item.id, { turnId: items.get(item.id)?.turnId ?? turnId, item });
    },
    executionRun: (identity, rowId) => {
      for (const executionId of rowExecutions.get(rowId) ?? []) {
        if (executionId === identity || executionId.startsWith(`${identity}:run:`)) return executionId;
      }
      return runs.get(identity);
    },
    bindExecutionRun: (identity, executionId) => { runs.set(identity, executionId); },
    linkExecution: (executionId, rowId, hide) => {
      let members = memberships.get(executionId);
      if (!members) memberships.set(executionId, members = new Map());
      const inserted = !members.has(rowId);
      members.set(rowId, hide || members.get(rowId) === true);
      let rowMembers = rowExecutions.get(rowId);
      if (!rowMembers) rowExecutions.set(rowId, rowMembers = new Set());
      rowMembers.add(executionId);
      if (hide) hidden.add(rowId);
      return inserted;
    },
  });
  for (const event of ordered) {
    currentEvent = event;
    projector.apply(event);
  }
  currentEvent = undefined;
  projector.flush();
  for (const { turnId, item } of items.values()) {
    if (hidden.has(item.id)) continue;
    const turn = turns.get(turnId)!;
    if (item.type === 'message' && item.role === 'user') turn.user = item;
    else if (item.type === 'side-agent') turn.sideAgents.push(item);
    else turn.items.push(item);
  }
  return {
    turns: [...turns.values()].filter((turn) => turn.user || turn.items.length || turn.sideAgents.length),
    rows: [...items.values()],
    links: [...memberships].flatMap(([executionId, members]) => [...members].map(([rowId, hide]) => ({ executionId, rowId, hide }))),
  };
}

export function reduceTranscriptToTurns(events: readonly TranscriptEventInput[]): TurnBlock[] {
  return collectTranscriptProjection(events).turns;
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
