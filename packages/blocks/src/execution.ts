import type { ExecutionBlock } from './model.js';

type Fields = Omit<ExecutionBlock, 'id' | 'executionId' | 'type' | 'historyCount' | 'hasFailures'>;
export interface ExecutionObservation extends Fields {
  executionId: string;
  hasFailures: boolean;
  /** Runtime start timestamp, unlike the observing tool call's own start time. */
  runStartedAt?: string;
  /** An originating Bash/Eval async result, not a Hub observation of that result. */
  launch?: boolean;
}
export interface ExecutionExtraction {
  observations: ExecutionObservation[];
  /** True only when the entire source can be represented by these cards. */
  represented: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function instant(value: unknown): string | undefined {
  if (typeof value === 'string') return Number.isFinite(Date.parse(value)) ? value : undefined;
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : undefined;
}
function compact(value: unknown, limit: number): string | undefined {
  const raw = text(value);
  return raw ? raw.slice(0, limit).trim() || undefined : undefined;
}
function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

/** The namespace is runtime identity, never tool-call, command, label or turn text. */
export function executionIdentity(sessionId: string, namespace: 'job' | 'agent' | 'process', ...identity: (string | number)[]): string {
  return `${sessionId}:execution:${namespace}:${identity.map((part) => encodeURIComponent(String(part))).join(':')}`;
}

/** Recover the explicit agent runtime ID for Inspector, never the display label/role. */
export function executionAgentId(block: ExecutionBlock): string | undefined {
  if (block.kind !== 'agent') return undefined;
  const marker = ':execution:agent:';
  const offset = block.executionId.lastIndexOf(marker);
  if (offset < 0) return undefined;
  try { return decodeURIComponent(block.executionId.slice(offset + marker.length)); }
  catch { return undefined; }
}

function status(value: unknown): ExecutionBlock['status'] | undefined {
  switch (value) {
    case 'pending': case 'queued': case 'starting': return 'queued';
    case 'running': case 'ready': case 'restarting': case 'stopping': return 'running';
    case 'blocked': return 'blocked';
    case 'completed': case 'done': case 'exited': return 'done';
    case 'failed': case 'error': return 'failed';
    case 'aborted': case 'cancelled': return 'cancelled';
    default: return undefined;
  }
}
export function executionSettled(value: ExecutionBlock['status']): boolean {
  return value === 'done' || value === 'failed' || value === 'cancelled';
}

/** Parse only the SDK's task-summary envelope, never job-looking prose. */
function taskEnvelope(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'string') return undefined;
  const tag = /^\s*<task-result\s+([^<>]+)>/u.exec(value);
  if (!tag) return undefined;
  const attributes: Record<string, string> = {};
  for (const match of tag[1]!.matchAll(/\b(id|agent|status)="([^"<>]*)"/gu)) attributes[match[1]!] = match[2]!;
  if (attributes.status === 'merge failed' || /^failed \(exit -?\d+\)$/u.test(attributes.status ?? '')) attributes.status = 'failed';
  return attributes.id ? attributes : undefined;
}
function summary(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (taskEnvelope(value)) {
    const output = /<output>\s*([\s\S]*?)\s*<\/output>/u.exec(value)?.[1];
    if (output) {
      try {
        const parsed = record(JSON.parse(output));
        return compact(parsed?.summary ?? output, 600);
      } catch { return compact(output, 600); }
    }
    return undefined;
  }
  return compact(value, 600);
}

