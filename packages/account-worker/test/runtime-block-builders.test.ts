import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { RuntimeBlocksArgumentsSchema } from '@gitspace/protocol-runtime/tool-arguments';
import { validateMarkdownBlocks } from '@gitspace/protocol/gitspace-ui';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository } from '@gitspace/runtime-workspace-do';
import { readInspectorContext } from '../src/account-inspector-data.js';
import { cloudBlock } from '../src/runtime-block-builders.js';

const sha1 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const PARSE = 'export function parse(line: string) {\n  const [key, value] = line.split("=");\n  return { key, value };\n}\n';
const BASE: Record<string, string> = { 'packages/config/package.json': '{"name":"config"}\n', 'packages/config/src/parse.ts': PARSE, 'README.md': 'Readme\n' };
const HEAD: Record<string, string> = {
  ...BASE,
  'packages/config/src/parse.ts': PARSE.replace('  const [key, value] = line.split("=");', '  const at = line.indexOf("=");\n  const key = line.slice(0, at), value = line.slice(at + 1);'),
  'packages/config/src/trim.ts': 'export const trim = (text: string) => text.trim();\n',
  'README.md': 'Readme\n\nMore.\n',
};

/**
 * A cloud workspace whose branch made one commit on the project's `main`: its Artifacts history, trees and blobs (each
 * commit's root tree keyed by the commit), and the runtime checkpoint the Inspector reads, its worktree at HEAD.
 */
async function workspaceFixture() {
  const projectId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await authority.bootstrap({ id: projectId, name: 'Config', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.setProjectLifecycle(created.revision, 'active'));
  const workspaceId = `space-${crypto.randomUUID()}`;
  await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'Parser', branch: 'parser', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const base = 'b'.repeat(40), head = 'c'.repeat(40);
  const workspace = artifactsWorkspaceRepository(workspaceId), project = artifactsProjectRepository(projectId);
  const commits: Record<string, { parents: string[]; repositories: string[] }> = { [base]: { parents: [], repositories: [workspace, project] }, [head]: { parents: [base], repositories: [workspace] } };
  const identity = { name: 'Fixture', email: 'fixture@example.invalid' };
  const metadata = (hash: string): ArtifactsCommitMetadata => ({ hash, treeHash: hash, message: hash, author: identity, committer: identity, parents: commits[hash]!.parents, authoredAt: 1, committedAt: 1 });
  vi.spyOn(ArtifactsCodeStore.prototype, 'resolveRef').mockImplementation(async (repository, ref) => repository === project && ref === 'main' ? base : null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockImplementation(async (repository, hash) => commits[hash]?.repositories.includes(repository) ? metadata(hash) : null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'log').mockImplementation(async (repository, start, limit = 50) => {
    const page: ArtifactsCommitMetadata[] = [];
    for (let hash: string | undefined = start; hash !== undefined && commits[hash]?.repositories.includes(repository) && page.length < limit; hash = commits[hash]?.parents[0]) page.push(metadata(hash));
    return page;
  });
  const trees: Record<string, ArtifactsTreeEntry[]> = {};
  const blobs: Record<string, string> = {};
  const writeTree = async (id: string, files: Record<string, string>, prefix: string): Promise<void> => {
    const entries: ArtifactsTreeEntry[] = [];
    const folders = new Set<string>();
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes('/')) { folders.add(rest.slice(0, rest.indexOf('/'))); continue; }
      const oid = await sha1(`blob ${content}`);
      blobs[oid] = content;
      entries.push({ name: rest, type: 'blob', mode: '100644', hash: oid });
    }
    for (const folder of folders) {
      const oid = await sha1(`tree ${id} ${prefix}${folder}`);
      await writeTree(oid, files, `${prefix}${folder}/`);
      entries.push({ name: folder, type: 'tree', mode: '40000', hash: oid });
    }
    trees[id] = entries.sort((left, right) => left.name.localeCompare(right.name));
  };
  await writeTree(base, BASE, '');
  await writeTree(head, HEAD, '');
  vi.spyOn(ArtifactsCodeStore.prototype, 'reader').mockImplementation(function (this: ArtifactsCodeStore, repository: string) {
    return {
      readTree: async (oid: string) => trees[oid] ?? null,
      readBlob: async (oid: string) => blobs[oid] === undefined ? null : new Blob([blobs[oid]]),
      readCommit: (hash: string) => this.readCommit(repository, hash),
      log: (start: string, limit?: number) => this.log(repository, start, limit),
      close: async () => {},
    };
  });
  const checkpoint: RuntimeGitCheckpoint = { checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints`, headCommit: head, branch: 'parser', indexCommit: head, trackedWorktreeCommit: head, worktreeCommit: head, indexTree: head, worktreeTree: head };
  await runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`), (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
    state.storage.sql.exec('INSERT OR REPLACE INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(checkpoint));
  });
  const source = await readInspectorContext(env, env.ACCOUNT_ID, workspaceId, projectId);
  return { base, head, build: (args: unknown) => cloudBlock(env, env.ACCOUNT_ID, source, RuntimeBlocksArgumentsSchema.parse(args)) };
}

