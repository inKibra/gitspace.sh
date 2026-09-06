import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const resumeResultSchema = z.object({
  stopped: z.boolean(),
  replies: z.array(z.string()),
  history: z.array(z.string()),
  goalsForRequests: z.array(z.enum(['initial', 'latest'])),
  uninterruptedAfterEdit: z.boolean(),
  instructionNotices: z.number().int(),
});

test('resumes a cancelled partial response without deleting progress or inventing a user message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-resume-'));
  const program = join(root, 'resume.mjs');
  // A real SDK in its own process keeps registry, settings and shutdown hooks isolated.
  await writeFile(program, `
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddedOmpRuntime } from ${JSON.stringify(new URL('../src/session.ts', import.meta.url).pathname)};
import { AuthStorage } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-ai', import.meta.dir))};
import { postmortem } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-utils', import.meta.dir))};
const root = process.env.HOME;
const partialSeen = Promise.withResolvers();
let requests = 0;
const goalsForRequests = [];
let instructions = { goal: { projectId: 'project', spaceId: 'workspace', id: 'goal', revision: 1, title: 'initial-goal-marker', summary: '', phase: 'code', requirements: [], updatedBy: 'user' }, workflow: null, rubric: null };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/v1/models') return Response.json({ data: [{ id: 'test', object: 'model', owned_by: 'openai' }] });
  if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
  const payload = await request.json();
  goalsForRequests.push(JSON.stringify(payload).includes('latest-goal-marker') ? 'latest' : 'initial');
  const number = ++requests;
  const text = number === 1 ? 'First answer.' : number === 2 ? 'Partial reply.' : 'Recovered.';
  return new Response(new ReadableStream({ start(controller) {
    const encoder = new TextEncoder();
    const send = (delta, finish_reason) => controller.enqueue(encoder.encode('data: ' + JSON.stringify({
      id: 'chatcmpl-' + number, object: 'chat.completion.chunk', created: 1, model: 'test',
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\\n\\n'));
    send({ role: 'assistant', content: text }, null);
    if (number === 2) return;
    send({}, 'stop');
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
  git: { enabled: false }, lsp: { enabled: false }, retry: { maxRetries: 0 },
}));
const auth = await AuthStorage.create(join(root, 'auth.sqlite'));
const runtime = new EmbeddedOmpRuntime({ agentDir, sessionRoot: join(root, 'sessions'), authStorage: async () => auth,
  spaceNamespace: { declaration: '{}', call: async () => instructions },
});
let session;
let instructionNotices = 0;
try {
  session = await runtime.create({ projectId: 'project', workspaceId: 'workspace', workingDirectory: workspace, sessionKey: 'space', artifactsDir: join(root, 'artifacts') });
  await session.setModel('openai', 'test');
  await session.prompt('First task.');
  session.subscribe(event => { if (event.type === 'message_update' && JSON.stringify(event).includes('Partial reply.')) partialSeen.resolve(); });
  session.subscribe(event => { if (event.type === 'message_end' && event.message?.customType === 'gitspace-instructions-changed') instructionNotices += 1; });
  const running = session.prompt('Finish the second task.');
  await partialSeen.promise;
  instructions = { ...instructions, goal: { ...instructions.goal, revision: 2, title: 'latest-goal-marker' } };
  await session.instructionsChanged();
  const uninterruptedAfterEdit = requests === 2 && session.activity().activity.active;
  await session.stop();
  await running;
  const stopped = (await session.messages()).some(message => message.role === 'assistant' && message.stopReason === 'aborted');
  await session.resume();
  const replies = (await session.messages()).filter(message => message.role === 'assistant').map(message => message.content.filter(part => part.type === 'text').map(part => part.text).join(''));
  console.log('RESUME_RESULT=' + JSON.stringify({ stopped, replies, history: (await session.control()).history.map(entry => entry.text), goalsForRequests, uninterruptedAfterEdit, instructionNotices }));
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
    if (code !== 0) throw new Error(`OMP continuation failed (${code}): ${stderr}\n${stdout}`);
    const line = stdout.split('\n').find((value) => value.startsWith('RESUME_RESULT='));
    if (!line) throw new Error(`Missing continuation result: ${stdout}\n${stderr}`);
    const result = resumeResultSchema.parse(JSON.parse(line.slice('RESUME_RESULT='.length)));
    expect(result).toEqual({
      stopped: true,
      replies: ['First answer.', 'Partial reply.', 'Recovered.'],
      history: ['First task.', 'Finish the second task.'],
      goalsForRequests: ['initial', 'initial', 'latest'],
      uninterruptedAfterEdit: true,
      instructionNotices: 1,
    });
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
