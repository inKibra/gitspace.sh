import { describe, expect, it } from 'bun:test';
import { BrowserOriginPatternSchema, EnvironmentBundleSchema, approvedBrowserOrigins, browserOriginHash, browserOriginMatches, emptyLifecycleState, executionHash, transitionLifecycle, type LifecycleMutation, type LifecycleState } from '../src/index.js';

const human = { actorId: 'owner-browser', machineId: 'browser', kind: 'browser' as const, lifecycleControl: true };
const apply = (state: LifecycleState, input: LifecycleMutation, actor = human) => transitionLifecycle({ state, runs: [], actor, now: '2026-10-04T00:00:00.000Z', token: '' }, input).state;

describe('browser origin permissions', () => {
  it('rejects URL, path, port, wildcard and hostname boundary tricks', () => {
    for (const pattern of ['https://example.com', 'example.com/path', 'example.com:443', 'example.com@evil.com', '*example.com', 'example.*', '*.*', '*.example.com.evil/', 'example.com.', 'Example.com', '-example.com', 'example..com', 'example_com', '[::1]', ' example.com', 'example.com%2fevil']) expect(BrowserOriginPatternSchema.safeParse(pattern).success).toBe(false);
    for (const pattern of ['example.com', '*.example.com', '*', 'localhost', '127.0.0.1']) expect(BrowserOriginPatternSchema.safeParse(pattern).success).toBe(true);
    expect(browserOriginMatches('*.example.com', 'api.example.com')).toBe(true);
    expect(browserOriginMatches('*.example.com', 'deep.api.example.com')).toBe(true);
    expect(browserOriginMatches('*.example.com', 'example.com')).toBe(false);
    expect(browserOriginMatches('*.example.com', 'badexample.com')).toBe(false);
    expect(browserOriginMatches('*.example.com', 'example.com.evil.com')).toBe(false);
    expect(browserOriginMatches('example.com', 'EXAMPLE.COM')).toBe(true);
    expect(browserOriginMatches('example.com', 'api.example.com')).toBe(false);
    for (const host of ['https://example.com', 'example.com/path', 'example.com:443', 'example.com@evil.com', '']) expect(browserOriginMatches('*', host)).toBe(false);
  });

  it('hashes each entry independently and separates origins from executable content', async () => {
    const first = await browserOriginHash('example.com');
    expect(first).not.toBe(await browserOriginHash('*.example.com'));
    expect(first).not.toBe(await executionHash({ kind: 'check', command: 'example.com' }));
    expect(first).not.toBe(await executionHash({ kind: 'script', command: 'example.com' }));
    const state = emptyLifecycleState('project', 'workspace');
    state.browserOrigins = [{ pattern: 'example.com', hash: first }, { pattern: 'other.com', hash: await browserOriginHash('other.com') }];
    const approved = apply(state, { op: 'approval', scope: 'workspace', executionHash: first, approved: true });
    expect(approvedBrowserOrigins(approved)).toEqual(['example.com']);
    approved.browserOrigins = approved.browserOrigins.filter(origin => origin.pattern !== 'example.com');
    expect(approvedBrowserOrigins(approved)).toEqual([]);
    expect(approved.executions).toEqual([]);
  });

  it('does not approve arbitrary bundle previews, yolo, or non-human mutations', async () => {
    const hash = await browserOriginHash('example.com');
    const state = apply(emptyLifecycleState('project', 'workspace'), { op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {} }, browser: { origins: ['example.com'] } }) });
    expect(() => apply(state, { op: 'approval', scope: 'workspace', executionHash: hash, approved: true })).toThrow();
    state.browserOrigins = [{ pattern: 'example.com', hash }];
    expect(() => apply(state, { op: 'approval', scope: 'workspace', executionHash: hash, approved: true }, { ...human, lifecycleControl: false })).toThrow();
    expect(approvedBrowserOrigins(apply(state, { op: 'policy', automatic: true }))).toEqual([]);
    expect(EnvironmentBundleSchema.parse({ version: 1, profiles: { base: {} } }).browser.origins).toEqual([]);
  });
});
