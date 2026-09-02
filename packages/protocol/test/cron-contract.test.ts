import { describe, expect, it } from 'bun:test';
import {
  ProjectCronDraftCodec,
  ProjectCronRunViewCodec,
  nextProjectCronRunAt,
  parseProjectCronSchedule,
} from '../src/cron-contract.js';

describe('project cron schedule grammar', () => {
  it('preserves the every-N minute, hour, and day grammar', () => {
    expect(parseProjectCronSchedule('every 5m')).toBe(300_000);
    expect(parseProjectCronSchedule(' EVERY 2 hours ')).toBe(7_200_000);
    expect(parseProjectCronSchedule('every 1 day')).toBe(86_400_000);
    expect(parseProjectCronSchedule('Mon 09:00')).toBeNull();
    expect(parseProjectCronSchedule('every 0m')).toBeNull();
    expect(parseProjectCronSchedule('on push')).toBeNull();
  });

  it('advances from the prior due time without stacking missed intervals', () => {
    const due = Date.parse('2026-08-31T00:00:00.000Z');
    const now = Date.parse('2026-08-31T03:12:00.000Z');
    expect(nextProjectCronRunAt('every 1h', due, now)).toBe(Date.parse('2026-08-31T04:00:00.000Z'));
    expect(nextProjectCronRunAt('every 6h', Date.parse('2026-08-31T06:00:00.000Z'), now)).toBe(Date.parse('2026-08-31T06:00:00.000Z'));
  });
});

describe('project cron wire codecs', () => {
  it('accepts a stable workspace target with explicit read and write scopes', () => {
    const decoded = ProjectCronDraftCodec.decode({
      name: 'nightly-triage',
      schedule: 'every 1d',
      description: 'Triage failures.',
      prompt: 'Review all open failures.',
      target: { scope: 'workspace', projectId: 'project-a', spaceId: 'space-a' },
      readScopes: ['repository/**'],
      writeScopes: ['local://workspace/reports/**'],
      enabled: true,
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.target).toEqual({ scope: 'workspace', projectId: 'project-a', spaceId: 'space-a' });
  });

  it('rejects session-addressed and incomplete targets', () => {
    expect(ProjectCronDraftCodec.decode({
      name: 'bad-target',
      schedule: 'every 1h',
      description: '',
      prompt: 'Do work.',
      target: { scope: 'workspace', projectId: 'project-a', sessionId: 'session-a' },
      readScopes: [],
      writeScopes: [],
      enabled: true,
    }).ok).toBe(false);
  });

  it('round-trips run identity and repository generation through the run codec', () => {
    const at = new Date('2026-08-31T12:00:00.000Z');
    const run = {
      id: 'run-a', projectId: 'project-a', cronId: 'cron-a', cronRevision: 3,
      cronName: 'project-health', schedule: 'every 6h', description: 'Review health.',
      trigger: 'scheduled' as const, state: 'succeeded' as const,
      target: { scope: 'workspace' as const, projectId: 'project-a', spaceId: 'space-a' },
      prompt: 'Review repository health.', readScopes: ['repository/**'], writeScopes: ['local://workspace/reports/**'],
      resolvedSpaceId: 'space-a', resolvedGeneration: 7,
      scheduledFor: at, claimedAt: at, startedAt: at, completedAt: at, message: null, createdAt: at,
    };
    const encoded = ProjectCronRunViewCodec.encode(run);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = ProjectCronRunViewCodec.decode(encoded.value);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual(run);
  });
});
