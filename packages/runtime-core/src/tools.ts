import { defineTool, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { JsonValue, Context } from '@earendil-works/chord';
import { RuntimeJsonSchema, RuntimeToolResultSchema, RuntimeBrowserArgumentsSchema, receiptDigest, type RuntimeBrowserApprovalCard, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { PlanDoc, QuestionsDoc, TodosDoc, WorkspaceDoc, CronScopeDoc } from './documents.js';
import { enforceSessionApproval } from './session-controls.js';
import { createJobTool, type JobServices } from './jobs.js';
export type ToolServices = {
  invoke(input: { tool: string; args: JsonValue; conversationId: string; taskId: string; requestId: string; attemptId: string; replay: 'safe' | 'unsafe'; signal?: AbortSignal }): Promise<RuntimeToolResult>;
  prepareBrowser(input: Parameters<ToolServices['invoke']>[0]): Promise<RuntimeBrowserApprovalCard>;
  question(id: string, api: ToolExecutionApi, context: Context): Promise<JsonValue>;
  instructions(conversationId: string, context: Context): Promise<string>;
  authorizeCronTool(input: { tool: string; args: JsonValue; readScopes: readonly string[]; writeScopes: readonly string[] }): Promise<void>;
};
export function createRuntimeTools(services: ToolServices, operations: JobServices): ToolRegistration[] {
  const jobs = createJobTool(operations);
  const routed = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find', 'codemode', 'agents', 'jobs', 'proc', 'machines', 'environment', 'space_goal', 'space_phase', 'space_workspace', 'space_artifacts', 'space_workflow', 'space_rubric', 'space_journal', 'space_guide', 'space_review', 'web_search', 'generate_image', 'ast_grep', 'ast_edit', 'ast_resolve', 'history_search', 'history_read', 'report_issue', 'checkpoint', 'rewind', 'delegate_export', 'mcp_discover', 'mcp_invoke'];
  routed.push('browser');
  const safe: Record<string, true | undefined> = { read: true, grep: true, find: true, machines: true, web_search: true, history_search: true, history_read: true, ast_grep: true };
  const tools: ToolRegistration[] = routed.map(name => defineTool({ name, description: name === 'browser' ? 'Browser defaults to headless with a persistent workspace-isolated profile and no approval prompts in any mode. Use source:"relay" explicitly only when the task needs the user’s logged-in Chrome; relay is main-agent-only. One named workspace Chrome group limits visible and controllable tabs. open {url?,targetId?,source?}; tabs {source?}; other actions require targetId and the same source: navigate {url}, observe {screenshot?,offset?,limit?}, act {ref,operation:click|fill|press,value?}, screenshot, evaluate {expression}, close. Re-observe stale refs. Relay group creation asks once outside yolo; approved environment browser.origins govern all relay navigation and actions. Missing access requires proposing .gitspace/bundle.json browser.origins changes for human environment approval, even in yolo. JavaScript and screenshots need no extra grant. Tabs dragged out of the group become inaccessible. Human group revocation is not a model tool.' : `GitSpace ${name}; executes through authorized workspace services and the conversation's fixed placement.`, parameters: Type.Object({ args: Type.Unknown() }), replay: safe[name] || name === 'jobs' ? 'safe' : 'unsafe', async execute(input, api, context) {
    const phase = await api.snapshot(WorkspaceDoc, context);
    if (phase?.phase === 'plan' && !safe[name]) return { isError: true, content: [{ type: 'text', text: 'Plan mode is read-only. Propose a plan and wait for human approval before effects.' }] };
    const args = name === 'browser' ? RuntimeBrowserArgumentsSchema.parse(input.args) : RuntimeJsonSchema.parse(input.args);
    const scope = await api.snapshot(CronScopeDoc, api.conversationId, context);
    if (scope?.constrained) await services.authorizeCronTool({ tool: name, args, readScopes: scope.readScopes, writeScopes: scope.writeScopes });
    const attemptId = await api.memo('gitspace.attempt', `tool:${api.taskId}`, context);
    const invocation = { tool: name, args, conversationId: String(api.conversationId), taskId: String(api.taskId), requestId: api.callId, attemptId, replay: safe[name] ? 'safe' as const : 'unsafe' as const, signal: context.abortSignal };
    const browser = name === 'browser' ? await services.prepareBrowser(invocation) : undefined;
    if (!await enforceSessionApproval(api, context, name, args, browser)) return { isError: true, content: [{ type: 'text', text: 'The requested operation was not approved.' }] };
    if (name === 'jobs') {
      const value = await jobs(args, api, context);
      const result = RuntimeToolResultSchema.safeParse(value);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], ...(result.success ? { details: { executorResultReference: { attemptId: result.data.attemptId, sha256: await receiptDigest(result.data) } } } : {}) };
    }
    const result = await services.invoke(invocation);
    return { content: result.content, isError: result.status !== 'completed', details: { executorResultReference: { attemptId: result.attemptId, sha256: await receiptDigest(result) } } };
  } }));
  tools.push(defineTool({ name: 'todo', description: 'Replace the durable work checklist.', parameters: Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), status: Type.Union([Type.Literal('pending'), Type.Literal('active'), Type.Literal('completed')]) })) }), replay: 'safe', async execute(input, api, context) { await api.commit(async tx => { const doc = await tx.doc(TodosDoc, api.conversationId); doc.items = input.items; }, context); return { content: [{ type: 'text', text: 'Checklist updated.' }] }; } }));
  for (const kind of ['ask', 'approval'] as const) tools.push(defineTool({ name: kind === 'ask' ? 'ask' : 'propose_plan', description: kind === 'ask' ? 'Ask the user and durably wait for their answer.' : 'Propose an implementation plan; wait for explicit human approval. Never required for conversational replies.', parameters: Type.Object({ prompt: Type.String(), choices: Type.Array(Type.String()) }), replay: 'safe', async execute(input, api, context) {
    const id = await api.memo('gitspace.question', `question:${api.taskId}`, context);
    await api.commit(async tx => {
      const doc = await tx.doc(QuestionsDoc);
      if (!doc.items.some(item => item.id === id)) doc.items.push({ id, conversationId: String(api.conversationId), kind, prompt: input.prompt, choices: input.choices, answer: null });
      if (kind === 'approval') { const plan = await tx.doc(PlanDoc, api.conversationId); plan.text = input.prompt; plan.status = 'proposed'; plan.questionId = id; }
    }, context);
    const answer = await services.question(id, api, context);
    return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
  } }));
  return tools;
}
