import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('persists direct completion usage and loaded child definitions across native session reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-inspector-usage-'));
  const program = join(root, 'usage.mjs');
  await writeFile(program, `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, SessionManager } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-coding-agent', import.meta.dir))};
import { parseAgent } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-coding-agent/task/agents', import.meta.dir))};
import { runSubprocess } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-coding-agent/task/executor', import.meta.dir))};
import { AuthStorage } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-ai', import.meta.dir))};
import { postmortem } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-utils', import.meta.dir))};
const root = process.env.HOME;
const agentDir = join(root, 'agent');
const workspace = join(root, 'workspace');
const artifactsDir = join(root, 'artifacts');
await Promise.all([mkdir(agentDir), mkdir(workspace), mkdir(artifactsDir)]);
let childRequests = 0;
let oldDefinitionReachedProvider = false;
const served = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.method === 'GET' && new URL(request.url).pathname === '/v1/models') return Response.json({ data: ['a', 'b'].map(id => ({ id, object: 'model', owned_by: 'openai' })) });
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
  const body = await request.json();
  served.push(body.model);
  const child = body.tools?.some(tool => tool.function?.name === 'yield');
  let delta = { role: 'assistant', content: body.tools?.some(tool => tool.function?.name === 'respond') ? 'not valid JSON' : 'Fixture response.' };
  let finish = 'stop';
  if (child) {
    childRequests++;
    oldDefinitionReachedProvider ||= JSON.stringify(body).includes('LOADED_DEFINITION_MARKER') && !JSON.stringify(body).includes('MUTATED_DEFINITION_MARKER');
    const name = childRequests === 1 ? 'eval' : 'yield';
    const args = name === 'eval' ? { language: 'js', code: 'await (await completion("child direct", {model: "smol"})).wait()', timeout: 10 } : { data: { done: true } };
    delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'child-call-' + childRequests, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    finish = 'tool_calls';
  }
  const chunk = (choices, extra = {}) => 'data: ' + JSON.stringify({ id: 'fixture-' + served.length, object: 'chat.completion.chunk', created: 1, model: body.model, choices, ...extra }) + '\\n\\n';
  return new Response(chunk([{ index: 0, delta, finish_reason: null }]) + chunk([{ index: 0, delta: {}, finish_reason: finish }]) + chunk([], { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }) + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
} });
await writeFile(join(agentDir, 'models.yml'), JSON.stringify({ providers: { openai: {
  baseUrl: 'http://127.0.0.1:' + server.port + '/v1', api: 'openai-completions', apiKey: 'local-fixture',
  models: ['a', 'b'].map(id => ({ id, name: id, reasoning: false, contextWindow: 131072, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })),
} } }));
await writeFile(join(agentDir, 'config.yml'), JSON.stringify({
  modelRoles: { default: 'openai/a', smol: 'openai/a', plan: 'openai/b' }, enabledModels: ['openai/a', 'openai/b'], enabledProviders: ['openai'],
  tools: { format: 'native', xdev: false }, eval: { js: true, py: false, autoBackground: { enabled: false } },
  git: { enabled: false }, lsp: { enabled: false }, retry: { maxRetries: 0 }, prewalk: { enabled: false }, task: { prewalk: false, agentIdleTtlMs: 0 },
}));
const auth = await AuthStorage.create(join(root, 'auth.sqlite'));
const manager = SessionManager.create(workspace, join(root, 'sessions'));
let session;
try {
  ({ session } = await createAgentSession({ agentDir, cwd: workspace, authStorage: auth, sessionManager: manager, toolNames: ['eval'], enableLsp: false, enableMCP: false, enableIrc: false, skipPythonPreflight: true, thinkingLevel: 'off', systemPrompt: 'Local usage fixture.' }));
  await session.prompt('One ordinary assistant response.');
  const evaluator = session.getToolByName('eval');
  assert(evaluator);
  const evaluate = code => evaluator.execute('fixture-' + Math.random(), { language: 'js', code, timeout: 15 });
  await evaluate('await (await completion("role alias", {model: "smol"})).wait()');
  const b = session.modelRegistry.getAvailable().find(model => model.provider === 'openai' && model.id === 'b');
  const a = session.modelRegistry.getAvailable().find(model => model.provider === 'openai' && model.id === 'a');
  assert(a && b);
  await session.setModel(b, 'plan');
  await evaluate('await (await completion("inherit active plan")).wait()');
  // Exercise the native ephemeral transition used by retry recovery: serving
  // another model must not reverse-match that model to the configured default.
  session.agent.setModel(a);
  manager.appendModelChange('openai/a', 'fallback', true);
  await evaluate('await (await completion("inherit fallback serving model")).wait()');
  await session.setModelTemporary(a);
  await evaluate('await (await completion("inherit pinned model")).wait()');
  const invalid = await evaluate('try { await (await completion("invalid schema response", {schema: {type: "object", properties: {answer: {type: "string"}}, required: ["answer"]}})).wait(); throw new Error("Unexpected success"); } catch (error) { if (String(error).includes("Unexpected success")) throw error; display("CAPTURED_ERROR_USAGE: " + String(error)); }');
  assert(JSON.stringify(invalid).includes('CAPTURED_ERROR_USAGE'));
  const direct = manager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'gitspace-model-usage').map(entry => entry.data);
  assert.equal(direct.length, 5, JSON.stringify({ invalid, served }));
  assert.deepEqual(direct.map(entry => [entry.role, entry.selection, entry.provider, entry.model, entry.usage.totalTokens]), [
    ['smol', 'role', 'openai', 'a', 10], ['plan', 'role', 'openai', 'b', 10], ['plan', 'role', 'openai', 'a', 10], [null, 'pinned', 'openai', 'a', 10], [null, 'pinned', 'openai', 'a', 10],
  ]);
  assert.equal(new Set(direct.map(entry => entry.id)).size, 5);
  assert.equal(manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'assistant').length, 1);
  const agentPath = join(workspace, 'fixture-agent.md');
  const content = '---\\nname: fixture-agent\\ndescription: Local snapshot fixture\\nmodel: smol\\ntools: [eval, yield]\\nspawns: []\\n---\\nLOADED_DEFINITION_MARKER\\n';
  await writeFile(agentPath, content);
  const agent = parseAgent(agentPath, content, 'project');
  await writeFile(agentPath, content.replace('LOADED_DEFINITION_MARKER', 'MUTATED_DEFINITION_MARKER'));
  const child = await runSubprocess({ cwd: workspace, agent, task: 'Run one local completion then yield.', description: 'Fixture child', index: 0, id: 'FixtureChild', modelRole: 'smol', modelOverride: ['openai/a'], modelRegistry: session.modelRegistry, authStorage: auth, settings: session.settings, artifactsDir, enableLsp: false, enableMCP: false, enableIrc: false, restrictToolNames: true, keepAlive: false, maxRuntimeMs: 15000 });
  assert.equal(child.exitCode, 0, child.stderr);
  assert(oldDefinitionReachedProvider);
  const childFile = join(artifactsDir, 'FixtureChild.jsonl');
  const reopenedChild = await SessionManager.open(childFile);
  const definition = reopenedChild.getEntries().find(entry => entry.type === 'custom' && entry.customType === 'gitspace-agent-definition')?.data;
  assert.deepEqual({ name: definition?.name, path: definition?.path, revision: definition?.revision, content: definition?.content, role: definition?.role }, { name: 'fixture-agent', path: agentPath, revision: createHash('sha256').update(content).digest('hex'), content, role: 'smol' });
  const childDirect = reopenedChild.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'gitspace-model-usage');
  assert.equal(childDirect.length, 1);
  assert.equal(childDirect[0].data.usage.totalTokens, 10);
  assert.equal(childDirect[0].data.role, 'smol');
  await reopenedChild.close();
  await manager.flush();
  const file = manager.getSessionFile();
  await session.dispose();
  session = undefined;
  const reopened = await SessionManager.open(file);
  assert.deepEqual(reopened.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'gitspace-model-usage').map(entry => entry.data), direct);
  await reopened.close();
  assert(served.every(model => model === 'a' || model === 'b'));
  console.log('INSPECTOR_USAGE_OK');
} finally {
  await session?.dispose();
  await server.stop(true);
  auth.close();
  await postmortem.cleanup();
}
`);
  const child = Bun.spawn([process.execPath, program], { cwd: root, env: { ...process.env, HOME: root }, stdout: 'pipe', stderr: 'pipe', timeout: 65_000 });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Inspector usage fixture failed (${code}): ${stderr}\n${stdout}`);
    expect(stdout).toContain('INSPECTOR_USAGE_OK');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 70_000);
