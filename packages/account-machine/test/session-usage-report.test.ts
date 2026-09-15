import { describe, expect, it } from 'bun:test';
import { dirname } from 'node:path';
import { buildSessionUsageReport, childSessionFileFor, emptyTotals } from '../src/session-usage-report.js';

const ROOT = '/sessions/root.jsonl';
const AT = '2026-01-01T00:00:00.000Z';
type Entry = Record<string, unknown>;

function usage(input: number, cost = input): Entry {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, reasoningTokens: 0, cost: { total: cost } };
}

function assistant(id: string, provider: string, model: string, input: number, extra: Entry = {}): Entry {
  return { type: 'message', id, timestamp: AT, message: { role: 'assistant', provider, model, usage: usage(input), content: [], ...extra } };
}

function task(id: string, progress: Entry[] = [], results: Entry[] = []): Entry {
  return { type: 'message', id, timestamp: AT, message: { role: 'toolResult', toolName: 'task', details: { results, progress } } };
}

function custom(id: string, customType: string, data: Entry): Entry {
  return { type: 'custom', id, timestamp: AT, customType, data: { version: 1, ...data } };
}

function definition(id: string, revision: string, role: string | null = 'slow'): Entry {
  return custom(id, 'gitspace-agent-definition', { name: 'reviewer', source: 'project', path: '/workspace/.omp/agents/reviewer.md', revision, role, selection: role ? 'role' : 'pinned' });
}

function completion(entryId: string, requestId: string, role: string | null, input: number, extra: Entry = {}): Entry {
  return custom(entryId, 'gitspace-model-usage', { id: requestId, kind: 'completion', role, selection: role ? 'role' : 'inherited', provider: 'openai', model: 'mini', usage: usage(input), ...extra });
}

function transcript(id: string, ...entries: (Entry | string)[]): string {
  return ['Mutable session title', JSON.stringify({ type: 'session', id, timestamp: AT }), ...entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry))].join('\n');
}

function source(files: Record<string, string>) {
  return {
    read: async (path: string): Promise<string | null> => files[path] ?? null,
    list: async (directory: string): Promise<string[]> => Object.keys(files).filter((file) => dirname(file) === directory && file.endsWith('.jsonl')),
  };
}

async function reportFor(files: Record<string, string>) {
  const io = source(files);
  return (await buildSessionUsageReport('root', ROOT, io.read, io.list))!;
}

function sum(rows: readonly { totals: { input: number } }[]): number {
  return rows.reduce((total, row) => total + row.totals.input, 0);
}

