import { test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Run only against an explicitly installed maintained recipe, never pristine repo SDK links.
const integrationTest = process.env.SDK_ROOT ? test : test.skip;

// GitSpace runs one primary SDK session per process; preserve that isolation per scenario.
integrationTest.each([
  'manual-success', 'manual-failure', 'manual-cancel', 'pre-prompt', 'post-turn',
  'speculative-success', 'speculative-failure', 'speculative-cancel', 'overlap',
])('projects real SDK %s compaction through its terminal outcome', async (scenario) => {
  const sdkRoot = process.env.SDK_ROOT;
  if (!sdkRoot) throw new Error('SDK_ROOT must name the installed @oh-my-pi directory');
  const root = await mkdtemp(join(tmpdir(), 'omp-compaction-'));
  const program = join(root, 'compaction.mjs');
  const sdkModules = dirname(sdkRoot);
  const sdk = Bun.resolveSync('@oh-my-pi/pi-coding-agent', sdkModules);
  await symlink(sdkModules, join(root, 'node_modules'), 'dir');
  // Match production's bundled adapter/external SDK boundary, including native require() calls.
  const adapterPath = join(root, 'omp-session.js');
  // Real SDK and HTTP transport, isolated from other tests' registries/settings.
  // Only the local provider is controlled; no fabricated lifecycle events.
  await writeFile(program, `
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
// Build outside bun:test's module-mock resolver, exactly as deployment does.
const build = await Bun.build({
  entrypoints: [${JSON.stringify(new URL('../src/session.ts', import.meta.url).pathname)}],
  target: 'bun', outdir: ${JSON.stringify(root)}, naming: 'omp-session.js', external: ['@oh-my-pi/*'],
});
if (!build.success) throw new AggregateError(build.logs, 'Compaction adapter fixture build failed');
const { EmbeddedOmpRuntime } = await import(${JSON.stringify(adapterPath)});
const { AgentRegistry, SessionManager } = await import(${JSON.stringify(sdk)});
const { computeNonMessageTokens } = await import(${JSON.stringify(join(dirname(sdk), 'modes/utils/context-usage.ts'))});
const { AuthStorage } = await import(${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-ai', sdkModules))});
const { postmortem } = await import(${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-utils', sdkModules))});
const root = process.env.HOME;
const scenario = process.env.GITSPACE_COMPACTION_SCENARIO;
const agentDir = join(root, 'agent');
const workspace = join(root, 'workspace');
await Promise.all([mkdir(agentDir), mkdir(workspace)]);
let summaryPlan;
let foregroundTokens = 100;
const response = (model, finishReason = 'stop') => {
  const base = { id: 'local-response', object: 'chat.completion.chunk', created: 1, model };
  return new Response([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: model === 'summary' ? 'Recovered context summary.' : 'Finished.' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: model === 'summary' ? 100 : foregroundTokens, completion_tokens: 5, total_tokens: (model === 'summary' ? 100 : foregroundTokens) + 5 } },
  ].map(chunk => 'data: ' + JSON.stringify(chunk) + '\\n\\n').join('') + 'data: [DONE]\\n\\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
  if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/models')) {
    return Response.json({ object: 'list', data: ['test', 'summary'].map(id => ({ id, object: 'model', owned_by: 'local' })) });
  }
  const body = await request.json();
  if (body.model === 'summary') {
    const plan = summaryPlan;
    if (!plan) throw new Error('Unexpected summarization request');
    if (plan.failures > 0) {
      plan.failures--;
      return response(body.model, 'error');
    }
    plan.started.resolve();
    await plan.release.promise;
    if (plan.status !== 200) return Response.json({ error: { message: 'Invalid summarization request' } }, { status: plan.status });
  }
  return response(body.model);
} });
await writeFile(join(agentDir, 'models.yml'), JSON.stringify({ providers: { openai: {
  baseUrl: server.url.href + 'v1', api: 'openai-completions', apiKey: 'local-test-key',
  models: [
    { id: 'test', name: 'Test', reasoning: false, contextWindow: 200000, maxTokens: 4096, compactionModel: 'openai/summary' },
    { id: 'summary', name: 'Summary', reasoning: false, contextWindow: 200000, maxTokens: 4096 },
  ],
} } }));
await writeFile(join(agentDir, 'config.yml'), JSON.stringify({
  modelRoles: { default: 'openai/test' }, enabledModels: ['openai/test', 'openai/summary'], enabledProviders: ['openai'],
  git: { enabled: false }, lsp: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  compaction: { enabled: true, methodOrder: ['soft'], keepRecentTokens: 64, asyncEnabled: false, thresholdTokens: 180000, autoContinue: false },
  contextPromotion: { enabled: false },
}));
const auth = await AuthStorage.create(join(root, 'auth.sqlite'));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let active;
function planSummary(status = 200, failures = 0) {
  summaryPlan = { status, failures, started: Promise.withResolvers(), release: Promise.withResolvers() };
  return summaryPlan;
}
async function openSession() {
  const sessionRoot = join(root, 'sessions');
  const manager = SessionManager.create(workspace, sessionRoot);
  for (let index = 0; index < 16; index++) {
    manager.appendMessage({ role: 'user', content: 'Historical request '.repeat(1000), timestamp: index * 2 + 1 });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Historical response '.repeat(1000) }], api: 'openai-completions', provider: 'openai', model: 'test', usage, stopReason: 'stop', timestamp: index * 2 + 2 });
  }
  manager.appendMessage({ role: 'user', content: 'Retain this request '.repeat(1000), timestamp: 40 });
  await manager.flush();
  const sessionFile = manager.getSessionFile();
  await manager.close();
  const runtime = new EmbeddedOmpRuntime({ agentDir, sessionRoot, authStorage: async () => auth });
  const adapter = await runtime.open({ projectId: 'project', workspaceId: 'workspace', workingDirectory: workspace, sessionKey: 'space', artifactsDir: join(root, 'artifacts'), sessionFile });
  const session = AgentRegistry.global().list().find(ref => ref.kind === 'main')?.session;
  assert.ok(session, 'SDK session must be registered');
  await session.setActiveToolsByName([]);
  const baseline = Math.max(session.getContextBreakdown()?.usedTokens ?? 0,
    computeNonMessageTokens(session, session.agent.tokenizer) + session.agent.tokenizer.countMessages(session.messages, { excludeEncryptedReasoning: true }));
  const snapshots = [];
  const events = [];
  adapter.subscribeActivity(activity => snapshots.push(activity));
  adapter.subscribe(event => events.push(event));
  foregroundTokens = 100;
  active = adapter;
  return { adapter, session, baseline, snapshots, events };
}
function compacting(adapter) {
  return adapter.activity().activity.reasons.find(reason => reason.kind === 'compacting');
}
function waitForCompactionEnd(adapter) {
  const gate = Promise.withResolvers();
  const unsubscribe = adapter.subscribeActivity(activity => {
    if (!activity.reasons.some(reason => reason.kind === 'compacting')) gate.resolve();
  });
  return gate.promise.finally(unsubscribe);
}
async function closeSession() {
  await active.dispose();
  active = undefined;
}
try {
  // A failed manual summary previously started an extension-only indicator that never ended.
  for (const terminal of ['success', 'failure', 'cancel']) {
    if (scenario !== 'manual-' + terminal) continue;
    const { adapter, session } = await openSession();
    const plan = planSummary(terminal === 'failure' ? 400 : 200);
    const outcome = adapter.compact().then(() => null, error => error);
    await plan.started.promise;
    assert.ok(compacting(adapter), 'manual request must be visible while the provider is blocked');
    const ended = waitForCompactionEnd(adapter);
    if (terminal === 'cancel') await adapter.stop();
    plan.release.resolve();
    const error = await outcome;
    await ended;
    assert.equal(compacting(adapter), undefined);
    assert.equal(adapter.activity().activity.active, false);
    if (terminal === 'success') {
      assert.equal(error, null);
      assert.ok(session.sessionManager.getBranch().some(entry => entry.type === 'compaction'));
    } else assert.ok(error instanceof Error, terminal + ' must reject manual compaction');
    await closeSession();
  }

  // A pre-prompt pass must be visible before agent_start, including its same-model retry.
  if (scenario === 'pre-prompt') {
    const { adapter, session, baseline, snapshots, events } = await openSession();
    session.settings.override('compaction.thresholdTokens', baseline - 8000);
    const plan = planSummary(200, Infinity);
    // Keep failing through transport-level retries; recover only at the visible SDK retry.
    const stopObservingRetry = adapter.subscribeActivity(activity => {
      if (activity.reasons.some(reason => reason.kind === 'compacting' && reason.detail?.includes('attempt 2'))) plan.failures = 0;
    });
    const prompt = adapter.prompt('Continue');
    await plan.started.promise;
    stopObservingRetry();
    assert.ok(compacting(adapter));
    assert.match(compacting(adapter).detail, /attempt 2/);
    assert.equal(events.some(event => event.type === 'agent_start'), false);
    const running = snapshots.findIndex(activity => activity.reasons.some(reason => reason.kind === 'compacting'));
    assert.ok(running >= 0);
    assert.ok(snapshots.slice(running).every(activity => activity.reasons.some(reason => reason.kind === 'compacting')), 'retry backoff must not publish idle');
    plan.release.resolve();
    await prompt;
    assert.equal(compacting(adapter), undefined);
    assert.equal(adapter.activity().activity.active, false);
    await closeSession();
  }

  // Provider usage crosses the threshold only after the foreground answer.
  if (scenario === 'post-turn') {
    const { adapter, session, baseline, events } = await openSession();
    session.settings.override('compaction.thresholdTokens', baseline + 8000);
    foregroundTokens = baseline + 9000;
    const plan = planSummary();
    const prompt = adapter.prompt('Continue');
    await plan.started.promise;
    assert.ok(events.some(event => event.type === 'agent_start'));
    assert.ok(events.some(event => event.type === 'message_end' && event.message?.role === 'assistant'));
    assert.ok(compacting(adapter), 'post-turn summarization must remain visible');
    plan.release.resolve();
    await prompt;
    assert.equal(compacting(adapter), undefined);
    assert.equal(adapter.activity().activity.active, false);
    await closeSession();
  }

  // A speculative summary outlives agent_end but its completed, armed result is not running.
  for (const terminal of ['success', 'failure', 'cancel']) {
    if (scenario !== 'speculative-' + terminal) continue;
    const { adapter, session, baseline } = await openSession();
    session.settings.override('compaction.asyncEnabled', true);
    session.settings.override('compaction.thresholdTokens', baseline + 1024);
    const plan = planSummary(terminal === 'failure' ? 400 : 200);
    const prompt = adapter.prompt('Continue');
    await plan.started.promise;
    await prompt;
    assert.equal(session.compactionSpeculation, 'running');
    assert.ok(compacting(adapter), 'agent_end must not clear an in-flight background summary');
    const ended = waitForCompactionEnd(adapter);
    if (terminal === 'cancel') await adapter.stop();
    plan.release.resolve();
    await ended;
    assert.equal(session.compactionSpeculation, terminal === 'success' ? 'armed' : 'idle');
    assert.equal(adapter.activity().activity.active, false, 'armed results must not pin the session as running');
    await closeSession();
  }

  // Manual compaction supersedes a running speculation. Its late cancellation must not end the manual pass.
  if (scenario === 'overlap') {
    const { adapter, session, baseline, snapshots } = await openSession();
    session.settings.override('compaction.asyncEnabled', true);
    session.settings.override('compaction.thresholdTokens', baseline + 1024);
    const background = planSummary();
    const prompt = adapter.prompt('Continue');
    await background.started.promise;
    await prompt;
    const firstActive = snapshots.findIndex(activity => activity.reasons.some(reason => reason.kind === 'compacting'));
    assert.ok(firstActive >= 0);
    const manual = planSummary();
    const outcome = adapter.compact();
    await manual.started.promise;
    background.release.resolve();
    assert.ok(compacting(adapter));
    const ended = waitForCompactionEnd(adapter);
    manual.release.resolve();
    await outcome;
    await ended;
    const lastActive = snapshots.findLastIndex(activity => activity.reasons.some(reason => reason.kind === 'compacting'));
    assert.ok(snapshots.slice(firstActive, lastActive + 1).every(activity => activity.reasons.some(reason => reason.kind === 'compacting')), 'one operation ending cannot publish idle while another is active');
    assert.equal(adapter.activity().activity.active, false);
    await closeSession();
  }
} finally {
  summaryPlan?.release.resolve();
  await active?.dispose();
  server.stop(true);
  auth.close();
  await postmortem.cleanup();
}
`);
  const child = Bun.spawn([process.execPath, program], { cwd: root, env: { ...process.env, HOME: root, GITSPACE_COMPACTION_SCENARIO: scenario }, stdout: 'pipe', stderr: 'pipe', timeout: 90_000 });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`OMP compaction lifecycle failed (${code}): ${stderr}\n${stdout}`);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 95_000);
