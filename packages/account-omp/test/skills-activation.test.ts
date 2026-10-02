import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillView } from '@gitspace/protocol';
import type { SnapshotResponse } from '@oh-my-pi/pi-ai/auth-broker';
import { OmpRpcPeer, type OmpChildApi, type OmpChildInit } from '../src/ipc.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omp-skills-'));
  const agentDir = join(root, 'agent');
  const workspace = join(root, 'workspace');
  const requests: Array<{ first: boolean; second: boolean }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/broker/v1/snapshot') {
      if (request.headers.get('authorization') !== 'Bearer broker-token') return new Response('denied', { status: 403 });
      // The unchanged long poll parks until client shutdown.
      if (new URL(request.url).searchParams.has('since')) {
        if (!request.signal.aborted) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        return new Response(null, { status: 304 });
      }
      const now = Date.now();
      const snapshot: SnapshotResponse = { generation: 1, generatedAt: now, serverNowMs: now,
        refresher: { enabled: false, intervalMs: 60_000, skewMs: 60_000, nextSweepInMs: 60_000 },
        credentials: [{ id: 1, provider: 'openai', identityKey: null, rotatesInMs: null, credential: { type: 'api_key', key: 'local-test-key' } }],
      };
      return Response.json(snapshot);
    }
    if (request.method === 'GET' && path === '/v1/models') return Response.json({ data: [{ id: 'test', object: 'model', owned_by: 'openai' }] });
    if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
    const payload = await request.json() as { messages: Array<{ role: string; content: unknown }> };
    const system = JSON.stringify(payload.messages.filter((message) => message.role === 'system' || message.role === 'developer'));
    requests.push({ first: system.includes('first-skill-activation-marker'), second: system.includes('second-skill-activation-marker') });
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
      id: `chatcmpl-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'test',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: 'Done.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  } });
  await Promise.all([mkdir(agentDir), mkdir(workspace)]);
  const advancedContent = JSON.stringify({ skillful: true, git: { enabled: false }, lsp: { enabled: false }, retry: { maxRetries: 0 } });
  await writeFile(join(agentDir, 'config.yml'), advancedContent);
  const skills: SkillView[] = [
    { id: 'first-skill', name: 'first-skill', description: 'first-skill-activation-marker', source: 'user', scope: 'all', enabled: true, exceptions: [], assignments: [], revision: 1 },
    { id: 'second-skill', name: 'second-skill', description: 'second-skill-activation-marker', source: 'user', scope: 'project', enabled: true, exceptions: [], assignments: [{ projectId: 'project', projectSpaceEnabled: true, workspacesEnabled: false }], revision: 1 },
  ];
  for (const skill of skills) {
    const directory = join(agentDir, 'skills', skill.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${skill.id}\ndescription: ${skill.description}\n---\n\nUse this skill when asked.\n`);
  }
  const input: OmpChildInit = {
    agentDir, sessionRoot: join(root, 'sessions'), skills,
    input: { projectId: 'project', workspaceId: 'workspace', workingDirectory: workspace, sessionKey: 'space', artifactsDir: join(root, 'artifacts') },
    inference: {
      version: 1, projectId: 'project', assignmentRevision: 1,
      profile: { version: 1, id: 'default', name: 'Default', revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', settings: {
        modelRoles: { default: 'openai/test' }, enabledModels: ['openai/test'],
        'providers.models': { openai: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions',
          models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
        } },
      } },
      advanced: { generation: 1, content: advancedContent, checksum: `sha256:${createHash('sha256').update(advancedContent).digest('hex')}`, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'test' },
      broker: { url: `http://127.0.0.1:${server.port}/broker`, token: 'broker-token' },
    },
    tools: [], mcpCatalog: { servers: [], instructions: [], prompts: {}, resources: {} }, namespaces: {},
  };
  return { root, input, requests, async dispose() { await server.stop(true); await rm(root, { recursive: true, force: true }); } };
}

function startChild(root: string, listSkills?: () => readonly SkillView[]) {
  let child: Bun.Subprocess;
  // An empty callback table models a machine without live skill support.
  const rpc = new OmpRpcPeer<OmpChildApi, {}>((message) => child.send(message), listSkills ? {
    listSkills: async () => listSkills(),
  } : {});
  child = Bun.spawn([process.execPath, new URL('../src/runtime.ts', import.meta.url).pathname], {
    cwd: root, env: { ...process.env, HOME: root }, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', serialization: 'advanced',
    ipc: (message) => rpc.receive(message), onDisconnect: () => rpc.close(),
  });
  void child.exited.then((code) => rpc.close(new Error(`OMP child exited (${code})`)));
  return { rpc, async dispose() {
    try { await rpc.call('dispose', [], AbortSignal.timeout(5_000)); }
    finally { rpc.close(); child.disconnect(); child.kill(); await child.exited; }
  } };
}

test('new child preserves scoped startup skills with a machine lacking live callbacks', async () => {
  const context = await fixture();
  const child = startChild(context.root);
  try {
    await child.rpc.call('initialize', [context.input], AbortSignal.timeout(30_000));
    await child.rpc.call('prompt', ['Use the available instructions.'], AbortSignal.timeout(15_000));
    expect(context.requests).toEqual([{ first: true, second: false }]);
  } finally {
    try { await child.dispose(); } finally { await context.dispose(); }
  }
}, 50_000);

test('opted-in child refreshes authorization and never falls back to its startup snapshot after a cloud error', async () => {
  const context = await fixture();
  let latest = context.input.skills;
  let unavailable = false;
  const child = startChild(context.root, () => {
    if (unavailable) throw new Error('Cloud skill authority unavailable');
    return latest;
  });
  try {
    await child.rpc.call('initialize', [{ ...context.input, liveSkills: true }], AbortSignal.timeout(30_000));
    await child.rpc.call('prompt', ['First task.'], AbortSignal.timeout(15_000));
    latest = latest.map((skill) => ({ ...skill, revision: 2, enabled: skill.id !== 'first-skill', assignments: [{ projectId: 'project', projectSpaceEnabled: false, workspacesEnabled: true }] }));
    await child.rpc.call('prompt', ['Second task.'], AbortSignal.timeout(15_000));
    latest = latest.map((skill) => ({ ...skill, revision: 3, exceptions: ['project'] }));
    await child.rpc.call('prompt', ['Third task.'], AbortSignal.timeout(15_000));
    unavailable = true;
    await expect(child.rpc.call('prompt', ['Do not run using stale authorization.'], AbortSignal.timeout(15_000))).rejects.toThrow('Cloud skill authority unavailable');
    expect(context.requests).toEqual([
      { first: true, second: false },
      { first: false, second: true },
      { first: false, second: false },
    ]);
  } finally {
    try { await child.dispose(); } finally { await context.dispose(); }
  }
}, 75_000);
