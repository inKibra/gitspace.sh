import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const resultSchema = z.object({
  stopReason: z.string(), errorMessage: z.string(), failureAfterStop: z.unknown(), failureAfterError: z.unknown(),
});

test('a user Stop is not an execution failure, while a model error still is', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-user-interrupt-'));
  const program = join(root, 'interrupt.mjs');
  // Run the real SDK so the interrupt carries OMP's own error flags.
  await writeFile(program, `
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddedOmpRuntime } from ${JSON.stringify(new URL('../src/session.ts', import.meta.url).pathname)};
import { AuthStorage } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-ai', import.meta.dir))};
import { postmortem } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-utils', import.meta.dir))};
const root = process.env.HOME;
const streaming = Promise.withResolvers();
let requests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/v1/models') return Response.json({ data: [{ id: 'test', object: 'model', owned_by: 'openai' }] });
  if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
  await request.json();
  if (++requests === 2) return Response.json({ error: { message: 'model overloaded', type: 'server_error' } }, { status: 400 });
  // The first turn streams until the user stops it.
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Working' }, finish_reason: null }] }) + '\\n\\n'));
    streaming.resolve();
  } }), { headers: { 'content-type': 'text/event-stream' } });
} });
const agentDir = join(root, 'agent');
const workspace = join(root, 'workspace');
await Promise.all([mkdir(agentDir), mkdir(workspace)]);
await writeFile(join(agentDir, 'models.yml'), JSON.stringify({ providers: { openai: {
  baseUrl: 'http://127.0.0.1:' + server.port + '/v1', api: 'openai-completions', apiKey: 'local-test-key',
  models: [{ id: 'test', name: 'Test', reasoning: false, contextWindow: 131072, maxTokens: 4096 }],
} } }));
await writeFile(join(agentDir, 'config.yml'), JSON.stringify({
  modelRoles: { default: 'openai/test' }, enabledModels: ['openai/test'], enabledProviders: ['openai'],
  git: { enabled: false }, lsp: { enabled: false }, retry: { maxRetries: 0 },
}));
const auth = await AuthStorage.create(join(root, 'auth.sqlite'));
const runtime = new EmbeddedOmpRuntime({ agentDir, sessionRoot: join(root, 'sessions'), authStorage: async () => auth });
let session;
try {
  session = await runtime.create({ projectId: 'project', workspaceId: 'workspace', workingDirectory: workspace, sessionKey: 'space', artifactsDir: join(root, 'artifacts') });
  await session.setModel('openai', 'test');
  const running = session.prompt('Start working.');
  await streaming.promise;
  await session.stop();
  await running.catch(() => undefined);
  const stopped = (await session.messages()).filter(message => message.role === 'assistant').at(-1);
  const failureAfterStop = session.activity().failure;
  await session.prompt('Try again.').catch(() => undefined);
  console.log('INTERRUPT_RESULT=' + JSON.stringify({
    stopReason: stopped?.stopReason ?? '', errorMessage: stopped?.errorMessage ?? '',
    failureAfterStop, failureAfterError: session.activity().failure,
  }));
} finally {
  await session?.dispose();
  auth.close();
  await server.stop(true);
  await postmortem.cleanup();
}
`);
  const child = Bun.spawn([process.execPath, program], { cwd: root, env: { ...process.env, HOME: root }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`OMP interrupt run failed (${code}): ${stderr}\n${stdout}`);
    const line = /INTERRUPT_RESULT=(.*)/u.exec(stdout)?.[1];
    if (!line) throw new Error(`Missing interrupt result: ${stdout}\n${stderr}`);
    const result = resultSchema.parse(JSON.parse(line));
    expect(result.stopReason).toBe('aborted');
    expect(result.errorMessage).toBe('Interrupted by user');
    expect(result.failureAfterStop).toBeNull();
    expect(result.failureAfterError).toMatchObject({ code: 'AGENT_EXECUTION_FAILED' });
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
