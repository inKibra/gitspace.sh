import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Exercise the SDK in its own process: registries and model configuration are process-global.
test('keeps mounted plan references through new sessions and approved child handoffs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-plan-reference-'));
  const program = join(root, 'plans.mjs');
  const sdkRoot = dirname(Bun.resolveSync('@oh-my-pi/pi-coding-agent', import.meta.dir));
  await writeFile(program, `
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession } from ${JSON.stringify(join(sdkRoot, 'sdk.ts'))};
import { ModelRegistry } from ${JSON.stringify(join(sdkRoot, 'config/model-registry.ts'))};
import { runStructuredSubagent } from ${JSON.stringify(join(sdkRoot, 'task/structured-subagent.ts'))};
import { resolveLocalUrlToPath } from ${JSON.stringify(join(sdkRoot, 'internal-urls/local-protocol.ts'))};
import { AuthStorage } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-ai', import.meta.dir))};
import { postmortem } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-utils', import.meta.dir))};
const root = process.env.HOME;
const agentDir = join(root, 'agent');
const workspace = join(root, 'checkout');
const artifacts = join(root, 'artifacts');
await Promise.all([mkdir(agentDir), mkdir(workspace), mkdir(join(artifacts, 'workspace'), { recursive: true }), mkdir(join(artifacts, 'base'), { recursive: true })]);
const payloads = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [] });
  if (request.method !== 'POST') return new Response('Not found', { status: 404 });
  payloads.push(await request.json());
  const delta = { id: 'plan-proof', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'PLAN_PROBE_OK' }, finish_reason: 'stop' }] };
  return new Response('data: ' + JSON.stringify(delta) + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
} });
await writeFile(join(agentDir, 'models.yml'), JSON.stringify({ providers: { openai: {
  baseUrl: server.url.origin + '/v1', api: 'openai-completions', apiKey: 'local-test-key',
  models: [{ id: 'test', name: 'Test', reasoning: false, contextWindow: 131072, maxTokens: 4096 }],
} } }));
await writeFile(join(agentDir, 'config.yml'), JSON.stringify({
  modelRoles: { default: 'openai/test', smol: 'openai/test' }, enabledModels: ['openai/test'], enabledProviders: ['openai'],
  git: { enabled: false }, lsp: { enabled: false }, retry: { maxRetries: 0 }, tools: { approvalMode: 'yolo' },
  task: { requireYieldTool: false },
}));
const auth = await AuthStorage.create(join(root, 'auth.sqlite'));
const modelRegistry = new ModelRegistry(auth, join(agentDir, 'models.yml'));
const localProtocolOptions = {
  getArtifactsDir: () => artifacts,
  getSessionId: () => 'plan-reference-proof',
  getLocalMounts: () => ({ base: 'read', workspace: 'write' }),
  getDefaultPlanReferencePath: () => 'local://workspace/PLAN.md',
};
let session;
try {
  ({ session } = await createAgentSession({ cwd: workspace, agentDir, authStorage: auth, modelRegistry,
    localProtocolOptions, toolNames: [], enableMCP: false, enableLsp: false, skipPythonPreflight: true }));
  await session.prompt('MAIN_WITHOUT_PLAN');
  assert(JSON.stringify(payloads.at(-1)).includes('MAIN_WITHOUT_PLAN'));
  await writeFile(join(artifacts, 'workspace', 'PLAN.md'), 'WORKSPACE_APPROVED_PLAN_MARKER');
  assert.equal(await session.newSession(), true);
  await session.prompt('MAIN_AFTER_RESET');
  assert(JSON.stringify(payloads.at(-1)).includes('WORKSPACE_APPROVED_PLAN_MARKER'));
  const toolSession = {
    cwd: workspace, hasUI: false, settings: session.settings, authStorage: auth, modelRegistry,
    getSessionFile: () => session.sessionFile, getSessionId: () => session.sessionId,
    getSessionSpawns: () => '*', getArtifactsDir: () => artifacts,
    getActiveModelString: () => 'openai/test', getModelString: () => 'openai/test',
    getPlanReferencePath: () => session.getPlanReferencePath(), getPlanModeState: () => session.getPlanModeState(),
    localProtocolOptions, enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
  };
  async function child(assignment) {
    const from = payloads.length;
    const result = await runStructuredSubagent({ session: toolSession, invocationKind: 'eval', assignment,
      model: 'openai/test', enableIrc: false, enableLsp: false, shareEvalSession: false, maxRuntimeMs: 15000 });
    assert.equal(result.result.exitCode, 0, JSON.stringify(result.result));
    assert(JSON.stringify(payloads.slice(from)).includes(assignment), 'The child assignment must reach the model');
    return JSON.stringify(payloads.slice(from));
  }
  await writeFile(join(artifacts, 'workspace', 'chosen.md'), 'SELECTED_APPROVED_PLAN_MARKER');
  session.setPlanReferencePath('local://workspace/chosen.md');
  const approved = await child('CHILD_WITH_APPROVED_PLAN');
  assert(approved.includes('SELECTED_APPROVED_PLAN_MARKER'));
  assert(!approved.includes('WORKSPACE_APPROVED_PLAN_MARKER'));
  session.setPlanReferencePath('local://workspace/missing.md');
  const absent = await child('CHILD_WITHOUT_PLAN');
  assert(!absent.includes('WORKSPACE_APPROVED_PLAN_MARKER'));
  assert(!absent.includes('SELECTED_APPROVED_PLAN_MARKER'));
  session.setPlanModeState({ enabled: true, planFilePath: 'local://workspace/chosen.md', workflow: 'parallel', reentry: false });
  const draft = await child('CHILD_DURING_PLAN_MODE');
  assert(!draft.includes('SELECTED_APPROVED_PLAN_MARKER'));
  assert(!draft.includes('WORKSPACE_APPROVED_PLAN_MARKER'));
  session.setPlanModeState(undefined);
  assert.throws(() => resolveLocalUrlToPath('local://PLAN.md', localProtocolOptions), /outside the authorized artifact mounts/);
  assert.throws(() => resolveLocalUrlToPath('local://base/PLAN.md', localProtocolOptions, process.platform, 'write'), /read-only/);
  session.setPlanReferencePath('local://forbidden/PLAN.md');
  await assert.rejects(session.prompt('UNAUTHORIZED_PLAN'), /outside the authorized artifact mounts/);
  await session.dispose();
  session = undefined;
  ({ session } = await createAgentSession({ cwd: workspace, agentDir, authStorage: auth, modelRegistry,
    localProtocolOptions: { ...localProtocolOptions, getLocalMounts: () => ({ base: 'write' }), getDefaultPlanReferencePath: () => 'local://base/PLAN.md' },
    toolNames: [], enableMCP: false, enableLsp: false, skipPythonPreflight: true }));
  await writeFile(join(artifacts, 'base', 'PLAN.md'), 'PROJECT_APPROVED_PLAN_MARKER');
  await session.prompt('PROJECT_PLAN');
  assert(JSON.stringify(payloads.at(-1)).includes('PROJECT_APPROVED_PLAN_MARKER'));
  console.log('PLAN_REFERENCE_PROOF_OK');
} finally {
  await session?.dispose();
  auth.close();
  await server.stop(true);
  await postmortem.cleanup();
}
`);
  const child = Bun.spawn([process.execPath, program], { cwd: root, env: { ...process.env, HOME: root }, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Plan reference scenario failed (${code}): ${stderr}\n${stdout}`);
    expect(stdout).toContain('PLAN_REFERENCE_PROOF_OK');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 65_000);
