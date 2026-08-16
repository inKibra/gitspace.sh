/**
 * Issue-creation contract, verified WITHOUT publishing (injected gh exec).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { createIssue, resolveRepoSlug, fetchIssue, listIssues, type GhExec } from '../github-issues.js';

describe('createIssue', () => {
  test('builds repos/<slug>/issues POST with title/body/labels and returns number+url', async () => {
    let seen: { args: string[]; payload: unknown } | null = null;
    const exec: GhExec = async (args) => {
      // capture the payload file gh would read
      const inputIdx = args.indexOf('--input');
      const payload = inputIdx >= 0 ? JSON.parse(readFileSync(args[inputIdx + 1]!, 'utf8')) : null;
      seen = { args, payload };
      return { stdout: JSON.stringify({ number: 142, html_url: 'https://github.com/o/r/issues/142' }) };
    };

    const r = await createIssue(
      { slug: 'o/r', title: 'the pane went blank', body: 'redacted bundle here', labels: ['gitspace-report'] },
      exec,
    );

    expect(r).toEqual({ number: 142, url: 'https://github.com/o/r/issues/142' });
    expect(seen!.args.slice(0, 4)).toEqual(['api', 'repos/o/r/issues', '--method', 'POST']);
    expect(seen!.payload).toEqual({ title: 'the pane went blank', body: 'redacted bundle here', labels: ['gitspace-report'] });
  });

  test('rejects a malformed slug before any exec', async () => {
    let called = false;
    const exec: GhExec = async () => { called = true; return { stdout: '{}' }; };
    await expect(createIssue({ slug: 'not-a-slug', title: 't', body: 'b' }, exec)).rejects.toThrow('Invalid repo slug');
    expect(called).toBe(false);
  });

  test('omits labels when none given', async () => {
    let payload: unknown = null;
    const exec: GhExec = async (args) => {
      const i = args.indexOf('--input');
      payload = JSON.parse(readFileSync(args[i + 1]!, 'utf8'));
      return { stdout: JSON.stringify({ number: 1, html_url: 'https://github.com/o/r/issues/1' }) };
    };
    await createIssue({ slug: 'o/r', title: 't', body: 'b' }, exec);
    expect(payload).toEqual({ title: 't', body: 'b' });
  });
});

describe('fetchIssue / listIssues', () => {
  test('fetchIssue maps fields and rejects PRs', async () => {
    const exec: GhExec = async () => ({ stdout: JSON.stringify({ number: 101, title: 'Enter key semantics', body: 'the body', html_url: 'https://github.com/o/r/issues/101' }) });
    expect(await fetchIssue('o/r', 101, undefined, exec)).toEqual({ number: 101, title: 'Enter key semantics', body: 'the body', url: 'https://github.com/o/r/issues/101' });

    const prExec: GhExec = async () => ({ stdout: JSON.stringify({ number: 5, title: 'a PR', html_url: 'x', pull_request: { url: 'y' } }) });
    await expect(fetchIssue('o/r', 5, undefined, prExec)).rejects.toThrow('pull request');
  });

  test('listIssues drops PRs (issues endpoint includes them)', async () => {
    const exec: GhExec = async () => ({ stdout: JSON.stringify([
      { number: 3, title: 'real issue', html_url: 'https://github.com/o/r/issues/3' },
      { number: 4, title: 'a pr', html_url: 'https://github.com/o/r/pull/4', pull_request: { url: 'z' } },
    ]) });
    const list = await listIssues('o/r', {}, undefined, exec);
    expect(list.map((i) => i.number)).toEqual([3]);
  });
});

describe('resolveRepoSlug', () => {
  test('returns a valid slug', async () => {
    const exec: GhExec = async () => ({ stdout: 'inKibra/gitspace.sh\n' });
    expect(await resolveRepoSlug('/x', exec)).toBe('inKibra/gitspace.sh');
  });
  test('null on non-slug output', async () => {
    const exec: GhExec = async () => ({ stdout: 'garbage output' });
    expect(await resolveRepoSlug('/x', exec)).toBeNull();
  });
  test('null when gh throws (no repo / no auth)', async () => {
    const exec: GhExec = async () => { throw new Error('not a gh repo'); };
    expect(await resolveRepoSlug('/x', exec)).toBeNull();
  });
});
