import { describe, expect, it } from 'bun:test';
import { BrowserOriginPatternSchema, EnvironmentBundleSchema, LifecycleMutationSchema, LifecycleStateSchema, approvedBrowserOrigins, approvedBrowserSites, browserOriginHash, browserOriginLevel, browserOriginMatches, emptyLifecycleState, executionHash, transitionLifecycle, type LifecycleMutation, type LifecycleState } from '../src/index.js';

const human = { actorId: 'owner-browser', machineId: 'browser', kind: 'browser' as const, lifecycleControl: true };
const apply = (state: LifecycleState, input: LifecycleMutation, actor = human) => transitionLifecycle({ state, runs: [], actor, now: '2026-10-04T00:00:00.000Z' }, input).state;

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

  it('keeps each approved site at the level you set, the most restrictive any approval of it says', async () => {
    const bank = await browserOriginHash('bank.example'), docs = await browserOriginHash('docs.example');
    const state = emptyLifecycleState('project', 'workspace');
    state.browserOrigins = [{ pattern: 'bank.example', hash: bank }, { pattern: 'docs.example', hash: docs }];
    let approved = apply(apply(state, { op: 'approval', scope: 'project', executionHash: bank, approved: true, level: 'interact' }), { op: 'approval', scope: 'project', executionHash: docs, approved: true });
    expect(approvedBrowserSites(approved)).toEqual([{ pattern: 'bank.example', level: 'interact' }, { pattern: 'docs.example', level: 'full' }]);
    // A workspace approval at full does not lift the project's interact level; one at read lowers it.
    approved = apply(approved, { op: 'approval', scope: 'workspace', executionHash: bank, approved: true, level: 'full' });
    expect(browserOriginLevel(approved, bank)).toBe('interact');
    approved = apply(approved, { op: 'approval', scope: 'workspace', executionHash: bank, approved: true, level: 'read' });
    expect(browserOriginLevel(approved, bank)).toBe('read');
    approved = apply(apply(approved, { op: 'approval', scope: 'project', executionHash: bank, approved: true, level: 'full' }), { op: 'approval', scope: 'workspace', executionHash: bank, approved: true, level: 'full' });
    expect(browserOriginLevel(approved, bank)).toBe('full');
    approved = apply(approved, { op: 'approval', scope: 'project', executionHash: docs, approved: false });
    expect(approvedBrowserSites(approved)).toEqual([{ pattern: 'bank.example', level: 'full' }]);
  });

  it('reads approvals stored as steps as interact and as scripts as full, and stored without a level as full', async () => {
    const bank = await browserOriginHash('bank.example'), docs = await browserOriginHash('docs.example'), wiki = await browserOriginHash('wiki.example');
    const stored = LifecycleStateSchema.parse({ ...emptyLifecycleState('project', 'workspace'),
      browserOrigins: [{ pattern: 'bank.example', hash: bank }, { pattern: 'docs.example', hash: docs }, { pattern: 'wiki.example', hash: wiki }],
      approvals: [
        { scope: 'project', executionHash: bank, approvedBy: 'owner', approvedAt: '2026-10-01T00:00:00.000Z', level: 'steps' },
        { scope: 'project', executionHash: docs, approvedBy: 'owner', approvedAt: '2026-10-01T00:00:00.000Z', level: 'scripts' },
        { scope: 'project', executionHash: wiki, approvedBy: 'owner', approvedAt: '2026-10-01T00:00:00.000Z' },
      ] });
    expect(approvedBrowserSites(stored)).toEqual([{ pattern: 'bank.example', level: 'interact' }, { pattern: 'docs.example', level: 'full' }, { pattern: 'wiki.example', level: 'full' }]);
    // A new approval says the new name.
    expect(apply(stored, { op: 'approval', scope: 'workspace', executionHash: docs, approved: true, level: 'read' }).approvals.at(-1)?.level).toBe('read');
    expect(LifecycleMutationSchema.safeParse({ op: 'approval', scope: 'workspace', executionHash: docs, approved: true, level: 'steps' }).success).toBe(false);
  });

  it('gives levels to browser sites only', async () => {
    const script = await executionHash({ kind: 'script', command: 'echo hi' });
    const state = emptyLifecycleState('project', 'workspace');
    state.executions = [{ id: 'hello', label: 'Hello', kind: 'script', phase: 'workspace/materialize', command: 'echo hi', fileName: null, content: 'echo hi', hash: script }];
    expect(() => apply(state, { op: 'approval', scope: 'workspace', executionHash: script, approved: true, level: 'interact' })).toThrow('Only an approved browser site has a level');
    expect(apply(state, { op: 'approval', scope: 'workspace', executionHash: script, approved: true }).approvals.map(entry => entry.level)).toEqual([undefined]);
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
