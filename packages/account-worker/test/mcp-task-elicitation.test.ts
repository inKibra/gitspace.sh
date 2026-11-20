import { expect, test } from 'vitest';
import { createMcpHandler, inputResponse, Server } from '@modelcontextprotocol/server';
import { CancelTaskResultV2Schema, DetailedTaskV2Schema, GetTaskResultV2Schema, UpdateTaskResultV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { createRuntimeHarness, McpElicitationsDoc, QuestionsDoc, type ToolServices } from '@gitspace/runtime-core';
import { createSessionControls } from '@gitspace/runtime-core/session-controls';
import { RuntimeIdentitySchema, RuntimeMcpTaskReferenceSchema, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { callMcpTool, connectMcp } from '../src/mcp-client.js';

const TASKS = 'io.modelcontextprotocol/tasks';
const FORM = { type: 'object', properties: { format: { type: 'string', enum: ['pdf', 'html'] } }, required: ['format'] } as const;
const TaskIdSchema = z.object({ taskId: z.string() }).loose();

/**
 * A 2026-07-28 server with the Tasks extension whose `render` starts a task. The task asks for a form (`input_required`)
 * until `tasks/update` brings the answer, then completes with what it got. `received` records every answer it got and
 * `calls` every `tools/call`. One server instance per request; the tasks live across them.
 */
function tasksServer() {
  const received: unknown[] = [];
  const calls: string[] = [];
  const tasks = new Map<string, { answer: unknown }>();
  const createdAt = new Date().toISOString();
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'tasker', version: '1.0.0' }, { capabilities: { tools: {}, extensions: { [TASKS]: {} } } });
    server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'render', inputSchema: { type: 'object', properties: {} } }] }));
    server.setRequestHandler('tools/call', async message => {
      calls.push(message.params.name);
      const taskId = `task-${tasks.size + 1}`;
      tasks.set(taskId, { answer: undefined });
      return { content: [], resultType: 'task', taskId, status: 'working', createdAt, lastUpdatedAt: createdAt, ttlMs: 3_600_000, pollIntervalMs: 10 };
    });
    server.setRequestHandler('tasks/get', { params: TaskIdSchema, result: GetTaskResultV2Schema }, async params => {
      const task = tasks.get(params.taskId);
      if (!task) throw new Error('Task not found');
      const base = { taskId: params.taskId, createdAt, lastUpdatedAt: new Date().toISOString(), ttlMs: 3_600_000, pollIntervalMs: 10 };
      return DetailedTaskV2Schema.parse(task.answer === undefined
        ? { ...base, status: 'input_required', statusMessage: 'Which format?', inputRequests: { format: { method: 'elicitation/create', params: { mode: 'form', message: 'Which format?', requestedSchema: FORM } } } }
        : { ...base, status: 'completed', result: { resultType: 'complete', content: [{ type: 'text', text: `rendered ${JSON.stringify(task.answer)}` }] } });
    });
    server.setRequestHandler('tasks/update', { params: TaskIdSchema, result: UpdateTaskResultV2Schema }, async (params, ctx) => {
      const task = tasks.get(params.taskId);
      const response = inputResponse(ctx.mcpReq.inputResponses, 'format');
      if (task && response.kind === 'elicit') {
        const answer = { action: response.action, ...response.content ? { content: response.content } : {} };
        received.push(answer);
        task.answer = answer;
      }
      return {};
    });
    server.setRequestHandler('tasks/cancel', { params: TaskIdSchema, result: CancelTaskResultV2Schema }, async () => ({}));
    return server;
  });
  const connect = () => connectMcp({ type: 'http', url: 'https://tasks.test/mcp', timeout: 5_000, fetch: (input, init) => handler.fetch(new Request(input, init)) });
  return { received, calls, connect };
}
const source = { connection: 'Tasker', server: 'tasker 1.0.0', workspace: 'Workspace' };
const endpoint = { connectionId: 'tasker', url: 'https://tasks.test/mcp' };

test('a server\'s task asking for input within the window gets the answer through tasks/update, and its result', async () => {
  const server = tasksServer();
  const connection = await server.connect();
  const scopes: string[] = [];
  try {
    const outcome = await callMcpTool(connection, { endpoint, name: 'render', arguments: {}, task: null, timeout: 5_000, source, elicit: async input => { scopes.push(`${input.scope}:${input.taskId}:${input.inputId}`); return { action: 'accept', content: { format: 'pdf' } }; } });
    expect(scopes).toEqual(['task:task-1:format']);
    expect(server.received).toEqual([{ action: 'accept', content: { format: 'pdf' } }]);
    expect(outcome).toMatchObject({ kind: 'result', result: { content: [{ type: 'text', text: 'rendered {"action":"accept","content":{"format":"pdf"}}' }] } });
  } finally { await connection.client.close(); }
});

