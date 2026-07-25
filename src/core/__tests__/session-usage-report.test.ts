import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSessionUsageReport, childSessionFileFor, rollupByPath } from '../session-usage-report.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gs-usage-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Assistant message entry with usage, matching the on-disk shape. */
const assistant = (provider: string, model: string, input: number, output: number, cost: number) =>
  JSON.stringify({
    type: 'message',
    id: `m${input}${output}`,
    parentId: null,
    message: {
      role: 'assistant',
      provider,
      model,
      api: 'openai-codex-responses',
      content: [],
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        reasoningTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    },
  });

const modelChange = (model: string, role?: string) =>
  JSON.stringify({ type: 'model_change', id: 'mc', parentId: null, model, ...(role ? { role } : {}) });

const taskResult = (results: unknown[], timestamp = '2026-07-04T09:00:00.000Z') =>
  JSON.stringify({
    type: 'message',
    id: 'tr',
    parentId: null,
    timestamp,
    message: { role: 'toolResult', toolName: 'task', details: { results } },
  });

const spawn = (o: Record<string, unknown>) => ({
  id: 'S1',
  agent: 'task',
  agentSource: 'bundled',
  requests: 1,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, reasoningTokens: 0, cost: { total: 0.5 } },
  ...o,
});

/** Write a transcript: line 1 is the non-JSON title slot, then entries. */
function writeSession(name: string, lines: string[]): string {
  const file = join(root, `${name}.jsonl`);
  writeFileSync(file, ['# title slot', ...lines].join('\n'), 'utf-8');
  return file;
}

