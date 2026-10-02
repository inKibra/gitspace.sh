import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase, LocalArtifactResolver, MemoryArtifactObjectStore } from '@gitspace/core';
import { readInspectorResource } from '../src/inspector-resources.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-resource-'));
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  cleanup.push(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
  database.createProject({ id: 'project', name: 'Project', repositoryPath: '/repo' });
  database.createWorkspace({ id: 'workspace', projectId: 'project', name: 'Workspace', branch: 'work', rootPath: '/repo/work' });
  database.createWorkspace({ id: 'sibling', projectId: 'project', name: 'Sibling', branch: 'sibling', rootPath: '/repo/sibling' });
  const artifacts = new LocalArtifactResolver(database, new MemoryArtifactObjectStore(), join(root, 'cache'), new Uint8Array(32).fill(7));
  const input = { sessionFile: join(root, 'session-a.jsonl'), localArtifactsDir: join(root, 'mounted-a'), capability: { kind: 'workspace', projectId: 'project', workspaceId: 'workspace' } as const, artifacts };
  mkdirSync(join(root, 'session-a'));
  mkdirSync(join(root, 'session-b'));
  mkdirSync(input.localArtifactsDir);
  return { root, input };
}

async function readText(input: Parameters<typeof readInspectorResource>[0]): Promise<string> {
  const frames = [...await readInspectorResource(input)];
  expect(frames[0]).toMatchObject({ type: 'metadata', text: true });
  const chunks = frames.slice(1).map((frame) => {
    if (frame.type !== 'chunk') throw new Error('Expected a byte chunk after metadata');
    return Buffer.from(frame.base64, 'base64');
  });
  return Buffer.concat(chunks).toString('utf8');
}

describe('Inspector session resource reads', () => {
  it('resolves a tool-output counter only in its originating session, including selectors', async () => {
    const { root, input } = fixture();
    writeFileSync(join(root, 'session-a', '3.bash.log'), 'first\nselected\nlast');
    writeFileSync(join(root, 'session-b', '3.bash.log'), 'other session secret');
    writeFileSync(join(root, 'session-b', '4.read.log'), 'must not be a fallback');
    expect(await readText({ ...input, url: 'artifact://3:2-2' })).toBe('selected');
    expect(await readText({ ...input, sessionFile: join(root, 'session-b.jsonl'), url: 'artifact://3' })).toBe('other session secret');
    await expect(readInspectorResource({ ...input, url: 'artifact://4' })).rejects.toThrow('not available in this session');
  });

  it('reads legacy roots before implicit mounted artifacts and preserves durable base access', async () => {
    const { root, input } = fixture();
    const encoded = new TextEncoder();
    await input.artifacts.write(input.capability, 'local://workspace/PLAN.md', encoded.encode('current mount plan'));
    await input.artifacts.write({ kind: 'project', projectId: 'project' }, 'local://base/reference.md', encoded.encode('project reference'));
    expect(await readText({ ...input, url: 'local://PLAN.md' })).toBe('current mount plan');
    writeFileSync(join(input.localArtifactsDir, 'PLAN.md'), 'actual legacy plan');
    expect(await readText({ ...input, url: 'local://PLAN.md' })).toBe('actual legacy plan');
    mkdirSync(join(root, 'session-a', 'local'));
    writeFileSync(join(root, 'session-a', 'local', 'Old.md'), 'original OMP local artifact');
    expect(await readText({ ...input, url: 'local://Old.md' })).toBe('original OMP local artifact');
    expect(await readText({ ...input, url: 'local://base/reference.md' })).toBe('project reference');
  });

  it('returns a useful bounded-preview error and lets a line selector recover large tool output', async () => {
    const { root, input } = fixture();
    writeFileSync(join(root, 'session-a', '5.read.log'), `first line\n${'long output\n'.repeat(20_000)}`);
    await expect(readText({ ...input, url: 'artifact://5' })).rejects.toThrow('128 KiB');
    expect(await readText({ ...input, url: 'artifact://5:1-1' })).toBe('first line');
  });

  it('rejects path traversal, symlink escape, and unauthorized sibling mounts', async () => {
    const { root, input } = fixture();
    writeFileSync(join(root, 'session-b', 'secret.txt'), 'sibling secret');
    symlinkSync(join(root, 'session-b'), join(input.localArtifactsDir, 'outside'));
    symlinkSync(join(root, 'session-b', 'secret.txt'), join(root, 'session-a', '9.read.log'));
    await expect(readInspectorResource({ ...input, url: 'local://../session-b/secret.txt' })).rejects.toThrow('unsafe');
    await expect(readInspectorResource({ ...input, url: 'local://outside/secret.txt' })).rejects.toThrow('escapes');
    await expect(readInspectorResource({ ...input, url: 'artifact://9' })).rejects.toThrow('escapes');
    await expect(readInspectorResource({ ...input, url: 'local://workspaces/sibling/secret.txt' })).rejects.toThrow('sibling');
  });
});