const model: Model<Api> = { id: 'mcp', name: 'MCP', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };

test('a server\'s task nobody answers in time is handed off and the turn ends; answered, the task is resumed, given the answer, and its result is the agent\'s next input', async () => {
  const server = tasksServer();
  const requests: string[] = [];
  let arrived = Promise.withResolvers<void>();
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, input: { messages: unknown[] }) {
    const call = requests.length === 0;
    const reply: AssistantMessage = { role: 'assistant', content: call ? [{ type: 'toolCall', id: 'script', name: 'codemode', arguments: { code: 'await tools.mcp_invoke({ connectionId: "tasker", name: "render" });' } }] : [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    requests.push(JSON.stringify(input.messages));
    const done = arrived; arrived = Promise.withResolvers(); done.resolve();
    return stream;
  } });
  const completed = (input: { requestId: string; attemptId: string }, text: string): RuntimeToolResult => ({ requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text }] });
  // The cloud host's `mcp_invoke` (`runtime-services.ts`): the real client, a handed-off task as `mcpTask`.
  const invoke: ToolServices['invoke'] = async input => {
    if (input.tool === 'codemode') return completed(input, JSON.stringify(await input.codemodeTools?.({ tool: 'mcp_invoke', args: { connectionId: 'tasker', name: 'render', arguments: {} }, callId: 'mcp', signal: new AbortController().signal })));
    const connection = await server.connect();
    try {
      const outcome = await callMcpTool(connection, { endpoint, name: 'render', arguments: {}, task: input.mcpTask ?? null, timeout: 5_000, source, elicit: input.mcpElicit ?? null });
      if (outcome.kind === 'handoff') return { ...completed(input, JSON.stringify({ task: outcome.reference.taskId })), mcpTask: { reference: RuntimeMcpTaskReferenceSchema.parse(outcome.reference), connection: 'Tasker', status: outcome.status } };
      return completed(input, JSON.stringify(outcome.result));
    } finally { await connection.client.close(); }
  };
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused }, mcpElicitationWindowMs: 30 },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, async wakeAt() {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: () => {}, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  const controls = createSessionControls({ ...runtime, admitInference: unused, reload: async () => {}, catalog: async () => ({ models: [], roles: [] }),
    history: { conversation: unused, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unused, resolve: unused, transcriptPage: unused, transcriptContent: unused, usage: unused } });
  try {
    await runtime.root.submit({ type: 'input', requestId: 'render', content: 'Render it' }, context);
    await runtime.root.waitForIdle(context);
    // Nobody answered in the window: the task was handed off and the turn ended; the server got nothing.
    expect(requests).toHaveLength(1);
    expect(server.received).toEqual([]);
    const [call] = Object.values((await runtime.harness.snapshot(McpElicitationsDoc, context))?.calls ?? {});
    expect(call).toMatchObject({ state: 'waiting', task: { generation: 'v2', taskId: 'task-1', originalOperation: 'tools/call' } });
    const asked = (await runtime.harness.snapshot(QuestionsDoc, context))?.items.find(item => item.kind === 'mcp-elicitation');
    if (!asked) throw new Error('No question was posted');
    expect(asked.mcpElicitation).toMatchObject({ scope: 'task', taskId: 'task-1', request: { mode: 'form', message: 'Which format?' } });
    await controls.execute(String(runtime.root.id), { type: 'answerAsk', id: asked.id, answers: [{ id: asked.id, selectedOptions: [], customInput: JSON.stringify({ format: 'html' }) }] }, false, 'device');
    while (requests.length < 2) await arrived.promise;
    // The task was resumed, not called again, and the answer went back through tasks/update.
    expect(server.calls).toEqual(['render']);
    expect(server.received).toEqual([{ action: 'accept', content: { format: 'html' } }]);
    expect(requests[1]).toContain('Tasker\'s render finished after GitSpace continued it (following its task task-1)');
    expect(requests[1]).toContain('rendered {\\\\\\"action\\\\\\":\\\\\\"accept\\\\\\",\\\\\\"content\\\\\\":{\\\\\\"format\\\\\\":\\\\\\"html\\\\\\"}}');
  } finally { await runtime.harness.close(context); }
}, 20_000);