describe('buildSessionUsageReport', () => {
  it('distinguishes a missing root from a failed root read', async () => {
    expect(await buildSessionUsageReport('root', ROOT, async () => null)).toBeNull();
    const failure = new Error('permission denied');
    await expect(buildSessionUsageReport('root', ROOT, async () => { throw failure; })).rejects.toBe(failure);
  });

  it('recovers current async progress-only children and reconciles an unmatched zero-usage file', async () => {
    // Historical Recordless shape: 151 progress IDs, 152 files, 149 files with usage.
    const progress = Array.from({ length: 151 }, (_, index) => ({ index, id: `Worker${index}`, agent: 'scout', agentSource: 'bundled', modelRole: 'smol', status: 'pending', requests: 0, tokens: 0, cost: 0 }));
    const files: Record<string, string> = { [ROOT]: transcript('root', assistant('root-response', 'anthropic', 'main', 10), task('spawn', progress)) };
    for (const [index, child] of progress.entries()) {
      files[childSessionFileFor(ROOT, child.id)] = transcript(child.id,
        { type: 'model_change', id: 'initial-model', model: 'openai/mini' },
        ...(index < 149 ? [assistant('response', 'openai', 'mini', 1)] : []));
    }
    files[childSessionFileFor(ROOT, 'Orphan')] = transcript('orphan');
    const report = await reportFor(files);
    expect(report.childSessions).toBe(152);
    expect(report.totals.input).toBe(10);
    expect(report.totalsDeep.input).toBe(159);
    expect(report.totalsDeep.requests).toBe(150);
    expect(report.byRole.find((row) => row.role === 'smol')?.totals.requests).toBe(149);
    expect(report.byRole.find((row) => row.role === null)?.totals.input).toBe(10);
    expect(report.byRole.some((row) => row.role === 'default')).toBe(false);
    expect(report.byAgent.find((row) => row.agent === 'scout' && row.model === 'mini')).toMatchObject({ role: 'smol', provider: 'openai', definitionSource: 'bundled', definitionPath: null, definitionRevision: null, spawns: 149 });
    expect(report.byAgent.find((row) => row.agent === 'scout' && row.model === 'unknown')).toMatchObject({ spawns: 2, totals: emptyTotals() });
    expect(report.byAgent.find((row) => row.agent === 'unknown')).toMatchObject({ spawns: 1, role: null, selection: 'unknown', totals: emptyTotals() });
    expect(sum(report.byModel)).toBe(report.totalsDeep.input);
    expect(sum(report.byRole)).toBe(report.totalsDeep.input);
  });

  it('groups exact definition revisions, historical roles and actual response models rather than final spawn models', async () => {
    const a = childSessionFileFor(ROOT, 'a');
    const b = childSessionFileFor(ROOT, 'b');
    const report = await reportFor({
      [ROOT]: transcript('root', custom('root-role', 'gitspace-model-selection', { role: 'root-role', selection: 'role' }), assistant('r', 'anthropic', 'main', 10), task('spawn', [{ id: 'a', agent: 'wrong-current-name', modelRole: 'smol' }, { id: 'b', agent: 'reviewer' }], [{ id: 'a', resolvedModel: 'wrong/final', requests: 99, usage: usage(999) }])),
      [a]: transcript('a', definition('definition1', 'rev1'), assistant('a1', 'openai', 'actual-a', 1),
        { type: 'model_change', id: 'fallback', model: 'anthropic/actual-b', resolvedModelIsFallback: true }, assistant('a2', 'anthropic', 'actual-b', 2),
        custom('smol', 'gitspace-model-selection', { role: 'smol', selection: 'role' }),
        { type: 'model_change', id: 'mid-flight-controls', model: 'openai/actual-a', role: 'slow' }, assistant('a3', 'openai', 'actual-a', 3),
        definition('definition2', 'rev2'), assistant('a4', 'openai', 'actual-a', 4),
        custom('pin', 'gitspace-model-selection', { role: null, selection: 'pinned' }), assistant('a5', 'openai', 'actual-a', 5)),
      [b]: transcript('b', definition('definition', 'rev1'), assistant('b1', 'openai', 'actual-a', 6)),
    });
    expect(report.totalsDeep.input).toBe(31);
    expect(report.byAgent).toHaveLength(5);
    expect(report.byAgent.find((row) => row.definitionRevision === 'rev1' && row.role === 'slow' && row.model === 'actual-a')).toMatchObject({ agent: 'reviewer', provider: 'openai', spawns: 2, totals: { input: 7 }, firstAt: AT, lastAt: AT });
    expect(report.byAgent.find((row) => row.model === 'actual-b')).toMatchObject({ role: 'slow', provider: 'anthropic', totals: { input: 2 } });
    expect(report.byAgent.find((row) => row.definitionRevision === 'rev2' && row.role === null)).toMatchObject({ selection: 'pinned', totals: { input: 5 } });
    expect(report.byAgent.some((row) => row.model === 'wrong/final')).toBe(false);
    expect(report.byRole.find((row) => row.role === 'slow')).toMatchObject({ models: ['anthropic/actual-b', 'openai/actual-a'], totals: { input: 13 } });
    expect(sum(report.byAgent)).toBe(21);
    expect(sum(report.byModel)).toBe(31);
    expect(sum(report.byRole)).toBe(31);
  });

  it('includes direct calls once in their calling node and separately summarizes their actual serving models', async () => {
    const report = await reportFor({
      [ROOT]: transcript('root', custom('role', 'gitspace-model-selection', { role: 'default', selection: 'role' }), assistant('r', 'anthropic', 'main', 2), completion('direct', 'root-call', 'smol', 1), task('spawn', [{ id: 'child', agent: 'reviewer', modelRole: 'slow' }])),
      [childSessionFileFor(ROOT, 'child')]: transcript('child', definition('definition', 'rev1', 'smol'), assistant('c', 'openai', 'mini', 3), completion('child-direct', 'child-call', 'smol', 4), completion('inherited', 'inherited-call', null, 5, { provider: 'fallback-provider', model: 'served-model', usage: { ...usage(5, 0), output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 14, reasoningTokens: 1 } })),
    });
    expect(report.totals).toMatchObject({ requests: 2, input: 3 });
    expect(report.totalsDeep).toEqual({ requests: 5, input: 15, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 24, reasoningTokens: 1, costUsd: 10 });
    expect(report.childSessions).toBe(1);
    expect(report.byCompletion).toHaveLength(2);
    expect(report.byCompletion.find((row) => row.role === 'smol')).toMatchObject({ kind: 'completion', provider: 'openai', model: 'mini', totals: { requests: 2, input: 5 } });
    expect(report.byCompletion.find((row) => row.role === null)).toMatchObject({ provider: 'fallback-provider', model: 'served-model', totals: { input: 5 } });
    expect(sum(report.byAgent)).toBe(12);
    expect(report.byAgent.every((row) => row.agent === 'reviewer' && row.spawns === 1)).toBe(true);
    expect(report.byAgent.find((row) => row.role === 'smol')).toMatchObject({ spawns: 1, totals: { requests: 2, input: 7 } });
    expect(report.byRole.find((row) => row.role === 'default')?.totals.input).toBe(2);
    expect(sum(report.byRole)).toBe(15);
    expect(sum(report.byModel)).toBe(15);
  });

  it('does not turn a direct-only root into a child agent', async () => {
    const report = await reportFor({ [ROOT]: transcript('root', completion('direct', 'call', null, 7, { usage: { input: 7, totalTokens: 7 } })) });
    expect(report.totalsDeep).toEqual(report.totals);
    expect(report.totals.requests).toBe(1);
    expect(report.byAgent).toEqual([]);
    expect(report.childSessions).toBe(0);
    expect(report.byCompletion[0]).toMatchObject({ role: null, totals: { input: 7 } });
  });

  it('deduplicates repeated task delivery, session-file aliases, assistant responses, and direct request records', async () => {
    const child = childSessionFileFor(ROOT, 'child');
    const spawn = task('spawn', [{ id: 'child', agent: 'reviewer', modelRole: 'slow' }]);
    const response = assistant('assistant', 'openai', 'mini', 2, { responseId: 'provider-response' });
    const childText = transcript('child-session', response, response,
      assistant('redelivery', 'openai', 'mini', 2, { responseId: 'provider-response' }),
      completion('completion1', 'same-direct-call', 'smol', 3), completion('completion2', 'same-direct-call', 'smol', 3));
    const files = {
      [ROOT]: transcript('root', spawn, spawn, task('final', [], [{ id: 'child', requests: 100, usage: usage(999), resolvedModel: 'wrong/summary' }])),
      [child]: childText,
      [childSessionFileFor(ROOT, 'alias')]: childText,
    };
    const io = source(files);
    const report = (await buildSessionUsageReport('root', ROOT, io.read, async (directory) => [...await io.list(directory), ...(directory === '/sessions/root' ? [child, '/sessions/root/./child.jsonl'] : [])]))!;
    expect(report.childSessions).toBe(1);
    expect(report.totalsDeep).toMatchObject({ requests: 2, input: 5 });
    expect(report.byCompletion[0]?.totals.requests).toBe(1);
    expect(sum(report.byAgent)).toBe(5);
    expect(report.byAgent.every((row) => row.spawns === 1)).toBe(true);
  });

  it('recurses nested artifact directories without conflating equal child names from different parents', async () => {
    const a = childSessionFileFor(ROOT, 'a');
    const b = childSessionFileFor(ROOT, 'b');
    const report = await reportFor({
      [ROOT]: transcript('root', assistant('r', 'openai', 'mini', 1), task('root-task', [{ id: 'a', agent: 'task' }, { id: 'b', agent: 'task' }])),
      [a]: transcript('a', assistant('a', 'openai', 'mini', 2), task('nested-a', [{ id: 'leaf', agent: 'scout', modelRole: 'smol' }])),
      [b]: transcript('b', assistant('b', 'openai', 'mini', 3)),
      [childSessionFileFor(a, 'leaf')]: transcript('leaf-a', assistant('leaf', 'anthropic', 'other', 4)),
      [childSessionFileFor(b, 'leaf')]: transcript('leaf-b', completion('direct', 'nested-direct', null, 5)),
    });
    expect(report.childSessions).toBe(4);
    expect(report.totals.input).toBe(1);
    expect(report.totalsDeep.input).toBe(15);
    expect(sum(report.byAgent)).toBe(14);
    expect(sum(report.byModel)).toBe(15);
    expect(report.byRole.find((row) => row.role === 'smol')?.totals.input).toBe(4);
    expect(report.byCompletion[0]?.totals.input).toBe(5);
  });

  it('uses summaries only for unavailable transcripts and distinguishes zero usage from incomplete coverage', async () => {
    const unreadable = childSessionFileFor(ROOT, 'unreadable');
    const files = {
      [ROOT]: transcript('root', task('results', [], [
        { id: 'missing', agent: 'reviewer', modelRole: 'slow', resolvedModel: 'openai/final', requests: 2, usage: usage(7) },
        { id: 'zero', agent: 'reviewer', requests: 20, usage: usage(100) },
        { id: 'malformed', agent: 'reviewer', requests: 20, usage: usage(100) },
        { id: 'unreadable', agent: 'reviewer', requests: 1, usage: usage(2) },
        { id: 'no-evidence', agent: 'task' },
      ]), assistant('missing-usage', 'openai', 'mini', 100, { usage: null }), custom('bad-direct', 'gitspace-model-usage', { version: 99, id: 'bad', kind: 'completion', usage: usage(100) })),
      [childSessionFileFor(ROOT, 'zero')]: transcript('zero'),
      [childSessionFileFor(ROOT, 'malformed')]: transcript('malformed', '{ broken', 'null', JSON.stringify({ type: 'message', message: { role: 'assistant', usage: 'invalid' } })),
    };
    const io = source(files);
    const report = (await buildSessionUsageReport('root', ROOT, async (file) => { if (file === unreadable) throw new Error('EACCES'); return io.read(file); }, async (directory) => [...await io.list(directory), ...(directory === '/sessions/root' ? [unreadable] : [])]))!;
    expect(report.childSessions).toBe(3);
    expect(report.totals.requests).toBe(0);
    expect(report.totalsDeep).toMatchObject({ requests: 3, input: 9 });
    expect(sum(report.byAgent)).toBe(9);
    expect(report.byModel).toEqual([{ provider: 'unknown', model: 'unknown', totals: { ...emptyTotals(), requests: 3, input: 9, totalTokens: 9, costUsd: 9 } }]);
    expect(report.byCompletion).toEqual([]);
  });

  it('keeps initial legacy progress roles but does not invent roles after unrecorded model changes', async () => {
    const report = await reportFor({
      [ROOT]: transcript('root', task('spawn', [{ id: 'child', agent: 'reviewer', modelRole: 'smol' }])),
      [childSessionFileFor(ROOT, 'child')]: transcript('child',
        { type: 'model_change', id: 'initial', model: 'openai/mini' }, assistant('a', 'openai', 'mini', 1),
        { type: 'model_change', id: 'explicit', model: 'openai/mini', role: 'slow' }, assistant('b', 'openai', 'mini', 2),
        { type: 'model_change', id: 'unknown', model: 'openai/mini' }, assistant('c', 'openai', 'mini', 3)),
    });
    expect(report.byRole.map((row) => [row.role, row.totals.input])).toEqual([[null, 3], ['slow', 2], ['smol', 1]]);
    expect(report.byAgent).toHaveLength(3);
  });

  it('preserves initialized roles through native fallback and treats temporary selections as pins', async () => {
    const report = await reportFor({
      [ROOT]: transcript('root', task('spawn', [{ id: 'child', agent: 'reviewer' }])),
      [childSessionFileFor(ROOT, 'child')]: transcript('child',
        { type: 'session_init', id: 'init', modelRole: 'custom-role' },
        assistant('a', 'openai', 'primary', 1),
        { type: 'model_change', id: 'fallback', model: 'openai/other', role: 'fallback', resolvedModelIsFallback: true },
        assistant('b', 'openai', 'other', 2),
        { type: 'model_change', id: 'temporary', model: 'openai/other', role: 'temporary' },
        assistant('c', 'openai', 'other', 3)),
    });
    expect(report.byRole.map((row) => [row.role, row.totals.input])).toEqual([['custom-role', 3], [null, 3]]);
    expect(report.byAgent.find((row) => row.role === null)).toMatchObject({ selection: 'pinned', totals: { input: 3 } });
  });

  it('rejects traversal IDs and non-immediate listings instead of reading outside the artifact directory', async () => {
    const safe = childSessionFileFor(ROOT, 'safe');
    const io = source({ [ROOT]: transcript('root', task('spawn', ['../escape', '/absolute', 'a/b', 'a\\b', '%2e%2e', 'x'.repeat(250), 'safe'].map((id) => ({ id, agent: 'task' })))), [safe]: transcript('safe', assistant('a', 'openai', 'mini', 1)) });
    const allowed = new Set([ROOT, safe]);
    const reads: string[] = [];
    const report = (await buildSessionUsageReport('root', ROOT, async (file) => { reads.push(file); return allowed.has(file) ? io.read(file) : transcript('escaped', assistant('leaked', 'openai', 'mini', 1000)); }, async (directory) => directory === '/sessions/root' ? [safe, '/sessions/escape.jsonl', '/sessions/root/nested/hidden.jsonl', '/sessions/rootish/sibling.jsonl', '/sessions/root/../escape.jsonl', 'relative.jsonl', '/sessions/root/safe.txt', '/sessions/root/bad\\name.jsonl'] : []))!;
    expect(report.totalsDeep.input).toBe(1);
    expect(report.childSessions).toBe(1);
    expect(reads.every((file) => allowed.has(file))).toBe(true);
  });

  it('bounds recursive depth and reports omitted deeper usage', async () => {
    const files: Record<string, string> = {};
    let file = ROOT;
    for (let depth = 0; depth <= 9; depth += 1) {
      files[file] = transcript(`session-${depth}`, assistant(`response-${depth}`, 'openai', 'mini', depth === 9 ? 1000 : 1), ...(depth < 9 ? [task(`spawn-${depth}`, [{ id: 'child', agent: 'task' }])] : []));
      file = childSessionFileFor(file, 'child');
    }
    const report = await reportFor(files);
    expect(report.childSessions).toBe(8);
    expect(report.totalsDeep.input).toBe(9);
  });

  it('retains referenced-child coverage without a lister and warns when directory reconciliation fails', async () => {
    const io = source({ [ROOT]: transcript('root', task('spawn', [{ id: 'child', agent: 'task' }])), [childSessionFileFor(ROOT, 'child')]: transcript('child', assistant('a', 'openai', 'mini', 2)) });
    const withoutLister = (await buildSessionUsageReport('root', ROOT, io.read))!;
    expect(withoutLister.totalsDeep.input).toBe(2);
    expect(withoutLister.childSessions).toBe(1);
    const failedListing = (await buildSessionUsageReport('root', ROOT, io.read, async () => { throw new Error('EACCES'); }))!;
    expect(failedListing.totalsDeep.input).toBe(2);
  });
});
