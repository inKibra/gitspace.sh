import { describe, expect, it } from 'bun:test';
import { buildSessionUsageReport, childSessionFileFor, emptyTotals } from '../src/session-usage-report.js';

interface RawUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; reasoningTokens: number; cost: { total: number } }
function usage(input: number, output: number, cost: number, extra: Partial<RawUsage> = {}): RawUsage {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, reasoningTokens: 0, cost: { total: cost }, ...extra };
}

function assistant(provider: string, model: string, u: RawUsage, timestamp = '2026-01-01T00:00:00.000Z'): string {
  return JSON.stringify({ type: 'message', id: crypto.randomUUID(), parentId: null, timestamp, message: { role: 'assistant', provider, model, api: 'messages', usage: u, content: [] } });
}

const ROOT = '/sessions/root.jsonl';
const CHILD = childSessionFileFor(ROOT, 'spawn-1');

const rootTranscript = [
  'title slot                 ',
  assistant('anthropic', 'sonnet', usage(100, 20, 0.5)),
  JSON.stringify({ type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-01-01T00:01:00.000Z', model: 'openai/o4-mini', role: 'smol' }),
  assistant('openai', 'o4-mini', usage(50, 10, 0.1, { reasoningTokens: 7 }), '2026-01-01T00:02:00.000Z'),
  '{ not json',
  JSON.stringify({
    type: 'message', id: 't1', parentId: null, timestamp: '2026-01-01T00:03:00.000Z',
    message: {
      role: 'toolResult', toolName: 'task', content: [],
      details: {
        results: [
          // Child transcript exists → its own totals win over this parent row.
          { id: 'spawn-1', agent: 'scout', modelOverride: ['pi/smol'], resolvedModel: 'openai/o4-mini', requests: 1, usage: usage(1, 1, 0.01) },
          // Detached / no child transcript → counted from the parent row.
          { id: 'spawn-2', agent: 'reviewer', modelOverride: 'anthropic/opus', requests: 3, usage: usage(300, 30, 0.9) },
          { id: 'spawn-3', agent: 'task', requests: 1, usage: usage(10, 10, 0.05) },
        ],
      },
    },
  }),
].join('\n');

const childTranscript = [
  assistant('openai', 'o4-mini', usage(200, 40, 0.2)),
  assistant('openai', 'o4-mini', usage(200, 40, 0.2)),
].join('\n');

const files: Record<string, string> = { [ROOT]: rootTranscript, [CHILD]: childTranscript };
const reader = async (path: string): Promise<string | null> => files[path] ?? null;

describe('buildSessionUsageReport', () => {
  it('returns null for an unreadable root transcript', async () => {
    expect(await buildSessionUsageReport('missing', '/nowhere.jsonl', reader)).toBeNull();
  });

  it('attributes usage by model, role, and agent with deep totals from child transcripts', async () => {
    const report = await buildSessionUsageReport('root', ROOT, reader);
    expect(report).not.toBeNull();
    const r = report!;
    expect(r.sessionId).toBe('root');

    expect(r.totals).toEqual({ ...emptyTotals(), requests: 2, input: 150, output: 30, totalTokens: 180, reasoningTokens: 7, costUsd: 0.6 });

    expect(r.byModel.map((row) => [row.provider, row.model, row.totals.requests, row.totals.costUsd])).toEqual([
      ['anthropic', 'sonnet', 1, 0.5],
      ['openai', 'o4-mini', 1, 0.1],
    ]);

    expect(r.byRole.map((row) => [row.role, row.models, row.totals.requests, row.totals.reasoningTokens])).toEqual([
      ['default', ['anthropic/sonnet'], 1, 0],
      ['smol', ['openai/o4-mini'], 1, 7],
    ]);

    expect(r.childSessions).toBe(1);
    // deep = own 0.6 + child transcript 0.4 (not the parent's 0.01 row) + spawn-2 0.9 + spawn-3 0.05
    expect(r.totalsDeep.costUsd).toBeCloseTo(1.95, 10);
    expect(r.totalsDeep.requests).toBe(2 + 2 + 3 + 1);
    expect(r.totalsDeep.input).toBe(150 + 400 + 300 + 10);

    expect(r.byAgent.map((row) => [row.agent, row.selection, row.model, row.spawns, row.totals.costUsd, row.firstAt])).toEqual([
      ['reviewer', 'pinned', 'anthropic/opus', 1, 0.9, '2026-01-01T00:03:00.000Z'],
      ['scout', 'role', 'openai/o4-mini', 1, 0.4, '2026-01-01T00:03:00.000Z'],
      ['task', 'inherited', 'inherited', 1, 0.05, '2026-01-01T00:03:00.000Z'],
    ]);
    expect(r.byAgent[1]!.totals.requests).toBe(2);

    expect(r.warnings).toEqual(['1 malformed transcript line(s) skipped']);
  });

  it('classifies an explicit modelRole as a role selection', async () => {
    const line = JSON.stringify({ type: 'message', id: 't', parentId: null, message: { role: 'toolResult', details: { results: [{ id: 's', agent: 'advisor', modelRole: 'slow', modelOverride: 'anthropic/opus', usage: usage(1, 1, 0.001) }] } } });
    const report = await buildSessionUsageReport('x', '/x.jsonl', async (path) => (path === '/x.jsonl' ? line : null));
    expect(report!.byAgent).toHaveLength(1);
    expect(report!.byAgent[0]!.selection).toBe('role');
    expect(report!.byAgent[0]!.firstAt).toBeNull();
    expect(report!.childSessions).toBe(0);
  });
});