describe('blocks from the cloud working copy', () => {
  it('diffs one file against its merge base with the project\'s base branch, with its real hunks', async () => {
    const { build } = await workspaceFixture();
    const built = await build({ op: 'diff', path: 'packages/config/src/parse.ts' });
    expect(built.component).toBe('Diff');
    expect(built.props).toMatchObject({ title: 'packages/config/src/parse.ts · against main (merge base bbbbbbb)' });
    const patch = String(Reflect.get(Object(built.props), 'patch'));
    expect(patch).toContain('diff --git a/packages/config/src/parse.ts b/packages/config/src/parse.ts');
    expect(patch).toContain('@@ -1,4 +1,5 @@');
    expect(patch).toContain('-  const [key, value] = line.split("=");\n+  const at = line.indexOf("=");\n+  const key = line.slice(0, at), value = line.slice(at + 1);');
    expect(validateMarkdownBlocks(built.fence)).toEqual([]);
    await expect(build({ op: 'diff', path: 'packages/config/package.json' })).rejects.toThrow('packages/config/package.json has no changes against main');
  });

  it('excerpts a file\'s exact lines, pinned to HEAD while unchanged, or at a given commit', async () => {
    const { base, head, build } = await workspaceFixture();
    expect((await build({ op: 'excerpt', path: 'packages/config/src/parse.ts', start: 2, end: 3, highlight: [3] })).props).toEqual({
      path: 'packages/config/src/parse.ts', startLine: 2, lines: ['  const at = line.indexOf("=");', '  const key = line.slice(0, at), value = line.slice(at + 1);'], commit: head, highlight: [3], note: null,
    });
    expect((await build({ op: 'excerpt', path: 'packages/config/src/parse.ts', start: 2, end: 2, commit: base })).props).toMatchObject({ lines: ['  const [key, value] = line.split("=");'], commit: base });
  });

  it('lists every changed file with its counts, grouped by its package or else its folder', async () => {
    const { build } = await workspaceFixture();
    const built = await build({ op: 'changeSet' });
    expect(built.props).toEqual({
      base: 'main (merge base bbbbbbb)', head: 'ccccccc',
      files: [
        { path: 'packages/config/src/parse.ts', added: 2, removed: 1, status: 'modified', binary: null },
        { path: 'packages/config/src/trim.ts', added: 1, removed: 0, status: 'added', binary: null },
        { path: 'README.md', added: 2, removed: 0, status: 'modified', binary: null },
      ],
      groups: [{ name: 'packages/config', paths: ['packages/config/src/parse.ts', 'packages/config/src/trim.ts'] }, { name: '(root)', paths: ['README.md'] }],
    });
    expect(validateMarkdownBlocks(built.fence)).toEqual([]);
  });
});
