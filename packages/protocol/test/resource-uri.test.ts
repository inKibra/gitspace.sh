import { describe, expect, it } from 'bun:test';
import { canonicalLocalResourceUrl, parseResourceUri, resourceLinkHref, resourceUriFromHref, selectResourceText } from '../src/resource-uri.js';

describe('OMP resource URIs', () => {
  it('preserves unqualified filename case and distinguishes artifact IDs from mounted files', () => {
    const local = parseResourceUri('local://Review%20Notes/PLAN.md');
    expect(local).toMatchObject({ kind: 'local', mount: null, path: 'Review Notes/PLAN.md' });
    if (local?.kind !== 'local') throw new Error('Expected local resource');
    expect(canonicalLocalResourceUrl(local, 'workspace')).toBe('local://workspace/Review%20Notes/PLAN.md');
    expect(canonicalLocalResourceUrl(local, 'base')).toBe('local://base/Review%20Notes/PLAN.md');
    expect(parseResourceUri('local://workspaces/work-a/evidence.txt')).toMatchObject({ mount: 'workspaces', workspaceId: 'work-a', path: 'evidence.txt' });
    expect(parseResourceUri('artifact://12')).toMatchObject({ kind: 'artifact', id: '12' });
    expect(parseResourceUri('artifact://report.txt')).toBeNull();
  });

  it('rejects traversal before URL normalization and refuses executable or ambiguous URI forms', () => {
    for (const uri of [
      'javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'https://example.com', 'agent://12',
      'local://workspace/../base/secret', 'local://workspace/%2e%2e/secret', 'local://workspace/%2Fetc/passwd',
      'local://workspace/a%5c..%5csecret', 'local://workspace/a%00.txt', 'local://workspace/a?scope=base',
      'local://workspace/a#other', 'local://workspace//a', 'artifact://12/../13', 'artifact://12@other',
      'local://workspace/%FF', 'artifact://12:9-2',
    ]) expect(parseResourceUri(uri)).toBeNull();
  });

  it('round-trips safe navigation and applies OMP raw and multi-range selectors', () => {
    const uri = 'artifact://12:raw:2-3,5+1';
    expect(resourceUriFromHref(resourceLinkHref(uri)!)).toBe(uri);
    expect(resourceUriFromHref('#gitspace-resource=javascript%3Aalert(1)')).toBeNull();
    const resource = parseResourceUri(uri)!;
    expect(resource.url).toBe('artifact://12');
    expect(selectResourceText('a\nb\nc\nd\ne\nf', resource.selector)).toBe('b\nc\ne');
    expect(selectResourceText('a\nb\nc', parseResourceUri('local://workspace/a.txt:-2')!.selector)).toBe('b\nc');
    expect(parseResourceUri('local://workspace/name%3Araw.txt')).toMatchObject({ path: 'name:raw.txt', selector: { raw: false, ranges: [] } });
  });
});
