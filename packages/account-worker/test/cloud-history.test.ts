import { describe, expect, it } from 'vitest';
import { compareCloudHistory } from '../src/cloud-stack-status.js';

function history(entries: { hash: string; parents: string[]; committedAt: number }[]) {
  const commits = new Map(entries.map(entry => [entry.hash, {
    ...entry, treeHash: 'f'.repeat(40), message: '',
    author: { name: 'Fixture', email: 'f@example.invalid' }, committer: { name: 'Fixture', email: 'f@example.invalid' }, authoredAt: entry.committedAt,
  } satisfies ArtifactsCommitMetadata]));
  return {
    async readCommit(_repository: string, hash: string) { return commits.get(hash) ?? null; },
    async log(_repository: string, hash: string, limit = 50) {
      if (!commits.has(hash)) throw new Error('Missing log root');
      const page: ArtifactsCommitMetadata[] = [];
      let next: string | undefined = hash;
      while (next && page.length < limit) {
        const commit = commits.get(next);
        if (!commit) break;
        page.push(commit);
        next = commit.parents[0];
      }
      return page;
    },
  };
}

const tip = (head: string) => ({ head, repositories: ['workspace'] });

describe('cloud history comparisons at shallow boundaries', () => {
  it('computes the exact position above a shared boundary without requiring its absent parent', async () => {
    const code = history([
      { hash: 'base', parents: ['absent'], committedAt: 1 },
      { hash: 'parent', parents: ['base'], committedAt: 2 },
      { hash: 'child', parents: ['base'], committedAt: 3 },
    ]);
    expect(await compareCloudHistory(code, tip('parent'), tip('child'))).toEqual({ complete: true, bases: ['base'], leftAhead: 1 });
    expect(await compareCloudHistory(code, tip('base'), tip('parent'))).toEqual({ complete: true, bases: ['base'], leftAhead: 0 });
  });

  it('does not turn a shared missing ancestor into a merge base or prove histories unrelated', async () => {
    const code = history([
      { hash: 'left', parents: ['absent'], committedAt: 2 },
      { hash: 'right', parents: ['absent'], committedAt: 3 },
    ]);
    expect(await compareCloudHistory(code, tip('left'), tip('right'))).toEqual({ complete: false, bases: [], leftAhead: null });
    await expect(compareCloudHistory(code, tip('absent'), tip('right'))).rejects.toThrow('missing');
  });

  it('searches merge parents rather than declaring first-parent histories unrelated', async () => {
    const code = history([
      { hash: 'base', parents: ['absent'], committedAt: 1 },
      { hash: 'other', parents: [], committedAt: 2 },
      { hash: 'topic', parents: ['base'], committedAt: 3 },
      { hash: 'merge', parents: ['other', 'topic'], committedAt: 4 },
    ]);
    const comparison = await compareCloudHistory(code, tip('topic'), tip('merge'));
    expect(comparison.bases).toEqual(['topic']);
    expect(comparison.leftAhead).toBe(0);
    expect(comparison.complete).toBe(true);
  });

  it('can prove separation only when both traversed histories are complete', async () => {
    const code = history([
      { hash: 'left', parents: [], committedAt: 1 },
      { hash: 'right', parents: [], committedAt: 2 },
    ]);
    expect(await compareCloudHistory(code, tip('left'), tip('right'))).toEqual({ complete: true, bases: [], leftAhead: 1 });
  });
});
