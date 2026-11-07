import { describe, expect, it } from 'bun:test';
import {
  INSPECTOR_EVIDENCE_HISTORY_LIMIT,
  InspectorWorkspaceCodec,
  changeGuideDraftSchema,
  changeGuideViewSchema,
  goalRecordViewSchema,
  reviewThreadViewSchema,
  waiveWorkflowGateInputSchema,
  workflowViewSchema,
} from '../src/inspector-contract.js';
import { cloudWorkspaceDefinitionSchema } from '../src/project-authority.js';

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
  it('round-trips immutable workspace provenance without inventing it for legacy definitions', () => {
    const legacy = {
      id: 'workspace-a', projectId: 'project-a', kind: 'worktree', name: 'Workspace', branch: 'feature', phase: 'code',
      sourceKind: 'commit', sourceRef: commit, lifecycle: 'active', goalId: null, revision: 1, archivedAt: null,
      createdAt: at, updatedAt: at,
    };
    expect(cloudWorkspaceDefinitionSchema.parse(legacy)).toMatchObject({ sourceCommit: null, sourceKind: 'commit', sourceRef: commit });
    const recorded = InspectorWorkspaceCodec.decode({ ...legacy, sourceCommit: commit });
    expect(recorded).toMatchObject({ ok: true, value: { sourceCommit: commit } });
    if (!recorded.ok) return;
    const encoded = InspectorWorkspaceCodec.encode(recorded.value);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(InspectorWorkspaceCodec.decode(encoded.value)).toEqual(recorded);
    for (const sourceCommit of ['main', commit.slice(0, 12), 'a'.repeat(41)]) {
      expect(InspectorWorkspaceCodec.decode({ ...legacy, sourceCommit }).ok).toBe(false);
    }
  });

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
      baseCommit: commit,
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

  it('requires every change map reference to resolve, steps included, to a section of the same guide', () => {
    const draft = {
      headCommit: commit, baseRef: 'main', baseCommit: commit, title: 'Map', createdBy: 'narrator-a',
      sections: [{ id: 'store', title: 'Store', kind: 'behavior' as const, explanation: 'Stores it.', why: '', exhibits: [{ path: 'src/a.ts', blobId: null, note: '', slowRead: false, ranges: [{ start: 3, end: 3 }] }], requirementIds: [] }],
      map: {
        areas: [
          { id: 'ui', name: 'UI', package: 'account-web', role: 'Shows it', whatItDoes: 'Renders', files: ['src/a.ts'] },
          { id: 'worker', name: 'Worker', package: 'account-worker', role: 'Stores it', whatItDoes: 'Persists', files: [] },
        ],
        paths: [{ id: 'save', from: 'ui', to: 'worker', label: 'save', state: 'added' as const }],
        steps: [{ paths: ['save'], from: 'ui', to: 'worker', caption: 'The UI saves.', sectionId: 'store' }],
      },
    };
    expect(changeGuideDraftSchema.parse(draft).map?.steps[0]?.sectionId).toBe('store');
    const rejects = (changed: unknown) => changeGuideDraftSchema.safeParse(changed).error?.issues.map((issue) => issue.path.join('.'));
    expect(rejects({ ...draft, map: { ...draft.map, steps: [{ ...draft.map.steps[0], sectionId: 'elsewhere' }] } })).toEqual(['map.steps.0.sectionId']);
    expect(rejects({ ...draft, map: { ...draft.map, paths: [{ ...draft.map.paths[0], to: 'nowhere' }] } })).toEqual(['map.paths.0.to']);
    expect(rejects({ ...draft, map: { ...draft.map, steps: [{ ...draft.map.steps[0], paths: ['unknown'] }] } })).toEqual(['map.steps.0.paths.0']);
    expect(rejects({ ...draft, map: { ...draft.map, areas: [...draft.map.areas, draft.map.areas[0]] } })).toEqual(['map.areas']);
    expect(rejects({ ...draft, map: { ...draft.map, steps: [{ ...draft.map.steps[0], paths: [] }] } })).toEqual(['map.steps.0.paths']);
    expect(rejects({ ...draft, sections: [{ ...draft.sections[0], exhibits: [{ ...draft.sections[0]!.exhibits[0], ranges: [{ start: 4, end: 3 }] }] }] })).toEqual(['sections.0.exhibits.0.ranges.0.end']);
  });
});
