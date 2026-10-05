import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import git from 'isomorphic-git';
import { publishSnapshotPack, type ArtifactsFetch } from '../src/artifacts-snapshot.js';

test('receive-pack atomically rejects a ref advanced after discovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-race-'));
  try {
    await git.init({ fs, dir });
    const author = { name: 'Fixture', email: 'fixture@example.invalid', timestamp: 1, timezoneOffset: 0 };
    const tree = await git.writeTree({ fs, dir, tree: [] });
    const base = await git.writeCommit({ fs, dir, commit: { tree, parent: [], author, committer: author, message: 'base\n' } });
    const first = await git.writeCommit({ fs, dir, commit: { tree, parent: [base], author, committer: author, message: 'first\n' } });
    const second = await git.writeCommit({ fs, dir, commit: { tree, parent: [base], author, committer: author, message: 'second\n' } });
    const ref = 'refs/gitspace/spaces/workspace/checkpoints';
    await git.writeRef({ fs, dir, ref, value: base });
    const { packfile } = await git.packObjects({ fs, dir, oids: [second] });
    if (!packfile) throw new Error('Missing test pack');
    const request: ArtifactsFetch = async (input, init) => {
      const advertise = String(input).includes('/info/refs');
      if (!advertise) await git.writeRef({ fs, dir, ref, value: first, force: true });
      const process = Bun.spawn(['git', 'receive-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), dir], { stdin: advertise ? 'ignore' : new Response(init?.body).body, stdout: 'pipe', stderr: 'pipe' });
      const bytes = new Uint8Array(await new Response(process.stdout).arrayBuffer());
      await new Response(process.stderr).text();
      await process.exited;
      return new Response(bytes);
    };
    await expect(publishSnapshotPack({ remote: 'https://fixture.invalid/repo.git', token: 'fixture', ref, previous: base, commit: second, pack: packfile }, request)).rejects.toThrow('Git push rejected');
    expect(await git.resolveRef({ fs, dir, ref })).toBe(first);
  } finally { await rm(dir, { force: true, recursive: true }); }
});
