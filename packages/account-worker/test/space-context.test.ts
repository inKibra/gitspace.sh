import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SpaceContextDO } from '../src/space-context.js';

const identity = { projectId: 'project-inspector', spaceId: 'space-inspector' };
const head = 'a'.repeat(40);
const movedHead = 'b'.repeat(40);
const at = '2026-08-31T12:00:00.000Z';
const evidence = (run: number) => ({
  kind: 'command' as const,
  runId: `run-${run}`,
  command: 'bun test inspector',
  exitCode: 0,
  artifactUrl: `artifact://runs/${run}.json`,
  artifactHash: `sha256:${run.toString(16).padStart(64, '0')}`,
  generation: 7,
  label: `Run ${run}`,
});

async function inside<T>(name: string, operation: (context: SpaceContextDO) => T): Promise<T> {
  const stub = env.SPACE_CONTEXT.getByName(name);
  return runInDurableObject(stub, (context: SpaceContextDO) => operation(context));
}

describe('SpaceContextDO', () => {
  it('keeps goal, workflow gates, judgments, and journal deltas canonical with optimistic revisions', async () => {
    await inside('inspector-domain', (context) => context.bootstrap(identity));
    const goal = await inside('inspector-domain', (context) => context.putGoal({
      ...identity,
      expectedRevision: 0,
      goal: {
        id: 'goal-a',
        title: 'Portable Inspector',
        summary: 'Keep review context portable.',
        phase: 'review',
        requirements: [{ id: 'portable', title: 'Portable review', description: 'Threads survive a move.', required: true, status: 'missing', workflowNodeId: 'verify', criterionId: 'move', evidence: [] }],
        updatedBy: 'human-a',
      },
    }));
    expect(goal.revision).toBe(1);
    await expect(inside('inspector-domain', (context) => context.putGoal({
      ...identity,
      expectedRevision: 0,
      goal: { id: 'stale', title: 'Stale', summary: '', phase: 'plan', requirements: [], updatedBy: 'human-a' },
    }))).rejects.toThrow('revision conflict');

    const workflow = await inside('inspector-domain', (context) => context.putWorkflow({
      ...identity,
      expectedRevision: 0,
      workflow: {
        id: 'workflow-a',
        title: 'Review workflow',
        description: 'Verify then pass a human-waivable gate.',
        updatedBy: 'agent-a',
        nodes: [
          { id: 'verify', kind: 'phase', label: 'Verify', position: { x: 0, y: 0 }, status: 'running', role: 'reviewer', reads: [], writes: [] },
          { id: 'gate', kind: 'gate', label: 'Portable review accepted', position: { x: 100, y: 0 }, requirementIds: ['portable'] },
        ],
        edges: [{ id: 'verify-gate', from: 'verify', to: 'gate', kind: 'control', label: null }],
      },
    }));
    expect(workflow.nodes.find((node) => node.kind === 'gate')).toMatchObject({ satisfied: false, passable: false });

    await inside('inspector-domain', (context) => context.startJournalPhase({
      ...identity, phaseRunId: 'phase-run-a', entryId: 'journal-start-a', phase: 'Verify', intent: 'Prove portability.', createdBy: 'agent-a', repository: { generation: 7, headCommit: head },
    }));
    await expect(inside('inspector-domain', (context) => context.endJournalPhase({
      ...identity, phaseRunId: 'phase-run-a', entryId: 'journal-end-blocked', outcome: 'Not accepted.', decisions: [], surprises: [], createdBy: 'agent-a', repository: { generation: 7, headCommit: head }, revert: null,
    }))).rejects.toThrow('unsatisfied workflow gate');

    const waived = await inside('inspector-domain', (context) => context.waiveWorkflowGate({
      ...identity, expectedRevision: 1, gateId: 'gate', waiverId: 'waiver-a', reason: 'Human accepts the demonstrated risk.', actorId: 'human-a', actorKind: 'human',
    }));
    expect(waived.nodes.find((node) => node.kind === 'gate')).toMatchObject({ passable: true });

    const ended = await inside('inspector-domain', (context) => context.endJournalPhase({
      ...identity, phaseRunId: 'phase-run-a', entryId: 'journal-end-a', outcome: 'Gate waived after review.', decisions: ['Keep the pinned anchor.'], surprises: [], createdBy: 'agent-a', repository: { generation: 8, headCommit: movedHead }, revert: null,
    }));
    expect(ended.delta).toMatchObject({ generationChanged: true, headChanged: true, canonChanged: ['workflow'] });
    expect((await inside('inspector-domain', (context) => context.listJournal(identity))).map((entry) => entry.kind)).toEqual(['phase-start', 'phase-end']);
  });

  it('bounds evidence and judgments, appends review messages, and pins guide approval to revision plus HEAD', async () => {
    await inside('inspector-review', (context) => context.bootstrap(identity));
    let goal = await inside('inspector-review', (context) => context.putGoal({
      ...identity,
      expectedRevision: 0,
      goal: {
        id: 'goal-a', title: 'Review state', summary: '', phase: 'review', updatedBy: 'human-a',
        requirements: [{ id: 'portable', title: 'Portable', description: '', required: true, status: 'missing', workflowNodeId: null, criterionId: 'portable-command', evidence: [] }],
      },
    }));
    for (let run = 1; run <= 22; run += 1) {
      goal = await inside('inspector-review', (context) => context.attachRequirementEvidence({ ...identity, expectedRevision: goal.revision, requirementId: 'portable', evidence: evidence(run) }));
    }
    expect(goal.requirements[0]?.evidence).toHaveLength(20);
    expect(goal.requirements[0]?.evidence[0]).toMatchObject({ runId: 'run-3' });
    expect(goal.requirements[0]?.status).toBe('review');
    let rubric = await inside('inspector-review', (context) => context.putRubric({
      ...identity,
      expectedRevision: 0,
      rubric: {
        id: 'rubric-a',
        title: 'Inspector contract',
        description: 'Human, LLM, and Command checks.',
        updatedBy: 'human-a',
        criteria: [
          { id: 'portable-human', title: 'Human review', description: 'A human reviews placement.', workflowNodeId: null, requirementIds: [], judge: { kind: 'human' }, evidence: [] },
          { id: 'portable-llm', title: 'LLM review', description: 'An LLM reviews the narrative.', workflowNodeId: null, requirementIds: [], judge: { kind: 'llm', model: 'review-model' }, evidence: [] },
          { id: 'portable-command', title: 'Command review', description: 'A command proves portability.', workflowNodeId: null, requirementIds: ['portable'], judge: { kind: 'command', command: 'bun test inspector', expectation: { kind: 'exit-zero' } }, evidence: [] },
        ],
      },
    }));
    rubric = await inside('inspector-review', (context) => context.appendRubricJudgment({
      ...identity, expectedRevision: rubric.revision, criterionId: 'portable-human',
      judgment: { id: 'judgment-human', kind: 'human', verdict: 'pass', summary: 'Placement approved.', actorId: 'human-a', evidence: [], createdAt: at },
    }));
    rubric = await inside('inspector-review', (context) => context.appendRubricJudgment({
      ...identity, expectedRevision: rubric.revision, criterionId: 'portable-llm',
      judgment: { id: 'judgment-llm', kind: 'llm', verdict: 'pass', summary: 'Narrative grounded.', actorId: 'agent-a', model: 'review-model', evidence: [], createdAt: at },
    }));
    rubric = await inside('inspector-review', (context) => context.appendRubricJudgment({
      ...identity, expectedRevision: rubric.revision, criterionId: 'portable-command',
      judgment: { id: 'judgment-command', kind: 'command', verdict: 'pass', summary: 'Command passed.', actorId: 'agent-a', command: 'bun test inspector', runId: 'run-22', exitCode: 0, evidence: [evidence(22)], createdAt: at },
    }));
    expect(rubric.criteria.map((criterion) => criterion.judgments.map((judgment) => judgment.kind))).toEqual([['human'], ['llm'], ['command']]);
    expect((await inside('inspector-review', (context) => context.getGoal(identity)))?.requirements[0]?.status).toBe('accepted');

    let guide = await inside('inspector-review', (context) => context.putChangeGuide({
      ...identity,
      expectedRevision: 0,
      guide: {
        headCommit: head,
        baseRef: 'main',
        title: 'The change as a story',
        createdBy: 'narrator-a',
        sections: [{ id: 'portable', title: 'Portable state', kind: 'risk', explanation: 'State moves.', why: 'Processes do not.', exhibits: [], requirementIds: ['portable'] }],
      },
    }));
    await expect(inside('inspector-review', (context) => context.setGuideApproval({ ...identity, revision: guide.revision, headCommit: head, reviewerId: 'human-a', decision: 'approved', note: null }))).rejects.toThrow('must be read');
    guide = await inside('inspector-review', (context) => context.markGuideSectionRead({ ...identity, revision: guide.revision, headCommit: head, reviewerId: 'human-a', sectionId: 'portable' }));
    guide = await inside('inspector-review', (context) => context.setGuideApproval({ ...identity, revision: guide.revision, headCommit: head, reviewerId: 'human-a', decision: 'approved', note: null }));
    expect(guide.reviewerStates[0]).toMatchObject({ revision: 1, headCommit: head, decision: 'approved', readSectionIds: ['portable'] });

    let thread = await inside('inspector-review', (context) => context.createReviewThread({
      ...identity,
      id: 'thread-a',
      anchor: { kind: 'line', path: 'src/Inspector.tsx', generation: 7, baseCommit: head, headCommit: head, blobId: head, side: 'head', startLine: 4, endLine: 4 },
      decision: 'pending',
      message: { id: 'message-a', authorId: 'human-a', body: 'Keep this identity stable.', createdAt: at },
    }, { generation: 7, headCommit: head }));
    thread = await inside('inspector-review', (context) => context.appendReviewMessage({
      ...identity,
      threadId: thread.id,
      expectedRevision: thread.revision,
      message: { id: 'message-b', authorId: 'agent-a', body: 'Pinned to the Git blob.', createdAt: at },
    }, { generation: 8, headCommit: movedHead }));
    expect(thread).toMatchObject({ revision: 2, anchorState: 'stale' });
    expect(thread.messages.map((message) => message.id)).toEqual(['message-a', 'message-b']);
  });
});
