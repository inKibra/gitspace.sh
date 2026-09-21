import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const resultSchema = z.object({
  history: z.array(z.string()),
});

test('reads controls on a deep branch with bounded, complete prompt recall from that branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-controls-'));
  const program = join(root, 'controls.mjs');
  // Real SDK, isolated from other tests' registries and settings. No model requests.
  await writeFile(program, `
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddedOmpRuntime } from ${JSON.stringify(new URL('../src/session.ts', import.meta.url).pathname)};
import { SessionManager } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-coding-agent', import.meta.dir))};
import { AuthStorage } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-ai', import.meta.dir))};
import { postmortem } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-utils', import.meta.dir))};
const root = process.env.HOME;
const agentDir = join(root, 'agent');
const workspace = join(root, 'workspace');
await Promise.all([mkdir(agentDir), mkdir(workspace)]);
await writeFile(join(agentDir, 'models.yml'), JSON.stringify({ providers: { openai: {
  baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'local-test-key',
  models: [{ id: 'test', name: 'Test', reasoning: false, contextWindow: 131072, maxTokens: 4096 }],
} } }));
await writeFile(join(agentDir, 'config.yml'), JSON.stringify({
  modelRoles: { default: 'openai/test' }, enabledModels: ['openai/test'], enabledProviders: ['openai'],
  git: { enabled: false }, lsp: { enabled: false }, retry: { maxRetries: 0 },
}));
const manager = SessionManager.create(workspace, join(root, 'sessions'));
manager.appendMessage({ role: 'user', content: 'Abandoned branch prompt', timestamp: 1 });
manager.resetLeaf();
for (let index = 0; index < 14000; index++) manager.appendCustomEntry('test-progress', { index });
for (let index = 0; index < 85; index++) manager.appendMessage({ role: 'user', content: 'Current prompt ' + index, timestamp: index + 2 });
manager.appendMessage({ role: 'user', content: 'oversized prompt '.repeat(1000), timestamp: 100 });
manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Finished.' }], api: 'openai-completions', provider: 'openai', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 101 });
await manager.flush();
const sessionFile = manager.getSessionFile();
await manager.close();
const auth = await AuthStorage.create(join(root, 'auth.sqlite'));
const runtime = new EmbeddedOmpRuntime({ agentDir, sessionRoot: join(root, 'sessions'), authStorage: async () => auth });
let session;
try {
  session = await runtime.open({ projectId: 'project', workspaceId: 'workspace', workingDirectory: workspace, sessionKey: 'space', artifactsDir: join(root, 'artifacts'), sessionFile });
  const control = await session.control();
  console.log('CONTROLS_RESULT=' + JSON.stringify({ history: control.history.map(entry => entry.text) }));
} finally {
  await session?.dispose();
  auth.close();
  await postmortem.cleanup();
}
`);
  const child = Bun.spawn([process.execPath, program], { cwd: root, env: { ...process.env, HOME: root }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`OMP controls failed (${code}): ${stderr}\n${stdout}`);
    const line = stdout.split('\n').find(value => value.startsWith('CONTROLS_RESULT='));
    if (!line) throw new Error(`Missing controls result: ${stdout}\n${stderr}`);
    const result = resultSchema.parse(JSON.parse(line.slice('CONTROLS_RESULT='.length)));
    const expectedHistory = Array.from({ length: 64 }, (_, index) => `Current prompt ${index + 21}`);
    expect(result.history).toEqual(expectedHistory);
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
