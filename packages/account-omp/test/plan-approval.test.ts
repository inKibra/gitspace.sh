import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const resultSchema = z.object({
  askResult: z.string(), askError: z.boolean(),
  refinement: z.string(), approval: z.string(), approvalError: z.boolean(),
  setPhase: z.array(z.unknown()), planModeAfter: z.boolean(), questions: z.array(z.string()),
  handedOff: z.boolean(), interrupted: z.string(), interruptedError: z.boolean(),
});

test('asks the reviewer to approve a proposed plan, moves an approved workspace to Code, and releases a pending approval on handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-plan-approval-'));
  const program = join(root, 'approval.mjs');
  // Run the real SDK, ask tool, and xd://propose dispatch without sharing global registries with other tests.
  await writeFile(program, `
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddedOmpRuntime } from ${JSON.stringify(new URL('../src/session.ts', import.meta.url).pathname)};
import { AuthStorage } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-ai', import.meta.dir))};
import { postmortem } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-utils', import.meta.dir))};
import { initTheme } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-tui/theme', import.meta.dir))};
await initTheme();
const root = process.env.HOME;
let requests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/v1/models') return Response.json({ data: [{ id: 'test', object: 'model', owned_by: 'openai' }] });
  if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
  await request.json();
  const number = ++requests;
  const calls = {
    // GitSpace plans live in the writable mount; the slug proposal resolves there.
    1: ['write', { i: 'Writing the plan', path: 'local://workspace/music-updates-plan.md', content: '# Music updates\\n\\n1. Add the updater.\\n' }],
    2: ['ask', { i: 'Asking scope', questions: [{ id: 'scope', question: 'Which catalog?', options: [{ label: 'Albums' }, { label: 'Singles' }] }] }],
    3: ['write', { i: 'Proposing the plan', path: 'xd://propose', content: 'music-updates' }],
    4: ['write', { i: 'Proposing the revised plan', path: 'xd://propose', content: 'music-updates' }],
    6: ['write', { i: 'Proposing after returning to Plan', path: 'xd://propose', content: 'music-updates' }],
  };
  return new Response(new ReadableStream({ start(controller) {
    const encoder = new TextEncoder();
    const send = (delta, finish_reason = null) => controller.enqueue(encoder.encode('data: ' + JSON.stringify({
      id: 'chatcmpl-' + number, object: 'chat.completion.chunk', created: 1, model: 'test',
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\\n\\n'));
    send({ role: 'assistant' });
    const call = calls[number];
    if (call) {
      send({ tool_calls: [{ index: 0, id: 'call-' + number, type: 'function', function: { name: call[0], arguments: JSON.stringify(call[1]) } }] });
      send({}, 'tool_calls');
    } else { send({ content: 'Implementing.' }); send({}, 'stop'); }
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
const setPhase = [];
let session;
// The machine's typed workspace controls: setPhase moves this session's workspace phase, as the machine does over IPC.
const workspaceControls = {
  instructions: async () => ({ goal: null, workflow: null, rubric: null }),
  setPhase: async (phase) => { setPhase.push(phase); await session.setWorkspacePhase(phase); },
};
const auth = await AuthStorage.create(join(root, 'auth.sqlite'));
const runtime = new EmbeddedOmpRuntime({ agentDir, sessionRoot: join(root, 'sessions'), authStorage: async () => auth, workspaceControls });
const input = { projectId: 'project', workspaceId: 'workspace', workingDirectory: workspace, sessionKey: 'space', artifactsDir: join(root, 'artifacts') };
const questions = [];
const answers = { scope: [{ id: 'scope', selectedOptions: ['Albums'], customInput: null }] };
const answered = new Set();
let approvals = 0;
let handoff = null;
try {
  session = await runtime.create({ ...input, workspacePhase: 'plan' });
  await session.setModel('openai', 'test');
  await session.setWorkspacePhase('plan');
  // Answer each question as the web would when the session reports one pending; the first plan review asks for changes.
  const unsubscribe = session.subscribeActivity(async (activity) => {
    if (!activity.reasons.some(reason => reason.kind === 'human')) return;
    const pending = (await session.control()).pendingAsk;
    if (!pending || answered.has(pending.id)) return;
    answered.add(pending.id);
    const question = pending.questions[0];
    questions.push(question.id);
    // A launch drains the machine while this approval is still unanswered.
    if (question.id === 'plan-approval' && approvals === 2) { handoff = session.handoff(); return; }
    const reply = question.id === 'plan-approval'
      ? [{ id: question.id, selectedOptions: [++approvals === 1 ? 'Keep planning' : 'Approve and move to Code'], customInput: approvals === 1 ? 'add tests' : null }]
      : answers[question.id];
    await session.answerAsk(pending.id, reply);
  });
  await session.prompt('Plan the music updater.');
  const planModeAfter = (await session.control()).planMode;
  await session.setWorkspacePhase('plan');
  await session.prompt('Propose the plan again.');
  const handedOff = await handoff;
  unsubscribe();
  const results = (await session.messages()).filter(message => message.role === 'toolResult');
  const text = message => message?.content?.map(part => part.text ?? '').join('') ?? '';
  console.log('APPROVAL_RESULT=' + JSON.stringify({
    askResult: text(results[1]), askError: results[1]?.isError === true,
    refinement: text(results[2]), approval: text(results[3]), approvalError: results[3]?.isError === true,
    setPhase, planModeAfter, questions,
    handedOff, interrupted: text(results[4]), interruptedError: results[4]?.isError === true,
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
    if (code !== 0) throw new Error(`OMP plan approval failed (${code}): ${stderr}\n${stdout}`);
    const line = /APPROVAL_RESULT=(.*)/u.exec(stdout)?.[1];
    if (!line) throw new Error(`Missing approval result: ${stdout}\n${stderr}`);
    const result = resultSchema.parse(JSON.parse(line));
    expect(result.askError).toBe(false);
    expect(result.askResult).toContain('Albums');
    expect(result.refinement).toContain('Plan refinement requested. Reviewer feedback: add tests');
    expect(result.approvalError).toBe(false);
    expect(result.approval).toContain('Plan approved:');
    expect(result.setPhase).toEqual(['code']);
    expect(result.planModeAfter).toBe(false);
    expect(result.questions).toEqual(['scope', 'plan-approval', 'plan-approval', 'plan-approval']);
    expect(result.handedOff).toBe(true);
    expect(result.interruptedError).toBe(true);
    // The aborted proposal is not a review decision.
    expect(result.interrupted).not.toContain('Plan refinement requested');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
