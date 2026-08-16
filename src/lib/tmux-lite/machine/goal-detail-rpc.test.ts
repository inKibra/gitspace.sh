import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getGoalRecord, upsertGoalChain, writePlannedGoal } from '../../../core/goal-chain.js';
import { computeReadiness } from '../../../app/shared/goal-validation/readiness.js';
import { buildGoalRecordsForProject } from './build.js';
import type { GoalValidation } from '../../../types/goals.js';

/**
 * Ticket #42 goal-detail RPC round-trip (data contract). The daemon handler in
 * server.ts serves `goal-detail` as `getGoalRecord(...)` + `computeReadiness`,
 * while the connect snapshot ships `buildGoalRecordsForProject(...)` (slim).
 * This exercises both halves against a real goal store so the contract — slim
 * on connect, full on demand — is pinned.
 */
function fatValidation(): GoalValidation {
  const big = 'y'.repeat(20_000);
  return {
    reqOrder: ['r1'],
    requirements: {
      r1: {
        id: 'r1', title: 'Tests', kind: 'test-output', required: true, rubric: 'green', status: 'accepted',
        generation: { kind: 'command', command: 'bun test' },
        judgment: { kind: 'command', command: 'bun test', expect: { kind: 'exit-zero' } },
        evidence: [{ id: 'ev', name: 'run', meta: 'cmd', source: 'command', createdAt: new Date(1000).toISOString(), command: 'bun test', stdout: big, stderr: '', exitCode: 0 }],
        reviews: [{ id: 'rv', tone: 'green', who: 'human', note: 'ok', createdAt: new Date(2000).toISOString() }],
      },
    },
    events: [{ id: 'e1', requirementId: 'r1', tone: 'green', kind: 'review', title: 'passed', body: 'ok', payload: 'p', createdAt: new Date(2000).toISOString() }],
  };
}

describe('goal-detail RPC round-trip (ticket #42)', () => {
  it('serves the full doc + validation with computed readiness; snapshot stays slim', () => {
    const root = join(tmpdir(), `goal-detail-rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const prev = process.env.GITSPACE_WORKSPACE_ROOT;
    process.env.GITSPACE_WORKSPACE_ROOT = root;
    try {
      mkdirSync(join(root, 'demo', 'workspaces'), { recursive: true });
      writeFileSync(join(root, 'demo', '.config.json'), JSON.stringify({
        name: 'demo', repository: 'owner/repo', baseBranch: 'main',
        createdAt: new Date(0).toISOString(), lastAccessed: new Date(0).toISOString(),
      }), 'utf-8');
      upsertGoalChain('demo', {
        id: 'c', title: 'Chain', projectName: 'demo', goalIds: ['g1'],
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      });
      writePlannedGoal('demo', {
        version: 2, id: 'g1', chainId: 'c', title: 'Goal', projectName: 'demo', phase: 'review',
        plannedWorkspaceName: 'ws', doc: { bodyMarkdown: '# Full body here', updatedAt: new Date(0).toISOString() },
        validation: fatValidation(), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      });

      // Mirror the server.ts 'goal-detail' handler exactly.
      const goal = getGoalRecord('demo', 'g1')!;
      const response = {
        type: 'goal-detail' as const,
        doc: goal.doc,
        validation: { ...goal.validation, readiness: computeReadiness(goal.validation) },
      };

      expect(response.doc.bodyMarkdown).toBe('# Full body here');
      expect(response.validation.events).toHaveLength(1);
      expect(response.validation.requirements.r1.reviews).toHaveLength(1);
      expect(response.validation.requirements.r1.evidence[0].stdout?.length).toBe(20_000);
      expect(response.validation.readiness?.totals).toEqual({ total: 1, missing: 0, review: 0, accepted: 1 });

      // The connect snapshot's projection of the same goal is slim.
      const [slim] = buildGoalRecordsForProject('demo');
      expect(slim.id).toBe('demo:g1');
      expect(slim.doc?.bodyMarkdown).toBe('');
      expect(slim.validation?.events).toEqual([]);
      expect(slim.validation?.requirements.r1.reviews).toEqual([]);
      expect(slim.validation?.requirements.r1.evidence[0]?.stdout).toBeUndefined();
      expect(slim.validation?.readiness?.totals.accepted).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.GITSPACE_WORKSPACE_ROOT;
      else process.env.GITSPACE_WORKSPACE_ROOT = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