function agentObservation(sessionId: string, source: Record<string, unknown>, observedAt?: string): ExecutionObservation | undefined {
  const id = text(source.id);
  if (!id) return undefined;
  const exitCode = typeof source.exitCode === 'number' ? source.exitCode : undefined;
  const state = source.aborted === true ? 'cancelled'
    : exitCode !== undefined ? exitCode === 0 ? 'done' : 'failed'
      : source.retryState ? 'blocked' : status(source.status);
  if (!state) return undefined;
  const structured = record(source.structuredOutput);
  const failed = state === 'failed' || !!text(source.error) || structured?.status === 'invalid' || structured?.status === 'error';
  const durationMs = number(source.durationMs);
  return {
    executionId: executionIdentity(sessionId, 'agent', id), kind: 'agent',
    label: compact(firstText(source.description, source.label, id), 160)!,
    status: state,
    ...(text(source.agent) ? { agent: compact(source.agent, 160) } : {}),
    ...(firstText(source.resolvedModel, source.model, source.modelRole) ? { model: compact(firstText(source.resolvedModel, source.model, source.modelRole), 160) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(executionSettled(state) && observedAt ? { endedAt: observedAt } : {}),
    summary: summary(firstText(source.error, source.output, source.summary, source.lastIntent, source.assignment)),
    hasFailures: failed,
  };
}

function jobObservation(sessionId: string, source: Record<string, unknown>, completion: boolean, observedAt?: string, launch = false): ExecutionObservation | undefined {
  const id = text(completion ? source.jobId : source.id);
  const type = source.type;
  if (!id || (type !== 'bash' && type !== 'eval' && type !== 'task')) return undefined;
  const envelope = taskEnvelope(source.resultText);
  const agentId = type === 'task' ? text(source.agentUrlId) ?? envelope?.id ?? id : undefined;
  const state = status(source.status) ?? status(envelope?.status) ?? (completion ? 'done' : undefined);
  if (!state) return undefined;
  const schema = record(source.schema ?? source.structured);
  const failed = state === 'failed' || status(envelope?.status) === 'failed' || !!text(source.errorText) || schema?.status === 'invalid' || schema?.status === 'error';
  const durationMs = number(source.durationMs);
  const startedAt = instant(source.startedAt);
  return {
    executionId: agentId ? executionIdentity(sessionId, 'agent', agentId) : executionIdentity(sessionId, 'job', id),
    kind: agentId ? 'agent' : 'job', label: compact(firstText(source.label, id), 160)!, status: state,
    ...(envelope?.agent ? { agent: compact(envelope.agent, 160) } : {}),
    ...(text(source.resolvedModel) ? { model: compact(source.resolvedModel, 160) } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(startedAt ? { startedAt, runStartedAt: startedAt } : {}),
    ...(launch && !agentId ? { launch: true } : {}),
    ...(executionSettled(state) && observedAt ? { endedAt: observedAt } : {}),
    summary: summary(firstText(source.errorText, source.resultText, schema?.error)), hasFailures: failed,
  };
}

function processObservation(sessionId: string, source: Record<string, unknown>): ExecutionObservation | undefined {
  const id = text(source.id);
  const startedAt = instant(source.startedAt);
  const restartCount = number(source.restartCount);
  const state = status(source.state);
  if (!id || !startedAt || restartCount === undefined || !state) return undefined;
  // During restart backoff, startedAt/exitedAt still describe the old run but the
  // broker has already incremented restartCount for the next launch.
  const restarting = source.state === 'restarting';
  const failed = state === 'failed' || restarting && typeof source.exitCode === 'number' && source.exitCode !== 0;
  const endedAt = instant(source.exitedAt);
  return {
    executionId: executionIdentity(sessionId, 'process', id, startedAt, restarting ? Math.max(0, restartCount - 1) : restartCount), kind: 'process',
    label: compact(firstText(source.name, id), 160)!, status: failed ? 'failed' : restarting ? 'done' : state,
    startedAt, ...(endedAt ? { endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) } : {}),
    summary: compact(firstText(source.exitReason, source.readyMatch), 600), hasFailures: failed,
  };
}

/** Extract structured SDK observations without retaining a session-sized identity map. */
export function extractExecutions(input: {
  sessionId: string; tool: string; args?: unknown; details?: unknown; customType?: string;
  observedAt?: string; startedAt?: string; isError?: boolean;
}): ExecutionExtraction {
  const detail = record(input.details);
  if (!detail) return { observations: [], represented: false };
  const args = record(input.args) ?? {};
  const observations: ExecutionObservation[] = [];
  let recognized = 0;
  let total = 0;
  const collect = (values: unknown, extract: (source: Record<string, unknown>) => ExecutionObservation | undefined): void => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      total++;
      const source = record(value);
      const observation = source ? extract(source) : undefined;
      if (observation) { observations.push(observation); recognized++; }
    }
  };
  let represented = true;
  if (input.customType === 'async-result') {
    collect(detail.jobs, (source) => jobObservation(input.sessionId, source, true, input.observedAt));
  } else if (input.customType === 'launch-completion') {
    collect(detail.daemons, (source) => processObservation(input.sessionId, source));
  } else if (input.customType) {
    represented = false;
  } else if (input.tool === 'task') {
    collect(detail.progress, (source) => agentObservation(input.sessionId, source, input.observedAt));
    collect(detail.results, (source) => agentObservation(input.sessionId, source, input.observedAt));
    // async describes the aggregate batch; it is not an additional agent/job.
    if (total === 0) {
      const async = record(detail.async);
      if (async?.type === 'task') collect([{ ...async, status: async.state }], (source) => jobObservation(input.sessionId, source, true, input.observedAt));
    }
  } else if (input.tool === 'bash' || input.tool === 'eval') {
    const async = record(detail.async);
    if (async?.type === input.tool) {
      collect([{ ...async, status: async.state, label: firstText(args.i, args.title, input.tool) }],
        (source) => jobObservation(input.sessionId, source, true, input.observedAt, true));
    }
    if (input.tool === 'eval' && Array.isArray(detail.jsonOutputs)) {
      const statusEvents = [
        ...(Array.isArray(detail.statusEvents) ? detail.statusEvents : []),
        ...(Array.isArray(detail.cells) ? detail.cells.flatMap((cell) => {
          const events = record(cell)?.statusEvents;
          return Array.isArray(events) ? events : [];
        }) : []),
      ];
      // Legacy Eval display values have no invocation ID. Require a witnessed
      // Hub invocation as well as its structured result wrapper; never inspect code.
      if (statusEvents.some((value) => record(value)?.op === 'hub')) {
        let allObserved = detail.jsonOutputs.length > 0;
        for (const value of detail.jsonOutputs) {
          total++;
          const output = record(value);
          const nested = record(output?.details);
          if (typeof output?.text !== 'string' || !nested || typeof nested.op !== 'string'
            || !['wait', 'jobs', 'start', 'ps', 'list', 'logs', 'stop', 'restart', 'describe', 'send', 'cancel'].includes(nested.op)) {
            allObserved = false;
            continue;
          }
          const extracted = extractExecutions({
            sessionId: input.sessionId, tool: 'hub', details: nested,
            observedAt: input.observedAt, isError: output.hasError === true,
          });
          observations.push(...extracted.observations);
          if (extracted.represented) recognized++;
          else allObserved = false;
          if (output.hasError === true || Array.isArray(output.images) && output.images.length > 0) allObserved = false;
        }
        const cell = Array.isArray(detail.cells) && detail.cells.length === 1 ? record(detail.cells[0]) : undefined;
        represented = allObserved && statusEvents.every((value) => {
          const event = record(value);
          return event?.op === 'hub' && !event.hasError && !event.error;
        }) && cell?.status === 'complete' && !cell.hasMarkdown && !detail.isError && !input.isError
          && !(Array.isArray(detail.images) && detail.images.length > 0);
        // SDK Eval merges stdout with display[n] JSON in cell.output. Exact
        // serialization equality proves this single cell has no additional
        // rendered output; truncated/mixed/multi-cell calls remain visible.
        if (represented) {
          try {
            represented = cell?.output === detail.jsonOutputs
              .map((value, index) => `display[${index + 1}]:\n${JSON.stringify(value, null, 2)}`).join('\n\n');
          } catch { represented = false; }
        }
      }
    }
  } else if (input.tool === 'hub') {
    const operation = text(args.op) ?? text(detail.op);
    collect(detail.jobs, (source) => jobObservation(input.sessionId, source, false, input.observedAt));
    if (detail.daemon !== undefined) collect([detail.daemon], (source) => processObservation(input.sessionId, source));
    collect(detail.daemons, (source) => processObservation(input.sessionId, source));
    // Messages, cancellation outcomes, roster rows and partially matched waits have independent meaning.
    represented = operation !== 'send' && operation !== 'cancel' && operation !== 'inbox' && operation !== 'list'
      && !args.from && !args.to && !detail.waited
      && ![detail.inbox, detail.receipts, detail.agents, detail.peers, detail.cancelled].some((value) => Array.isArray(value) && value.length > 0);
    if (Array.isArray(args.ids)) {
      const returned = new Set(Array.isArray(detail.jobs) ? detail.jobs.map((value) => record(value)?.id) : []);
      if (args.ids.some((id) => !returned.has(id))) represented = false;
    }
  } else represented = false;
  if (input.isError) for (const observation of observations) observation.hasFailures = true;
  return { observations, represented: represented && recognized > 0 && recognized === total };
}

