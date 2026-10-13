import { afterEach, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LegacySubmoduleVerifier } from '../src/legacy-submodule-recovery.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function git(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'Recovery test', GIT_AUTHOR_EMAIL: 'recovery@test.invalid', GIT_COMMITTER_NAME: 'Recovery test', GIT_COMMITTER_EMAIL: 'recovery@test.invalid' }, stdout: 'pipe', stderr: 'pipe' });
  const [code, text, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(error);
  return text.trim();
}

it('requires recoverable child and nested commits even after the last current gitlink was removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-submodule-recovery-')); roots.push(root);
  const leaf = join(root, 'leaf'), child = join(root, 'child'), parent = join(root, 'parent');
  for (const path of [leaf, child, parent]) {
    await mkdir(path); await git(path, ['init', '-b', 'main']);
    await writeFile(join(path, 'retained.txt'), `${path === leaf ? 'nested bytes' : 'parent bytes'}\n`);
    await git(path, ['add', 'retained.txt']); await git(path, ['commit', '-m', 'Initial retained bytes']);
  }
  const leafCommit = await git(leaf, ['rev-parse', 'HEAD']);
  await git(child, ['update-index', '--add', '--cacheinfo', `160000,${leafCommit},nested`]);
  await git(child, ['commit', '-m', 'Pin nested child']);
  const childCommit = await git(child, ['rev-parse', 'HEAD']);
  for (const path of ['module', 'second-module']) await git(parent, ['update-index', '--add', '--cacheinfo', `160000,${childCommit},${path}`]);
  await git(parent, ['commit', '-m', 'Pin child twice']);
  await git(parent, ['update-index', '--force-remove', 'module', 'second-module']);
  await git(parent, ['commit', '-m', 'Remove current links but preserve history']);
  const commit = await git(parent, ['rev-parse', 'HEAD']);
  const verifier = new LegacySubmoduleVerifier(git);
  await expect(verifier.verify(parent, commit, new Map())).rejects.toThrow(`Missing retained submodule commit ${childCommit}`);
  await expect(verifier.verify(parent, commit, new Map([['retained-child', child]]))).rejects.toThrow(`Missing retained submodule commit ${leafCommit}`);
  const recovered = await verifier.verify(parent, commit, new Map([['retained-child', child], ['retained-leaf', leaf]]));
  expect(recovered).toEqual([
    { commit: childCommit, repositoryPath: 'retained-child' },
    { commit: leafCommit, repositoryPath: 'retained-leaf' },
  ].sort((left, right) => left.commit.localeCompare(right.commit)));
  expect(await git(parent, ['rev-parse', 'HEAD'])).toBe(commit);
  expect(await git(leaf, ['show', `${leafCommit}:retained.txt`])).toBe('nested bytes');
});
