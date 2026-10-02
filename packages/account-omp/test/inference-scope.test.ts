import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { InferenceExecutionContext } from '@gitspace/protocol/inference';
import type { SnapshotResponse } from '@oh-my-pi/pi-ai/auth-broker';
import { createManagedInference } from '../src/inference.js';

const directories: string[] = [];
const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(empty = false, rejectFirst = false) {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-inference-'));
  directories.push(directory);
  const requests: Array<{ path: string; authorization: string | null; body: string }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const profile = /^\/profiles\/(a|b)\/v1\/snapshot$/u.exec(path)?.[1];
    if (profile) {
      if (request.headers.get('authorization') !== `Bearer broker-${profile}`) return new Response('denied', { status: 403 });
      // A synthetic unchanged broker parks the real long poll until client shutdown.
      if (new URL(request.url).searchParams.has('since')) {
        if (!request.signal.aborted) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        return new Response(null, { status: 304 });
      }
      const now = Date.now();
      const snapshot: SnapshotResponse = { generation: 1, generatedAt: now, serverNowMs: now,
        refresher: { enabled: false, intervalMs: 60_000, skewMs: 60_000, nextSweepInMs: 60_000 },
        credentials: empty ? [] : [{ id: 1, provider: 'openai', identityKey: null, rotatesInMs: null, credential: { type: 'api_key', key: `profile-${profile}-key` } }],
      };
      return Response.json(snapshot);
    }
    if (path.startsWith('/profiles/')) return new Response('unsupported', { status: 404 });
    requests.push({ path, authorization: request.headers.get('authorization'), body: await request.text() });
    if (path === '/metadata') return Response.json({ AccessKeyId: 'ambient-aws', SecretAccessKey: 'ambient-secret', Token: 'ambient-token', Expiration: '2099-01-01T00:00:00Z' });
    if (path.endsWith('/responses')) return Response.json({ output: [{ type: 'image_generation_call', result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }] });
    if (rejectFirst && requests.length === 1) return Response.json({ error: { message: 'invalid credential', type: 'authentication_error' } }, { status: 401 });
    const chunk = { id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'profile-model', choices: [{ index: 0, delta: { role: 'assistant', content: '<title>Scoped inference</title>' }, finish_reason: null }] };
    const final = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  servers.push(server);
  const content = 'title:\n  enabled: false\nprewalk:\n  enabled: false\ncompaction:\n  enabled: false\n';
  const context = (profile: 'a' | 'b'): InferenceExecutionContext => ({
    version: 1, projectId: `project-${profile}`, assignmentRevision: 1,
    profile: { version: 1, id: profile, name: profile, revision: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', settings: {
      modelRoles: { ...Object.fromEntries(['default', 'smol', 'slow', 'tiny', 'commit', 'vision', 'task'].map(role => [role, 'openai/profile-model'])), advisor: 'openai/profile-advisor' },
      'providers.models': {
        openai: { baseUrl: `${server.url}provider/${profile}/v1`, api: 'openai-completions', models: [
          ...['profile-model', 'profile-advisor', 'profile-task'].map(id => ({ id, name: id, reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 })),
          { id: 'profile-image', name: 'profile-image', api: 'openai-responses', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 },
        ] },
        'amazon-bedrock': { baseUrl: `${server.url}bedrock`, api: 'bedrock-converse-stream', models: [{ id: 'profile-bedrock', name: 'Profile Bedrock', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }] },
      },
    } },
    advanced: { generation: 1, content, checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'test' },
    broker: { url: `${server.url}profiles/${profile}`, token: `broker-${profile}` },
  });
  async function run(profile: 'a' | 'b', operation: string) {
    const child = Bun.spawn([process.execPath, new URL('./fixtures/inference-runner.ts', import.meta.url).pathname], {
      env: { ...process.env, INFERENCE_FIXTURE: JSON.stringify({ context: context(profile), directory, operation }), GITSPACE_MANAGED_INFERENCE: '1', OPENAI_API_KEY: 'ambient-personal-key', AWS_CONTAINER_CREDENTIALS_FULL_URI: `${server.url}metadata`, AWS_EC2_METADATA_DISABLED: 'false' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`Inference fixture failed: ${stderr}`);
    return JSON.parse(stdout.trim().split('\n').at(-1)!) as { ok: boolean; error?: string };
  }
  return { directory, context, requests, run };
}

describe('profile-bound managed provider dispatch', () => {
  it('keeps concurrent profiles using the same provider isolated at the actual HTTP request', async () => {
    const f = await fixture();
    expect(await Promise.all([f.run('a', 'complete'), f.run('b', 'complete')])).toEqual([{ ok: true }, { ok: true }]);
    expect(f.requests.map(request => [request.path, request.authorization]).sort()).toEqual([
      ['/provider/a/v1/chat/completions', 'Bearer profile-a-key'], ['/provider/b/v1/chat/completions', 'Bearer profile-b-key'],
    ]);
  }, 30_000);

  it('uses the profile credential through SDK, task, advisor, title, commit, vision and eval helpers', async () => {
    const f = await fixture();
    expect(await f.run('a', 'helpers')).toEqual({ ok: true });
    const bodies = f.requests.map(request => request.body);
    expect(bodies.some(body => body.includes('main SDK managed scope probe'))).toBe(true);
    expect(bodies.some(body => JSON.parse(body).model === 'profile-advisor')).toBe(true);
    expect(bodies.some(body => JSON.parse(body).model === 'profile-task')).toBe(true);
    expect(bodies.some(body => body.includes('title managed scope probe'))).toBe(true);
    expect(bodies.some(body => body.includes('<diff>'))).toBe(true);
    expect(bodies.some(body => body.includes('image_url'))).toBe(true);
    expect(bodies.some(body => body.includes('eval managed scope probe'))).toBe(true);
    expect(f.requests.every(request => request.authorization === 'Bearer profile-a-key')).toBe(true);
  }, 60_000);

  it('rejects explicit foreign keys and credential headers, including native compaction, before any request', async () => {
    const f = await fixture();
    for (const operation of ['explicit', 'header', 'model-header', 'native-foreign']) {
      expect((await f.run('a', operation)).ok).toBe(false);
    }
    expect(f.requests).toEqual([]);
  }, 60_000);

  it('admits image generation through the profile and rejects foreign keys or models before any request', async () => {
    const f = await fixture();
    expect(await f.run('a', 'image')).toEqual({ ok: true });
    expect(f.requests.map(request => [request.path, request.authorization])).toEqual([['/provider/a/v1/responses', 'Bearer profile-a-key']]);
    for (const operation of ['image-explicit', 'image-foreign']) {
      expect((await f.run('a', operation)).ok).toBe(false);
    }
    expect(f.requests).toHaveLength(1);
  }, 30_000);

  it('does not resolve missing credentials from personal OpenAI env or Bedrock metadata', async () => {
    const f = await fixture(true);
    expect((await f.run('a', 'complete')).ok).toBe(false);
    expect((await f.run('a', 'bedrock')).ok).toBe(false);
    expect(f.requests).toEqual([]);
  }, 30_000);

  it('rejects a foreign retry candidate after the scoped first request fails', async () => {
    const f = await fixture(false, true);
    expect((await f.run('a', 'retry-foreign')).ok).toBe(false);
    expect(f.requests.map(request => request.authorization)).toEqual(['Bearer profile-a-key']);
  }, 30_000);

  it('refuses local model configuration rather than importing account-wide credentials or routing', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, 'models.yml'), 'providers:\n  openai:\n    apiKey: personal-file-key\n');
    await expect(createManagedInference(f.context('a'), { agentDir: f.directory, cwd: f.directory })).rejects.toThrow('Local model configuration conflicts');
    expect(f.requests).toEqual([]);
  });
});
