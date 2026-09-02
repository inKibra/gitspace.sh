import type { DiscoveredMcpTool } from '@gitspace/protocol';

type InitMessage = { type: 'execute'; code: string; tools: DiscoveredMcpTool[] };
type CallResultMessage = { type: 'call-result'; id: number; value?: unknown; error?: string };
type IncomingMessage = InitMessage | CallResultMessage;

type OutgoingMessage =
  | { type: 'call'; id: number; name: string; args: Record<string, unknown> }
  | { type: 'result'; value: unknown }
  | { type: 'error'; error: string };

const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let callId = 0;

function isTextContent(value: unknown): value is { type: 'text'; text: string } {
  return !!value
    && typeof value === 'object'
    && 'type' in value
    && value.type === 'text'
    && 'text' in value
    && typeof value.text === 'string';
}

const FORBIDDEN_RUNTIME_ACCESS = /\b(?:Bun|Deno|EventSource|Function|WebSocket|eval|fetch|globalThis|process|require)\b|\bimport\s*\(/u;

function normalized(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const record = result as Record<string, unknown>;
  if (record.details !== undefined && record.details !== null) return record.details;
  if (!Array.isArray(record.content)) return result;
  const text = record.content
    .filter(isTextContent)
    .map((part) => part.text)
    .join('\n');
  if (!text) return result;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function searchable(tool: DiscoveredMcpTool): string {
  return `${tool.connectionId} ${tool.connectionLabel} ${tool.name} ${tool.ompToolName} ${tool.description ?? ''}`.toLowerCase();
}

function execute(message: InitMessage): void {
  if (FORBIDDEN_RUNTIME_ACCESS.test(message.code)) {
    postMessage({ type: 'error', error: 'MCP code mode only exposes the grant-scoped integrations API; direct runtime, module, filesystem, process, and network access is unavailable.' } satisfies OutgoingMessage);
    return;
  }
  const byConnection = new Map<string, DiscoveredMcpTool[]>();
  for (const tool of message.tools) byConnection.set(tool.connectionId, [...(byConnection.get(tool.connectionId) ?? []), tool]);

  const call = (name: string, args: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
    const id = ++callId;
    pending.set(id, { resolve, reject });
    postMessage({ type: 'call', id, name, args } satisfies OutgoingMessage);
  }).then(normalized);

  const search = (query: string, options?: { limit?: number }) => {
    const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
    const matches = message.tools.map((tool) => ({ tool, score: terms.reduce((score, term) => score + (searchable(tool).includes(term) ? 1 : 0), 0) }))
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score || left.tool.connectionLabel.localeCompare(right.tool.connectionLabel) || left.tool.name.localeCompare(right.tool.name));
    return matches.slice(0, Math.max(1, Math.min(50, options?.limit ?? 10))).map(({ tool }) => tool);
  };

  const describe = (name: string) => {
    const tool = message.tools.find((candidate) => candidate.ompToolName === name || candidate.name === name || `${candidate.connectionId}.${candidate.name}` === name);
    if (!tool) throw new Error(`MCP tool ${name} is unavailable. Use integrations.search() for the current grant-scoped catalog.`);
    return tool;
  };

  const use = (connectionId: string) => {
    const connectionTools = byConnection.get(connectionId);
    if (!connectionTools) throw new Error(`MCP connection ${connectionId} is unavailable to this project session.`);
    return Object.freeze({
      searchTools(query: string, options?: { limit?: number }) {
        const matches = search(query, { limit: 50 }).filter((tool) => tool.connectionId === connectionId);
        return matches.slice(0, Math.max(1, Math.min(50, options?.limit ?? 10)));
      },
      describeTool(name: string) {
        const tool = connectionTools.find((candidate) => candidate.name === name || candidate.ompToolName === name);
        if (!tool) throw new Error(`Tool ${name} is unavailable on connection ${connectionId}.`);
        return tool;
      },
      tool(name: string, args: Record<string, unknown> = {}) {
        const tool = connectionTools.find((candidate) => candidate.name === name || candidate.ompToolName === name);
        if (!tool) throw new Error(`Tool ${name} is unavailable on connection ${connectionId}.`);
        return call(tool.ompToolName, args);
      },
    });
  };

  const integrations = Object.freeze({
    use,
    search,
    describe,
    call,
    tools: Object.freeze(Object.fromEntries(message.tools.map((tool) => [tool.ompToolName, (args: Record<string, unknown> = {}) => call(tool.ompToolName, args)]))),
    ALL_TOOLS: Object.freeze(message.tools),
  });

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
  const run = new AsyncFunction('integrations', 'search', 'describe', 'call', 'tools', 'ALL_TOOLS', 'fetch', 'WebSocket', 'EventSource', 'process', 'Bun', 'require', 'globalThis', `"use strict";\n${message.code}`);
  void run(integrations, search, describe, call, integrations.tools, integrations.ALL_TOOLS, undefined, undefined, undefined, undefined, undefined, undefined, undefined)
    .then((value) => postMessage({ type: 'result', value } satisfies OutgoingMessage))
    .catch((error) => postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) } satisfies OutgoingMessage));
}

globalThis.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (message.type === 'execute') {
    execute(message);
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error));
  else request.resolve(message.value);
};
