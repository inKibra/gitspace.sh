import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SnapshotResponse } from '@oh-my-pi/pi-ai/auth-broker';
import { OmpRpcPeer, type OmpChildApi, type OmpChildInit } from '../src/ipc.js';

test('resuming under a profile without the saved model switches to the profile default and says so', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-profile-fallback-'));
  const agentDir = join(root, 'agent');
  const workspace = join(root, 'workspace');
  const models: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/broker/v1/snapshot') {
      if (new URL(request.url).searchParams.has('since')) {
        if (!request.signal.aborted) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        return new Response(null, { status: 304 });
      }
      const now = Date.now();
      const snapshot: SnapshotResponse = { generation: 1, generatedAt: now, serverNowMs: now,
        refresher: { enabled: false, intervalMs: 60_000, skewMs: 60_000, nextSweepInMs: 60_000 },
        credentials: [{ id: 1, provider: 'local-llm', identityKey: null, rotatesInMs: null, credential: { type: 'api_key', key: 'profile-key' } }],
      };
      return Response.json(snapshot);
    }
    if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
    const payload = await request.json() as { model?: string };
    models.push(payload.model ?? '');
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    return new Response(chunk({ role: 'assistant', content: 'Done.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const advancedContent = JSON.stringify({ git: { enabled: false }, lsp: { enabled: false }, retry: { maxRetries: 0 } });
  const profile = (id: string, name: string, modelId: string): OmpChildInit['inference'] => ({
    version: 1, projectId: 'project', assignmentRevision: 1,
    profile: { version: 1, id, name, revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', settings: {
      modelRoles: { default: `local-llm/${modelId}` },
      'providers.models': { 'local-llm': {
        baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions',
        models: [{ id: modelId, name: modelId, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
      } },
    } },
    advanced: { generation: 1, content: advancedContent, checksum: `sha256:${createHash('sha256').update(advancedContent).digest('hex')}`, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'test' },
    broker: { url: `http://127.0.0.1:${server.port}/broker`, token: 'broker-token' },
  });
  const run = async (inference: OmpChildInit['inference'], sessionFile?: string): Promise<string> => {
    const input: OmpChildInit = {
      agentDir, sessionRoot: join(root, 'sessions'), skills: [],
      input: { projectId: 'project', workspaceId: 'workspace', workingDirectory: workspace, sessionKey: 'space', artifactsDir: join(root, 'artifacts'), ...(sessionFile ? { sessionFile } : {}) },
      inference, tools: [], mcpCatalog: { servers: [], instructions: [], prompts: {}, resources: {} }, namespaces: {},
    };
    let child: Bun.Subprocess;
    const rpc = new OmpRpcPeer<OmpChildApi, {}>((message) => child.send(message), {});
    child = Bun.spawn([process.execPath, new URL('../src/runtime.ts', import.meta.url).pathname], {
      cwd: root, env: { ...process.env, HOME: root }, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', serialization: 'advanced',
      ipc: (message) => rpc.receive(message), onDisconnect: () => rpc.close(),
    });
    void child.exited.then((code) => rpc.close(new Error(`OMP child exited (${code})`)));
    try {
      const opened = await rpc.call('initialize', [input], AbortSignal.timeout(30_000));
      await rpc.call('prompt', ['Continue.'], AbortSignal.timeout(15_000));
      return opened.sessionFile;
    } finally {
      try { await rpc.call('dispose', [], AbortSignal.timeout(5_000)); }
      finally { rpc.close(); child.disconnect(); child.kill(); await child.exited; }
    }
  };
  try {
    await Promise.all([mkdir(agentDir), mkdir(workspace)]);
    await writeFile(join(agentDir, 'config.yml'), advancedContent);
    const sessionFile = await run(profile('first', 'First', 'old-model'));
    // The project moves to a profile that lacks old-model; resuming the same session must not fail.
    expect(await run(profile('second', 'Second', 'new-model'), sessionFile)).toBe(sessionFile);
    expect(models).toEqual(['old-model', 'new-model']);
    const transcript = await readFile(sessionFile, 'utf8');
    expect(transcript).toContain("Saved model local-llm/old-model isn't available in inference profile Second; switched to local-llm/new-model.");
    expect(transcript).toContain('"model":"local-llm/new-model","role":"default"');
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
