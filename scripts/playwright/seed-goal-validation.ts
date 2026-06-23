#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { addGoalNearWorkspace, bindPlannedGoalForWorkspace, upsertGoalChain, writeGoalRecord, writePlannedGoal } from '../../src/core/goal-chain.js';
import { addGoalArtifact, addGoalJudgment, listGoalArtifacts } from '../../src/core/goal-validation.js';
import type { GoalRecord } from '../../src/types/goals.js';

function makeGoal(overrides: Partial<GoalRecord> & Pick<GoalRecord, 'id' | 'title' | 'phase'>): GoalRecord {
  const now = new Date(0).toISOString();
  return {
    version: 1,
    id: overrides.id,
    chainId: overrides.chainId ?? 'billing',
    title: overrides.title,
    projectName: overrides.projectName ?? 'demo',
    phase: overrides.phase,
    plannedWorkspaceName: overrides.plannedWorkspaceName,
    workspaceName: overrides.workspaceName,
    doc: overrides.doc ?? { bodyMarkdown: `# ${overrides.title}\n`, updatedAt: now },
    validation: overrides.validation ?? { criteria: [], requiredArtifacts: [] },
    sourceRefs: overrides.sourceRefs,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

function listArtifactId(projectName: string, goal: GoalRecord, title: string): string {
  const artifact = listGoalArtifacts(projectName, goal).find((item) => item.title === title);
  if (!artifact) throw new Error(`Artifact not found: ${title}`);
  return artifact.id;
}

const rootArg = process.argv[2];
if (!rootArg) throw new Error('Usage: bun scripts/playwright/seed-goal-validation.ts <workspace-root>');
const root = resolve(rootArg);
process.env.GITSPACE_WORKSPACE_ROOT = root;
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'demo', 'workspaces', 'api'), { recursive: true });
writeFileSync(join(root, 'demo', '.config.json'), JSON.stringify({
  name: 'demo',
  repository: 'owner/repo',
  baseBranch: 'main',
  createdAt: new Date(0).toISOString(),
  lastAccessed: new Date(0).toISOString(),
}, null, 2));

upsertGoalChain('demo', {
  id: 'billing',
  title: 'Billing rollout',
  projectName: 'demo',
  goalIds: ['api', 'playwright-artifact-goal', 'playwright-missing-artifact-goal', 'playwright-ui-story-goal'],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});
upsertGoalChain('demo', {
  id: 'workspace-artifact-story',
  title: 'Workspace Artifact Story',
  projectName: 'demo',
  goalIds: ['artifact-story'],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});
