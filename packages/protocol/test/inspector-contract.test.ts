import { describe, expect, it } from 'bun:test';
import {
  INSPECTOR_EVIDENCE_HISTORY_LIMIT,
  changeGuideViewSchema,
  goalRecordViewSchema,
  reviewThreadViewSchema,
  waiveWorkflowGateInputSchema,
  workflowViewSchema,
} from '../src/inspector-contract.js';

const at = '2026-08-31T12:00:00.000Z';
const commit = 'a'.repeat(40);
const artifact = {
  kind: 'artifact' as const,
  url: 'artifact://evidence/report.json',
  hash: `sha256:${'b'.repeat(64)}`,
  generation: 3,
  label: 'Verification report',
  mediaType: 'application/json',
};

describe('Inspector contracts', () => {
  it('accepts ordered typed goal evidence and enforces the bounded history', () => {
    const goal = {
      projectId: 'project-a',
      spaceId: 'space-a',
      id: 'goal-a',
      revision: 1,
      title: 'Portable Inspector',
      summary: 'Keep canonical context portable.',
      phase: 'review' as const,
      requirements: [{
        id: 'portable-state',
        title: 'Portable state',
        description: 'State survives movement.',
        required: true,
        status: 'review' as const,
        workflowNodeId: 'verify',
        criterionId: 'move',
        evidence: [artifact],
      }],
      createdAt: at,
      updatedAt: at,
      updatedBy: 'reviewer-a',
    };
    expect(goalRecordViewSchema.parse(goal).requirements[0]?.evidence).toEqual([artifact]);
    expect(() => goalRecordViewSchema.parse({
      ...goal,
      requirements: [{ ...goal.requirements[0], evidence: Array.from({ length: INSPECTOR_EVIDENCE_HISTORY_LIMIT + 1 }, () => artifact) }],
    })).toThrow();
  });

  it('validates workflow graph endpoints and only accepts human gate waivers', () => {
    const workflow = {
      projectId: 'project-a',
      spaceId: 'space-a',
      id: 'workflow-a',
      revision: 1,
      title: 'Review flow',
      description: 'A gated review flow.',
      nodes: [
        { id: 'verify', kind: 'phase' as const, label: 'Verify', position: { x: 0, y: 0 }, status: 'running' as const, role: 'reviewer', reads: [], writes: [] },
        { id: 'gate', kind: 'gate' as const, label: 'Approve', position: { x: 100, y: 0 }, requirementIds: ['portable-state'], satisfied: false, passable: false, waivers: [] },
      ],
      edges: [{ id: 'verify-gate', from: 'verify', to: 'gate', kind: 'control' as const, label: null }],
      createdAt: at,
      updatedAt: at,
      updatedBy: 'agent-a',
    };
    expect(workflowViewSchema.parse(workflow).edges).toHaveLength(1);
    expect(() => workflowViewSchema.parse({ ...workflow, edges: [{ ...workflow.edges[0], to: 'missing' }] })).toThrow('missing endpoint');
    expect(() => waiveWorkflowGateInputSchema.parse({
      projectId: 'project-a', spaceId: 'space-a', expectedRevision: 1, gateId: 'gate', waiverId: 'waive-a', reason: 'Human accepts the risk.', actorId: 'agent-a', actorKind: 'agent',
    })).toThrow();
  });

  it('pins guide approval state and review anchors to revision and Git identity', () => {
    const guide = changeGuideViewSchema.parse({
      projectId: 'project-a',
      spaceId: 'space-a',
      revision: 4,
      headCommit: commit,
      baseRef: 'main',
      title: 'The change as a story',
      sections: [{ id: 'placement', title: 'Placement', kind: 'decision', explanation: 'One Inspector.', why: 'Stable context.', exhibits: [{ path: 'src/Inspector.tsx', blobId: commit, note: 'Slow read.', slowRead: true }], requirementIds: [] }],
      reviewerStates: [{ reviewerId: 'reviewer-a', revision: 4, headCommit: commit, readSectionIds: ['placement'], decision: 'approved', note: null, updatedAt: at }],
      createdAt: at,
      createdBy: 'narrator-a',
    });
    expect(guide.reviewerStates[0]).toMatchObject({ revision: 4, headCommit: commit, decision: 'approved' });

    const thread = reviewThreadViewSchema.parse({
      projectId: 'project-a',
      spaceId: 'space-a',
      id: 'thread-a',
      revision: 1,
      anchor: { kind: 'line', path: 'src/Inspector.tsx', generation: 7, baseCommit: commit, headCommit: commit, blobId: commit, side: 'head', startLine: 4, endLine: 8 },
      anchorState: 'current',
      staleReason: null,
      decision: 'pending',
      resolved: false,
      messages: [{ id: 'message-a', authorId: 'reviewer-a', body: 'Keep this portable.', createdAt: at }],
      createdAt: at,
      updatedAt: at,
    });
    expect(thread.anchor).toMatchObject({ generation: 7, headCommit: commit });
  });
});