/** Terminal observations cannot be revived by stale progress or a duplicate start snapshot. */
export function mergeExecution(previous: ExecutionBlock | undefined, observation: ExecutionObservation, inserted: boolean): ExecutionBlock {
  const previousTerminal = previous && executionSettled(previous.status);
  const incomingTerminal = executionSettled(observation.status);
  const stale = previousTerminal && !incomingTerminal
    || previous !== undefined && observation.status === 'queued' && previous.status !== 'queued'
    || !incomingTerminal && previous?.durationMs !== undefined && observation.durationMs !== undefined && observation.durationMs < previous.durationMs;
  let nextStatus = stale && previous ? previous.status : observation.status;
  if (previous?.status === 'failed' || observation.status === 'failed') nextStatus = 'failed';
  else if (previous?.status === 'cancelled' && nextStatus === 'done') nextStatus = 'cancelled';
  return {
    ...previous,
    id: observation.executionId, executionId: observation.executionId, type: 'execution',
    kind: previous?.kind ?? observation.kind, label: previous?.label ?? observation.label,
    status: nextStatus,
    ...(!stale && observation.agent ? { agent: observation.agent } : {}),
    ...(!stale && observation.model ? { model: observation.model } : {}),
    ...(!stale && observation.summary ? { summary: observation.summary } : {}),
    ...(observation.durationMs !== undefined ? { durationMs: Math.max(previous?.durationMs ?? 0, observation.durationMs) } : {}),
    ...(observation.startedAt ? { startedAt: observation.startedAt } : {}),
    ...(!stale && observation.endedAt ? { endedAt: observation.endedAt } : {}),
    ...(previous?.startedAt ? { startedAt: previous.startedAt } : {}),
    ...(previous?.endedAt ? { endedAt: previous.endedAt } : {}),
    historyCount: (previous?.historyCount ?? 0) + Number(inserted),
    hasFailures: (previous?.hasFailures ?? false) || observation.hasFailures,
  };
}
