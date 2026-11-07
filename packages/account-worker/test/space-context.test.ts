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
    const waived = await inside('inspector-domain', (context) => context.waiveWorkflowGate({
      ...identity, expectedRevision: 1, gateId: 'gate', waiverId: 'waiver-a', reason: 'Human accepts the demonstrated risk.', actorId: 'human-a', actorKind: 'human',
    }));
    expect(waived.nodes.find((node) => node.kind === 'gate')).toMatchObject({ passable: true });

    const ended = await inside('inspector-domain', (context) => context.endJournalPhase({
      ...identity, phaseRunId: 'phase-run-a', entryId: 'journal-end-a', outcome: 'Gate waived after review.', decisions: ['Keep the pinned anchor.'], surprises: [], createdBy: 'agent-a', repository: { generation: 8, headCommit: movedHead }, revert: null,
    }));
    expect(ended.delta).toMatchObject({ generationChanged: true, headChanged: true, canonChanged: ['workflow'] });
    expect((await inside('inspector-domain', (context) => context.listJournal(identity))).map((entry) => entry.kind)).toEqual(['phase-start', 'phase-end']);
    const retried = await inside('inspector-domain', (context) => context.endJournalPhase({
      ...identity, phaseRunId: 'phase-run-a', entryId: 'journal-end-retry', outcome: 'Retried after a lost response.', decisions: [], surprises: [], createdBy: 'agent-a', repository: { generation: 8, headCommit: movedHead }, revert: null,
    }));
    expect(retried.entryId).toBe(ended.entryId);
    expect((await inside('inspector-domain', (context) => context.listJournal(identity))).map((entry) => entry.kind)).toEqual(['phase-start', 'phase-end']);
  });

  it('bounds evidence and judgments, appends review messages, and pins guide approval to revision plus HEAD', async () => {
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
        baseCommit: 'b'.repeat(40),
        title: 'The change as a story',
        createdBy: 'narrator-a',
        sections: [{ id: 'portable', title: 'Portable state', kind: 'risk', explanation: 'State moves.', why: 'Processes do not.', exhibits: [], requirementIds: ['portable'] }],
      },
    }));
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

  it('keeps a comment on a plan step anchored to that step, current whatever the HEAD', async () => {
    await inside('inspector-plan-step', (context) => context.createReviewThread({
      ...identity,
      id: 'thread-step',
      anchor: { kind: 'plan-step', stepId: 'store-tokens' },
      decision: 'pending',
      message: { id: 'message-step', authorId: 'human-a', body: 'Keep the old column until the backfill ends.', createdAt: at },
    }, { generation: 7, headCommit: head }));
    const [thread] = await inside('inspector-plan-step', (context) => context.listReviewThreads(identity, { generation: 9, headCommit: movedHead }));
    expect(thread).toMatchObject({ id: 'thread-step', anchor: { kind: 'plan-step', stepId: 'store-tokens' }, anchorState: 'current', staleReason: null });
  });

  it('reads goals, guides and journal entries stored before their new fields exactly as before', async () => {
    const section = { id: 'old', title: 'Old section', kind: 'risk', explanation: 'Changed.', why: '', exhibits: [{ path: 'src/a.ts', blobId: null, note: '', slowRead: false }], requirementIds: [] };
    await runInDurableObject(env.SPACE_CONTEXT.getByName('inspector-legacy'), (context: SpaceContextDO, state) => {
      context.getGoal(identity);
      state.storage.sql.exec("INSERT INTO inspector_goals (id, goal_id, revision, title, summary, phase, created_at, updated_at, updated_by) VALUES (1, 'goal-a', 1, 'Old goal', '', 'code', ?, ?, 'human-a')", at, at);
      state.storage.sql.exec("INSERT INTO inspector_goal_requirements (requirement_id, ordinal, title, description, required, status, workflow_node_id, criterion_id) VALUES ('old', 0, 'Old', '', 1, 'accepted', NULL, NULL)");
      state.storage.sql.exec(
        "INSERT INTO inspector_journal_entries (entry_id, kind, phase_run_id, phase, title, body, outcome, decisions_json, surprises_json, evidence_json, snapshot_json, delta_json, reverted_json, created_at, created_by) VALUES ('decided', 'decision', NULL, 'code', 'Chose SQL', 'Because.', NULL, '[]', '[]', '[]', NULL, NULL, NULL, ?, 'agent-a')",
        at,
      );
      state.storage.sql.exec("INSERT INTO inspector_guide_revisions (revision, head_commit, base_ref, base_commit, title, created_at, created_by) VALUES (1, ?, 'main', ?, 'Old guide', ?, 'narrator-a')", head, movedHead, at);
      state.storage.sql.exec("INSERT INTO inspector_guide_sections (revision, section_id, ordinal, value_json) VALUES (1, 'old', 0, ?)", JSON.stringify(section));
    });
    const overview = await inside('inspector-legacy', (context) => context.getOverview(identity));
    expect(overview.goal?.requirements).toStrictEqual([{ id: 'old', title: 'Old', description: '', required: true, status: 'accepted', workflowNodeId: null, criterionId: null, evidence: [] }]);
    expect(overview.journal.recent).toStrictEqual([{
      ...identity, id: 'decided', sequence: 1, kind: 'decision', phaseRunId: null, phase: 'code', title: 'Chose SQL', body: 'Because.', outcome: null,
      decisions: [], surprises: [], evidence: [], snapshot: null, delta: null, reverted: null, createdAt: at, createdBy: 'agent-a',
    }]);
    expect(overview.changeGuide).toStrictEqual({
      ...identity, revision: 1, headCommit: head, baseRef: 'main', baseCommit: movedHead, title: 'Old guide', sections: [section], reviewerStates: [], createdAt: at, createdBy: 'narrator-a',
    });
  });

  it('round-trips a guide\'s intro, captures, map and section detail, and a decision\'s citations, section and superseded decision', async () => {
    const section = {
      id: 'store', title: 'Store', kind: 'decision' as const, explanation: 'Stores the record.', why: 'It survives restarts.', requirementIds: [],
      exhibits: [{ path: 'src/store.ts', blobId: null, note: 'Read slowly.', slowRead: true, ranges: [{ start: 4, end: 9, note: 'The write.' }] }],
      summary: 'The worker stores it.', readersGuide: 'Start at the write.', diagram: '```mermaid\ngraph LR; a-->b\n```', evidence: [evidence(2)],
    };
    const map = {
      areas: [
        { id: 'ui', name: 'UI', package: 'account-web', role: 'Asks', whatItDoes: 'Sends the record', files: ['src/ui.ts'], note: 'Unchanged' },
        { id: 'worker', name: 'Worker', package: 'account-worker', role: 'Stores', whatItDoes: 'Persists the record', files: ['src/store.ts'] },
      ],
      paths: [{ id: 'save', from: 'ui', to: 'worker', label: 'save', state: 'added' as const }],
      steps: [{ paths: ['save'], from: 'ui', to: 'worker', caption: 'The UI saves the record.', sectionId: 'store' }],
    };
    const guide = { headCommit: head, baseRef: 'main', baseCommit: movedHead, title: 'Store it', createdBy: 'narrator-a', sections: [section], intro: 'Why this change.', captures: [evidence(1)], map };
    await inside('inspector-narrative', (context) => context.putChangeGuide({ ...identity, expectedRevision: 0, guide }));
    expect(await inside('inspector-narrative', (context) => context.getChangeGuide(identity))).toMatchObject({ revision: 1, intro: 'Why this change.', captures: [evidence(1)], map, sections: [section] });
    await expect(inside('inspector-narrative', (context) => context.putChangeGuide({
      ...identity, expectedRevision: 1, guide: { ...guide, map: { ...map, steps: [{ ...map.steps[0]!, sectionId: 'elsewhere' }] } },
    }))).rejects.toThrow('missing section');

    const citations = [{ conversationId: 'conversation-a', messageId: 'message-a', who: 'Brad', at, quote: 'Keep it in SQL.' }];
    const entry = { ...identity, phase: 'code', body: '', outcome: null, decisions: [], evidence: [], createdBy: 'agent-a' };
    await inside('inspector-narrative', (context) => context.appendJournalEntry({ ...entry, id: 'decision-a', kind: 'decision', title: 'Store in SQL', citations, sectionId: 'store' }));
    await inside('inspector-narrative', (context) => context.appendJournalEntry({ ...entry, id: 'note-a', kind: 'narrative', title: 'A note' }));
    for (const supersedes of ['note-a', 'absent']) {
      await expect(inside('inspector-narrative', (context) => context.appendJournalEntry({ ...entry, id: `decision-${supersedes}`, kind: 'decision', title: 'Replace', supersedes }))).rejects.toThrow('not a decision entry');
    }
    await inside('inspector-narrative', (context) => context.appendJournalEntry({ ...entry, id: 'decision-b', kind: 'decision', title: 'Store in KV', supersedes: 'decision-a' }));
    const journal = await inside('inspector-narrative', (context) => context.listJournal(identity));
    expect(journal.map((item) => item.id)).toEqual(['decision-a', 'note-a', 'decision-b']);
    expect(journal[0]).toMatchObject({ citations, sectionId: 'store' });
    expect(journal[2]).toMatchObject({ supersedes: 'decision-a' });
  });

  it('records a person accepting and reopening a requirement as decisions, and keeps acceptance out of goal writes', async () => {
    const requirement = { title: 'Evidenced', description: '', required: true, workflowNodeId: null, criterionId: null };
    const goal = await inside('inspector-acceptance', (context) => context.putGoal({
      ...identity, expectedRevision: 0,
      goal: { id: 'goal-a', title: 'Accept it', summary: '', phase: 'review', updatedBy: 'agent-a', requirements: [
        { ...requirement, id: 'evidenced', status: 'review', evidence: [evidence(1)] },
        { ...requirement, id: 'bare', title: 'Bare', status: 'missing', evidence: [] },
      ] },
    }));
    const accepted = await inside('inspector-acceptance', (context) => context.setRequirementAcceptance({ ...identity, expectedRevision: goal.revision, requirementId: 'evidenced', accepted: true }, 'device-a'));
    expect(accepted.goal.requirements[0]).toMatchObject({ status: 'accepted', acceptedBy: 'device-a', acceptedAt: expect.any(String) });
    expect(accepted.entry).toMatchObject({ kind: 'decision', title: 'Accepted Evidenced', createdBy: 'device-a' });

    const draft = { id: 'goal-a', title: 'Accept it', summary: '', phase: 'review' as const, updatedBy: 'agent-a', requirements: accepted.goal.requirements };
    await expect(inside('inspector-acceptance', (context) => context.putGoal({
      ...identity, expectedRevision: accepted.goal.revision, goal: { ...draft, requirements: [{ ...draft.requirements[0]!, acceptedBy: 'agent-a' }, draft.requirements[1]!] },
    }))).rejects.toThrow('only a person');
    const kept = await inside('inspector-acceptance', (context) => context.putGoal({ ...identity, expectedRevision: accepted.goal.revision, goal: draft }));
    expect(kept.requirements[0]).toMatchObject({ status: 'accepted', acceptedBy: 'device-a' });

    const reopened = await inside('inspector-acceptance', (context) => context.setRequirementAcceptance({ ...identity, expectedRevision: kept.revision, requirementId: 'evidenced', accepted: false }, 'device-a'));
    expect(reopened.goal.requirements[0]).toMatchObject({ status: 'review', acceptedBy: null, acceptedAt: null });
    expect(reopened.entry).toMatchObject({ kind: 'decision', title: 'Reopened Evidenced' });
    const bare = await inside('inspector-acceptance', (context) => context.setRequirementAcceptance({ ...identity, expectedRevision: reopened.goal.revision, requirementId: 'bare', accepted: true }, 'device-a'));
    const bareReopened = await inside('inspector-acceptance', (context) => context.setRequirementAcceptance({ ...identity, expectedRevision: bare.goal.revision, requirementId: 'bare', accepted: false }, 'device-a'));
    expect(bareReopened.goal.requirements[1]).toMatchObject({ status: 'missing', acceptedBy: null });
    await expect(inside('inspector-acceptance', (context) => context.setRequirementAcceptance({ ...identity, expectedRevision: bare.goal.revision, requirementId: 'bare', accepted: true }, 'device-a'))).rejects.toThrow('revision conflict');
    expect((await inside('inspector-acceptance', (context) => context.listJournal(identity))).map((item) => item.title)).toEqual(['Accepted Evidenced', 'Reopened Evidenced', 'Accepted Bare', 'Reopened Bare']);
  });

  it('rejects a write whose Markdown holds a bad block, naming the field and the block issue', async () => {
    const badSpec = '```gitspace-ui\n{ "root": "a", "elements": {} }\n```';
    await expect(inside('inspector-blocks', (context) => context.putGoal({
      ...identity, expectedRevision: 0,
      goal: { id: 'goal-a', title: 'Blocks', summary: '', phase: 'code', updatedBy: 'agent-a', requirements: [
        { id: 'shown', title: 'Shown', description: `See:\n${badSpec}`, required: true, status: 'missing', workflowNodeId: null, criterionId: null, evidence: [] },
      ] },
    }))).rejects.toThrow('goal.requirements[0].description: block 1');
    expect(await inside('inspector-blocks', (context) => context.getGoal(identity))).toBeNull();

    const section = { id: 'store', title: 'Store', kind: 'risk' as const, explanation: 'Stores.', why: '', exhibits: [], requirementIds: [] };
    const guide = { headCommit: head, baseRef: 'main', baseCommit: movedHead, title: 'Blocks', createdBy: 'narrator-a', sections: [section] };
    await expect(inside('inspector-blocks', (context) => context.putChangeGuide({ ...identity, expectedRevision: 0, guide: { ...guide, sections: [{ ...section, why: '```mermaid\ngraph LR' }] } })))
      .rejects.toThrow('guide.sections[0].why: block 1: the ```mermaid fence is not closed');
    await expect(inside('inspector-blocks', (context) => context.putChangeGuide({ ...identity, expectedRevision: 0, guide: { ...guide, sections: [{ ...section, diagram: 'Just prose.' }] } })))
      .rejects.toThrow('guide.sections[0].diagram: holds 0 blocks');
    await expect(inside('inspector-blocks', (context) => context.appendJournalEntry({
      ...identity, id: 'note', kind: 'narrative', phase: 'code', title: 'Note', body: '```svg\n<svg><script/></svg>\n```', outcome: null, decisions: [], evidence: [], createdBy: 'agent-a',
    }))).rejects.toThrow('body: block 1');
    expect(await inside('inspector-blocks', (context) => context.getChangeGuide(identity))).toBeNull();
    expect(await inside('inspector-blocks', (context) => context.listJournal(identity))).toEqual([]);
  });
});