describe('buildSessionUsageReport', () => {
  it('groups spend by provider/model and sums tokens + USD cost', async () => {
    const file = writeSession('s', [
      modelChange('openai-codex/gpt-5', 'default'),
      assistant('openai-codex', 'gpt-5', 100, 10, 0.25),
      assistant('openai-codex', 'gpt-5', 200, 20, 0.5),
      assistant('anthropic', 'claude-fable-5', 50, 5, 1.25),
    ]);
    const report = (await buildSessionUsageReport(file))!;
    expect(report.totals.requests).toBe(3);
    expect(report.totals.totalTokens).toBe(110 + 220 + 55);
    expect(report.totals.costUsd).toBeCloseTo(2.0, 6);
    // Sorted by cost desc: the fable model is the most expensive single row.
    expect(report.byProviderModel[0]).toMatchObject({ provider: 'anthropic', model: 'claude-fable-5', requests: 1 });
    expect(report.byProviderModel[1]).toMatchObject({ provider: 'openai-codex', model: 'gpt-5', requests: 2 });
    expect(report.byProviderModel[1]!.costUsd).toBeCloseTo(0.75, 6);
  });

  it('attributes spend to the role active when the request ran', async () => {
    const file = writeSession('s', [
      modelChange('openai-codex/gpt-5', 'default'),
      assistant('openai-codex', 'gpt-5', 100, 10, 0.25),
      modelChange('anthropic/claude-fable-5', 'advisor'),
      assistant('anthropic', 'claude-fable-5', 100, 10, 3.0),
    ]);
    const byRole = Object.fromEntries((await buildSessionUsageReport(file))!.byRole.map((r) => [r.role, r]));
    expect(byRole.advisor!.costUsd).toBeCloseTo(3.0, 6);
    expect(byRole.default!.costUsd).toBeCloseTo(0.25, 6);
    expect(byRole.advisor!.models).toEqual(['anthropic/claude-fable-5']);
  });

  it('ignores role switches that never ran a request (role cycling)', async () => {
    // Cycling through roles writes model_change entries with no prompt between
    // them — "role selected" is not "role used", so only spend counts.
    const file = writeSession('s', [
      modelChange('openai-codex/gpt-5', 'default'),
      modelChange('openai-codex/gpt-5', 'smol'),
      modelChange('openai-codex/gpt-5', 'slow'),
      modelChange('openai-codex/gpt-5', 'default'),
      assistant('openai-codex', 'gpt-5', 100, 10, 0.25),
    ]);
    const report = (await buildSessionUsageReport(file))!;
    expect(report.byRole.map((r) => r.role)).toEqual(['default']);
  });

  it('classifies spawn model selection as role / pinned / inherited', async () => {
    const file = writeSession('s', [
      taskResult([
        spawn({ id: 'A', modelOverride: ['pi/advisor'], resolvedModel: 'anthropic/claude-fable-5' }),
        spawn({ id: 'B', modelOverride: ['openai-codex/gpt-5.5'], resolvedModel: 'openai-codex/gpt-5.5' }),
        spawn({ id: 'C', resolvedModel: 'openai-codex/gpt-5' }),
      ]),
    ]);
    const selections = Object.fromEntries((await buildSessionUsageReport(file))!.spawns.map((s) => [s.id, s.selection]));
    expect(selections).toEqual({ A: 'role', B: 'pinned', C: 'inherited' });
  });

  it('recurses into child transcripts and counts detached spawns from the child', async () => {
    // A detached spawn reports ZERO usage in the parent — its real cost only
    // lands in the child file. Trusting the parent row would undercount.
    const parent = writeSession('p', [
      assistant('openai-codex', 'gpt-5', 100, 10, 1.0),
      taskResult([
        spawn({
          id: 'child1',
          modelOverride: ['pi/advisor'],
          resolvedModel: 'anthropic/claude-fable-5',
          requests: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0, cost: { total: 0 } },
        }),
      ]),
    ]);
    mkdirSync(join(root, 'p'), { recursive: true });
    writeFileSync(
      childSessionFileFor(parent, 'child1'),
      ['# title', assistant('anthropic', 'claude-fable-5', 500, 50, 7.5)].join('\n'),
      'utf-8',
    );

    const report = (await buildSessionUsageReport(parent))!;
    expect(report.totals.costUsd).toBeCloseTo(1.0, 6); // this session only
    expect(report.children).toHaveLength(1);
    expect(report.totalsDeep.costUsd).toBeCloseTo(8.5, 6); // parent + child
    expect(report.spawns[0]!.childSessionFile).toBeTruthy();
  });

  it('rollupByPath surfaces the expensive path with a spawn count', async () => {
    const parent = writeSession('p', [
      taskResult([
        spawn({ id: 'a1', agent: 'advisor', modelOverride: ['pi/advisor'], resolvedModel: 'anthropic/claude-fable-5', usage: { totalTokens: 10, cost: { total: 2.0 } } }),
        spawn({ id: 'a2', agent: 'advisor', modelOverride: ['pi/advisor'], resolvedModel: 'anthropic/claude-fable-5', usage: { totalTokens: 10, cost: { total: 3.0 } } }),
        spawn({ id: 'b1', agent: 'reviewer', modelOverride: ['pi/smol'], resolvedModel: 'openai-codex/gpt-5', usage: { totalTokens: 10, cost: { total: 0.1 } } }),
      ]),
    ]);
    const rows = rollupByPath((await buildSessionUsageReport(parent))!);
    // The "why is my subscription draining" row: same agent+model, spawned twice.
    expect(rows[0]).toMatchObject({ agent: 'advisor', selection: 'role', model: 'anthropic/claude-fable-5', spawnCount: 2 });
    // Dated, so a lifetime row can't be mistaken for current activity.
    expect(rows[0]!.firstAt).toBe(Date.parse('2026-07-04T09:00:00.000Z'));
    expect(rows[0]!.lastAt).toBe(Date.parse('2026-07-04T09:00:00.000Z'));
    expect(rows[0]!.costUsd).toBeCloseTo(5.0, 6);
    expect(rows[1]).toMatchObject({ agent: 'reviewer', spawnCount: 1 });
  });

  it('splits spend by service tier — fast (priority) vs standard', async () => {
    const tierChange = (map: Record<string, string>) =>
      JSON.stringify({ type: 'service_tier_change', id: 'st', parentId: null, serviceTier: map });
    const file = writeSession('s', [
      tierChange({ openai: 'priority' }),
      assistant('openai-codex', 'gpt-5.5', 100, 10, 4.0),
      tierChange({ openai: 'standard' }),
      assistant('openai-codex', 'gpt-5.5', 100, 10, 1.0),
    ]);
    const byTier = Object.fromEntries((await buildSessionUsageReport(file))!.byServiceTier.map((t) => [t.tier, t]));
    expect(byTier.fast!.costUsd).toBeCloseTo(4.0, 6);
    expect(byTier.standard!.costUsd).toBeCloseTo(1.0, 6);
  });

  it('reports no tier rows when the session never set a service tier', async () => {
    const file = writeSession('s', [assistant('openai-codex', 'gpt-5', 10, 1, 0.1)]);
    expect((await buildSessionUsageReport(file))!.byServiceTier).toEqual([]);
  });

  it('segments the timeline by (role, model) era so mixed-era spend is datable', async () => {
    const at = (iso: string, entry: string) => {
      const e = JSON.parse(entry) as Record<string, unknown>;
      e.timestamp = iso;
      return JSON.stringify(e);
    };
    const file = writeSession('s', [
      modelChange('openai-codex/gpt-5.5', 'default'),
      at('2026-07-01T10:00:00.000Z', assistant('openai-codex', 'gpt-5.5', 100, 10, 1.0)),
      at('2026-07-01T10:05:00.000Z', assistant('openai-codex', 'gpt-5.5', 100, 10, 1.0)),
      // Same ROLE, different model later — the lifetime byRole row merges these,
      // which is exactly the confusion segments exist to resolve.
      modelChange('anthropic/claude-fable-5', 'default'),
      at('2026-07-01T11:00:00.000Z', assistant('anthropic', 'claude-fable-5', 100, 10, 5.0)),
    ]);
    const report = (await buildSessionUsageReport(file))!;
    expect(report.segments).toHaveLength(2);
    expect(report.segments[0]).toMatchObject({ role: 'default', model: 'gpt-5.5', requests: 2 });
    expect(report.segments[0]!.costUsd).toBeCloseTo(2.0, 6);
    expect(report.segments[1]).toMatchObject({ role: 'default', model: 'claude-fable-5', requests: 1 });
    expect(report.segments[1]!.costUsd).toBeCloseTo(5.0, 6);
    // The era is dated, and ordered.
    expect(report.segments[0]!.startedAt).toBe(Date.parse('2026-07-01T10:00:00.000Z'));
    expect(report.segments[0]!.endedAt).toBe(Date.parse('2026-07-01T10:05:00.000Z'));
    expect(report.segments[1]!.startedAt).toBeGreaterThan(report.segments[0]!.endedAt);
    // ...while the lifetime role rollup still merges both models into one row.
    expect(report.byRole).toHaveLength(1);
    expect(report.byRole[0]!.models).toHaveLength(2);
  });

  it('returns null for a missing transcript and tolerates malformed lines', async () => {
    expect(await buildSessionUsageReport(join(root, 'nope.jsonl'))).toBeNull();
    const file = writeSession('s', ['{ not json', assistant('openai-codex', 'gpt-5', 10, 1, 0.1)]);
    const report = (await buildSessionUsageReport(file))!;
    expect(report.totals.requests).toBe(1);
    expect(report.warnings.some((w) => w.includes('malformed'))).toBe(true);
  });
});
