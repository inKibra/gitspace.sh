import { describe, expect, it } from 'bun:test';
import { canonicalDriveResourceUrl, parseResourceUri, resourceLinkHref, resourceUriFromHref, selectResourceText } from '../src/resource-uri.js';

describe('OMP resource URIs', () => {
  it('preserves unqualified filename case and distinguishes artifact IDs from mounted files', () => {
    const local = parseResourceUri('drive://Review%20Notes/PLAN.md');
    expect(local).toMatchObject({ kind: 'drive', mount: null, path: 'Review Notes/PLAN.md' });
    if (local?.kind !== 'drive') throw new Error('Expected local resource');
    expect(canonicalDriveResourceUrl(local, 'workspace')).toBe('drive://workspace/Review%20Notes/PLAN.md');
    expect(canonicalDriveResourceUrl(local, 'base')).toBe('drive://base/Review%20Notes/PLAN.md');
    expect(parseResourceUri('drive://workspaces/work-a/evidence.txt')).toMatchObject({ mount: 'workspaces', workspaceId: 'work-a', path: 'evidence.txt' });
    expect(parseResourceUri('artifact://12')).toMatchObject({ kind: 'artifact', id: '12' });
    expect(parseResourceUri('artifact://report.txt')).toBeNull();
  });

  it('names a repository file as it is now or pinned to a full commit hash, never escaping the repository', () => {
    const commit = 'a'.repeat(40);
    expect(parseResourceUri('repo://docs/screens/home%20page.png')).toMatchObject({ kind: 'repo', path: 'docs/screens/home page.png', commit: null, url: 'repo://docs/screens/home%20page.png' });
    expect(parseResourceUri(`repo://docs/home.png@${commit}`)).toMatchObject({ kind: 'repo', path: 'docs/home.png', commit, url: `repo://docs/home.png@${commit}` });
    // Only a full hash pins; anything else after `@` is part of the name.
    expect(parseResourceUri('repo://docs/home.png@abc123')).toMatchObject({ kind: 'repo', path: 'docs/home.png@abc123', commit: null });
    for (const uri of ['repo://../secret', `repo://docs/%2e%2e/secret@${commit}`, 'repo://docs//home.png', 'repo://']) expect(parseResourceUri(uri)).toBeNull();
  });

  it('rejects traversal before URL normalization and refuses executable or ambiguous URI forms', () => {
    for (const uri of [
      'javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'https://example.com', 'agent://12',
      'drive://workspace/../base/secret', 'drive://workspace/%2e%2e/secret', 'drive://workspace/%2Fetc/passwd',
      'drive://workspace/a%5c..%5csecret', 'drive://workspace/a%00.txt', 'drive://workspace/a?scope=base',
      'drive://workspace/a#other', 'drive://workspace//a', 'artifact://12/../13', 'artifact://12@other',
      'drive://workspace/%FF', 'artifact://12:9-2',
      'browser-artifact://machine/../secret', 'browser-artifact://machine/%2Fsecret', 'browser-artifact://machine/..', 'browser-artifact://machine/artifact?workspace=other',
    ]) expect(parseResourceUri(uri)).toBeNull();
  });

  it('keeps expiring browser output machine-qualified through safe Inspector navigation', () => {
    const uri = 'browser-artifact://Machine-A/output-1:2-3';
    expect(resourceUriFromHref(resourceLinkHref(uri)!)).toBe(uri);
    expect(parseResourceUri(uri)).toMatchObject({ kind: 'browser-artifact', machineId: 'Machine-A', id: 'output-1', selector: { ranges: [{ start: 2, end: 3 }] } });
  });

  it('round-trips safe navigation and applies OMP raw and multi-range selectors', () => {
    const uri = 'artifact://12:raw:2-3,5+1';
    expect(resourceUriFromHref(resourceLinkHref(uri)!)).toBe(uri);
    expect(resourceUriFromHref('#gitspace-resource=javascript%3Aalert(1)')).toBeNull();
    const resource = parseResourceUri(uri)!;
    expect(resource.url).toBe('artifact://12');
    expect(selectResourceText('a\nb\nc\nd\ne\nf', resource.selector)).toBe('b\nc\ne');
    expect(selectResourceText('a\nb\nc', parseResourceUri('drive://workspace/a.txt:-2')!.selector)).toBe('b\nc');
    expect(parseResourceUri('drive://workspace/name%3Araw.txt')).toMatchObject({ path: 'name:raw.txt', selector: { raw: false, ranges: [] } });
  });
});