writePlannedGoal('demo', makeGoal({ id: 'api', title: 'API base', phase: 'code', plannedWorkspaceName: 'api' }));
const workspaceGoal = bindPlannedGoalForWorkspace('demo', 'api')!;
writeGoalRecord('demo', {
  ...workspaceGoal,
  validation: {
    criteria: [
      'Workspace artifact history is visible in the sidebar.',
      'Failed command output is visible in artifact history.',
    ],
    requiredArtifacts: [
      { kind: 'manual-note', description: 'Workspace manual note exists.' },
      { kind: 'test-output', description: 'Workspace command artifact exists.' },
    ],
    commands: ['sh -c "echo workspace-stderr-artifact >&2; exit 3"'],
    judgmentPrompt: 'Confirm the workspace-backed goal shows failed command artifact details.',
  },
  doc: {
    bodyMarkdown: '# API base\n\n## Objective\nVerify workspace-backed artifact history in the live app.\n',
    updatedAt: new Date(0).toISOString(),
  },
});
addGoalArtifact('demo', workspaceGoal, {
  kind: 'manual-note',
  title: 'Workspace artifact note',
  body: 'This workspace-backed goal has local artifact.',
});
addGoalArtifact('demo', workspaceGoal, {
  kind: 'test-output',
  title: 'Workspace command failure',
  command: 'sh -c \"echo workspace-stderr-artifact >&2; exit 3\"',
  exitCode: 3,
  stderr: 'workspace-stderr-artifact\\n',

});
const plannedGoal = writePlannedGoal('demo', makeGoal({
  id: 'playwright-artifact-goal',
  title: 'Playwright Artifact Goal',
  phase: 'plan',
  plannedWorkspaceName: 'playwright-artifact-goal',
  validation: {
    criteria: [
      'Validation and artifact section is visible in the sidebar.',
      'Review cycles are visible for the goal.',
    ],
    requiredArtifacts: [
      { kind: 'manual-note', description: 'Manual artifact note exists.' },
    ],
    commands: ['printf planned-command-preview'],
    judgmentPrompt: 'Confirm the sidebar shows artifact history and review cycles for this planned goal.',
  },
  doc: {
    bodyMarkdown: '# Playwright Artifact Goal\n\n## Objective\nVerify artifact history in the live app.\n',
    updatedAt: new Date(0).toISOString(),
  },
}));
addGoalArtifact('demo', plannedGoal, {
  kind: 'manual-note',
  title: 'Live artifact note',
  body: 'This planned goal already has artifact before workspace creation.',
});
addGoalJudgment('demo', plannedGoal, {
  artifactIds: [listArtifactId('demo', plannedGoal, 'Live artifact note')],
  type: 'human',
  status: 'passed',
  body: 'accepted: live artifact and judgment are visible',
});
addGoalNearWorkspace('demo', 'api', 'Extra planned neighbor', 'after');
writeGoalRecord('demo', plannedGoal);
const workspaceStory = writePlannedGoal('demo', makeGoal({
  id: 'artifact-story',
  title: 'Workspace Artifact Story Goal',
  chainId: 'workspace-artifact-story',
  phase: 'code',
  plannedWorkspaceName: 'artifact-story',
  validation: {
    criteria: [
      'Workspace artifact history is visible in the sidebar.',
      'A failed command artifact can appear after refresh.',
    ],
    requiredArtifacts: [
      { kind: 'manual-note', description: 'Workspace artifact note exists.' },
      { kind: 'test-output', description: 'Workspace command artifact exists.' },
    ],
    commands: ['sh -c "echo story-workspace-stderr >&2; exit 5"'],
    judgmentPrompt: 'Show how a workspace goal becomes failed after artifact arrives.',
  },
  doc: {
    bodyMarkdown: '# Workspace Artifact Story Goal\n\n## Objective\nShow failed command artifact appearing for a workspace-backed goal.\n',
    updatedAt: new Date(0).toISOString(),
  },
}));
mkdirSync(join(root, 'demo', 'workspaces', 'artifact-story'), { recursive: true });
const boundStory = bindPlannedGoalForWorkspace('demo', 'artifact-story')!;
writeGoalRecord('demo', boundStory);
addGoalArtifact('demo', boundStory, {
  kind: 'manual-note',
  title: 'Workspace story note',
  body: 'This workspace-backed goal starts with manual artifact only.',
});
const missingGoal = writePlannedGoal('demo', makeGoal({
  id: 'playwright-missing-artifact-goal',
  title: 'Playwright Missing Artifact Goal',
  phase: 'plan',
  plannedWorkspaceName: 'playwright-missing-artifact-goal',
  validation: {
    criteria: [
      'Empty artifact state is understandable.',
      'Missing required artifact is listed explicitly.',
    ],
    requiredArtifacts: [
      { kind: 'image', description: 'Attach a screenshot.' },
    ],
    judgmentPrompt: 'Show the empty artifact state for a planned goal with missing artifact.',
  },
  doc: {
    bodyMarkdown: '# Playwright Missing Artifact Goal\n\n## Objective\nVerify the empty artifact state in the live app.\n',
    updatedAt: new Date(0).toISOString(),
  },
}));
const uiStoryGoal = writePlannedGoal('demo', makeGoal({
  id: 'playwright-ui-story-goal',
  title: 'Playwright UI Story Goal',
  phase: 'plan',
  plannedWorkspaceName: 'playwright-ui-story-goal',
  validation: {
    criteria: [
      'UI can create manual artifact.',
      'UI can save a judgment.',
    ],
    requiredArtifacts: [
      { kind: 'manual-note', description: 'Manual artifact note exists.' },
    ],
    judgmentPrompt: 'Use the artifact actions UI to add artifact and save a judgment.',
  },
  doc: {
    bodyMarkdown: '# Playwright UI Story Goal\n\n## Objective\nCreate artifact only through the sidebar UI.\n',
    updatedAt: new Date(0).toISOString(),
  },
}));
console.log(JSON.stringify({ root, goals: [plannedGoal.id, missingGoal.id, boundStory.id, uiStoryGoal.id], titles: [plannedGoal.title, missingGoal.title, boundStory.title, uiStoryGoal.title] }, null, 2));
