import { expect, test } from 'bun:test';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('edits discovered workspace overrides with CAS while rejecting invalid or escaping writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omp-agent-setup-'));
  const alias = `${root}-alias`;
  await symlink(root, alias);
  const program = join(root, 'setup.mjs');
  await writeFile(program, `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EmbeddedOmpRuntime } from ${JSON.stringify(new URL('../src/session.ts', import.meta.url).pathname)};
import { AuthStorage } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-ai', import.meta.dir))};
import { postmortem } from ${JSON.stringify(Bun.resolveSync('@oh-my-pi/pi-utils', import.meta.dir))};
const root = process.env.HOME;
const agentDir = join(root, 'agent');
const workspace = join(root, 'workspace');
await Promise.all([mkdir(agentDir), mkdir(workspace)]);
await writeFile(join(agentDir, 'models.yml'), JSON.stringify({ providers: { openai: {
  baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'fixture-only',
  models: ['normal', 'fast'].map(id => ({ id, name: id, reasoning: false, contextWindow: 131072, maxTokens: 4096 })),
} } }));
const settings = JSON.stringify({
  modelRoles: { default: 'openai/normal', smol: 'openai/fast' }, enabledModels: ['openai/normal', 'openai/fast'], enabledProviders: ['openai'],
  task: { agentModelOverrides: { task: '@smol' } }, git: { enabled: false }, lsp: { enabled: false }, retry: { maxRetries: 0 },
});
await writeFile(join(agentDir, 'config.yml'), settings);
const auth = await AuthStorage.create(join(root, 'auth.sqlite'));
const runtime = new EmbeddedOmpRuntime({ agentDir, sessionRoot: join(root, 'sessions'), authStorage: async () => auth });
let session;
try {
  session = await runtime.create({ projectId: 'project', workspaceId: 'workspace', workingDirectory: workspace, sessionKey: 'space', artifactsDir: join(root, 'artifacts') });
  const inherited = (await session.agentSetup()).agents.find(agent => agent.name === 'task');
  assert(inherited && !inherited.editable && inherited.source === 'bundled');
  assert.equal(inherited.selection, 'settings');
  assert.equal(inherited.role, 'smol');
  assert.equal(inherited.model, 'fast');
  await assert.rejects(() => session.saveAgentDefinition({ path: inherited.path, expectedRevision: inherited.revision, content: inherited.content }));
  const path = '.omp/agents/task.md';
  const content = inherited.content + '\\nWorkspace override marker.\\n';
  const created = (await session.saveAgentDefinition({ path, expectedRevision: null, content })).agents.find(agent => agent.name === 'task');
  assert(created && created.editable);
  assert.equal(created.path, path);
  assert.equal(created.content, content);
  assert.equal(created.revision, createHash('sha256').update(content).digest('hex'));
  assert.equal(created.selection, 'settings');
  assert.equal(created.model, 'fast');
  await assert.rejects(() => session.saveAgentDefinition({ path, expectedRevision: null, content }));
  const changes = [content + 'First edit.\\n', content + 'Second edit.\\n'];
  const saves = await Promise.allSettled(changes.map(content => session.saveAgentDefinition({ path, expectedRevision: created.revision, content })));
  assert.equal(saves.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(await readFile(join(workspace, path), 'utf8'), changes[saves.findIndex(value => value.status === 'fulfilled')]);
  const latest = (await session.agentSetup()).agents.find(agent => agent.name === 'task');
  const external = latest.content + 'External editor.\\n';
  await writeFile(join(workspace, path), external);
  await assert.rejects(() => session.saveAgentDefinition({ path, expectedRevision: latest.revision, content }));
  const revision = createHash('sha256').update(external).digest('hex');
  await assert.rejects(() => session.saveAgentDefinition({ path, expectedRevision: revision, content: '---\\nname: [invalid\\n---\\n' }));
  await assert.rejects(() => session.saveAgentDefinition({ path, expectedRevision: revision, content: content + 'x'.repeat(131072) }));
  for (const escaped of ['../task.md', '/tmp/task.md', '.omp/agents/../task.md', '.omp/agents/sub/task.md', '.omp/agents/%2e%2e/task.md', '.omp\\\\agents\\\\task.md']) {
    await assert.rejects(() => session.saveAgentDefinition({ path: escaped, expectedRevision: null, content }));
  }
  assert.equal(await readFile(join(workspace, path), 'utf8'), external);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'task.md'), external);
  await symlink(join(outside, 'task.md'), join(workspace, '.omp/agents/link.md'));
  await assert.rejects(() => session.saveAgentDefinition({ path: '.omp/agents/link.md', expectedRevision: revision, content }));
  await unlink(join(workspace, '.omp/agents/link.md'));
  await rename(join(workspace, '.omp/agents'), join(workspace, '.omp/original-agents'));
  await symlink(outside, join(workspace, '.omp/agents'));
  await assert.rejects(() => session.saveAgentDefinition({ path, expectedRevision: revision, content }));
  assert.equal(await readFile(join(outside, 'task.md'), 'utf8'), external);
  await unlink(join(workspace, '.omp/agents'));
  await rename(join(workspace, '.omp/original-agents'), join(workspace, '.omp/agents'));
  await writeFile(join(workspace, '.omp/agents/broken.md'), '---\\nname: [broken\\n---\\n');
  await assert.rejects(() => session.agentSetup(), /broken\\.md/);
  assert.equal(await readFile(join(agentDir, 'config.yml'), 'utf8'), settings);
  console.log('AGENT_SETUP_OK');
} finally {
  await session?.dispose();
  auth.close();
  await postmortem.cleanup();
}
`);
  const child = Bun.spawn([process.execPath, program], { cwd: alias, env: { ...process.env, HOME: alias }, stdout: 'pipe', stderr: 'pipe', timeout: 40_000 });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Agent setup fixture failed (${code}): ${stderr}\n${stdout}`);
    expect(stdout).toContain('AGENT_SETUP_OK');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { recursive: true, force: true });
    await rm(alias, { force: true });
  }
}, 45_000);
