/**
 * Issue-creation contract, verified WITHOUT publishing (injected gh exec).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { createIssue, resolveRepoSlug, type GhExec } from '../github-issues.js';

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
