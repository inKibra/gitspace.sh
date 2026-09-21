import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const resultSchema = z.object({
  planMode: z.boolean(), codeMode: z.boolean(), restoredPlanMode: z.boolean(),
  rejectedInPlan: z.boolean(), uninterrupted: z.boolean(), codeFile: z.string(), restoredFile: z.string(),
  stalePlanningContext: z.boolean(), currentPhaseContext: z.boolean(), history: z.array(z.string()),
});

test('leaves plan restrictions during a live turn and restores the execution phase', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-workspace-phase-'));
  const program = join(root, 'phase.mjs');
  // Run the real SDK and write tool without sharing global registries with other tests.
  await writeFile(program, `
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddedOmpRuntime } from ${JSON.stringify(new URL('../src/session.ts', import.meta.url).pathname)};
import { AuthStorage } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-ai', import.meta.dir))};
import { postmortem } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-utils', import.meta.dir))};
const root = process.env.HOME;
const secondRequest = Promise.withResolvers();
const releaseSecond = Promise.withResolvers();
const payloads = [];
let requests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/v1/models') return Response.json({ data: [{ id: 'test', object: 'model', owned_by: 'openai' }] });
  if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
  const payload = await request.json();
  payloads.push(payload);
  const number = ++requests;
  return new Response(new ReadableStream({ async start(controller) {
    const encoder = new TextEncoder();
    const send = (delta, finish_reason = null) => controller.enqueue(encoder.encode('data: ' + JSON.stringify({
      id: 'chatcmpl-' + number, object: 'chat.completion.chunk', created: 1, model: 'test',
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\\n\\n'));
    send({ role: 'assistant' });
    if (number === 2) {
      send({ content: 'Continuing the existing turn.' });
      secondRequest.resolve();
      await releaseSecond.promise;
    }
    if (number === 1 || number === 2 || number === 4) {
      const path = number === 1 ? 'blocked.txt' : number === 2 ? 'code.txt' : 'restored.txt';
      send({ tool_calls: [{ index: 0, id: 'write-' + number, type: 'function', function: {
        name: 'write', arguments: JSON.stringify({ i: 'Writing phase proof', path, content: 'phase-write-' + number }),
      } }] });
      send({}, 'tool_calls');
    } else { send({ content: 'Finished.' }); send({}, 'stop'); }
    controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));
    controller.close();
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
  git: { enabled: false }, lsp: { enabled: false }, retry: { maxRetries: 0 }, tools: { approvalMode: 'yolo' },
}));
const auth = await AuthStorage.create(join(root, 'auth.sqlite'));
const runtime = new EmbeddedOmpRuntime({ agentDir, sessionRoot: join(root, 'sessions'), authStorage: async () => auth });
const input = { projectId: 'project', workspaceId: 'workspace', workingDirectory: workspace, sessionKey: 'space', artifactsDir: join(root, 'artifacts') };
let session;
try {
  session = await runtime.create(input);
  await session.setModel('openai', 'test');
  await session.setWorkspacePhase('plan');
  const planMode = (await session.control()).planMode;
  const running = session.prompt('Write the requested file.');
  await secondRequest.promise;
  const rejectedInPlan = (await session.messages()).some(message => message.role === 'toolResult' && message.isError && JSON.stringify(message).includes('Plan mode'));
  await session.setWorkspacePhase('code');
  const codeMode = (await session.control()).planMode;
  const uninterrupted = session.activity().activity.active && requests === 2;
  releaseSecond.resolve();
  await running;
  const codeFile = await readFile(join(workspace, 'code.txt'), 'utf8');
  const sessionFile = session.sessionFile;
  await session.dispose();
  session = await runtime.open({ ...input, sessionFile });
  const restoredPlanMode = (await session.control()).planMode;
  await session.prompt('Write another file after restore.');
  const restoredFile = await readFile(join(workspace, 'restored.txt'), 'utf8');
  const codeContext = JSON.stringify(payloads[2]);
  console.log('PHASE_RESULT=' + JSON.stringify({
    planMode, codeMode, restoredPlanMode, rejectedInPlan, uninterrupted, codeFile, restoredFile,
    stalePlanningContext: codeContext.includes('Plan mode is active') || codeContext.includes('Plan Mode Active'),
    currentPhaseContext: codeContext.includes('Current workspace phase: code.'),
    history: (await session.control()).history.map(entry => entry.text),
  }));
} finally {
  releaseSecond.resolve();
  await session?.dispose();
  auth.close();
  await server.stop(true);
  await postmortem.cleanup();
}
`);
  const child = Bun.spawn([process.execPath, program], { cwd: root, env: { ...process.env, HOME: root }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`OMP phase transition failed (${code}): ${stderr}\n${stdout}`);
    const line = stdout.split('\n').find((value) => value.startsWith('PHASE_RESULT='));
    if (!line) throw new Error(`Missing phase result: ${stdout}\n${stderr}`);
    expect(resultSchema.parse(JSON.parse(line.slice('PHASE_RESULT='.length)))).toEqual({
      planMode: true, codeMode: false, restoredPlanMode: false,
      rejectedInPlan: true, uninterrupted: true, codeFile: 'phase-write-2', restoredFile: 'phase-write-4',
      stalePlanningContext: false, currentPhaseContext: true,
      history: ['Write the requested file.', 'Write another file after restore.'],
    });
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
