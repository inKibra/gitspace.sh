#!/usr/bin/env bun
import { rmSync } from 'fs';
import { resolve } from 'path';
import { addGoalArtifact, addGoalJudgment, getGoalValidationDir, listGoalArtifacts } from '../../src/core/goal-validation.js';
import { findGoalRecord, writeGoalRecord } from '../../src/core/goal-chain.js';

const rootArg = process.argv[2];
const portArg = process.argv[3] ?? '47999';
if (!rootArg) throw new Error('Usage: bun scripts/playwright/mutate-goal-validation-server.ts <workspace-root> [port]');
const root = resolve(rootArg);
const port = Number(portArg);
process.env.GITSPACE_WORKSPACE_ROOT = root;

const projectName = 'demo';


function findArtifactId(goal: NonNullable<ReturnType<typeof findGoalRecord>>, title: string): string {
  const artifact = listGoalArtifacts(projectName, goal).find((item) => item.title === title);
  if (!artifact) throw new Error(`Artifact not found: ${title}`);
  return artifact.id;
}

function mutatePlannedRefresh(goalId: string, token: string) {
  const goal = findGoalRecord(projectName, goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  const refreshCriterion = `Refresh mutation arrived (${token}).`;
  const refreshPrompt = `Refresh pulled the updated artifact and criteria into the live sidebar (${token}).`;
  const existingCriteria = goal.validation.criteria ?? [];
  if (!existingCriteria.includes(refreshCriterion)) {
    writeGoalRecord(projectName, {
      ...goal,
      validation: {
        ...goal.validation,
        criteria: [...existingCriteria, refreshCriterion],
        judgmentPrompt: refreshPrompt,
      },
    });
  }
  const refreshTitle = `Refreshed artifact note (${token})`;
  if (!listGoalArtifacts(projectName, goal).some((artifact) => artifact.title === refreshTitle)) {
    addGoalArtifact(projectName, goal, {
      kind: 'manual-note',
      title: refreshTitle,
      body: `This artifact was added after the page first loaded and should appear after Refresh (${token}).`,
    });
  }
  return { goalId, token, title: refreshTitle };
}

function mutateMissingFile(goalId: string, token: string) {
  const goal = findGoalRecord(projectName, goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  const title = `Story screenshot (${token})`;
  if (!listGoalArtifacts(projectName, goal).some((artifact) => artifact.title === title)) {
    const filePath = resolve(root, `story-screenshot-${token}.txt`);
    Bun.write(filePath, `story screenshot ${token}`);
    addGoalArtifact(projectName, goal, {
      kind: 'file',
      title,
      path: filePath,
    });
  }
  return { goalId, token, title };
}

function mutateMissingManual(goalId: string, token: string) {
  const goal = findGoalRecord(projectName, goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  const title = `Story manual note (${token})`;
  if (!listGoalArtifacts(projectName, goal).some((artifact) => artifact.title === title)) {
    addGoalArtifact(projectName, goal, {
      kind: 'manual-note',
      title,
      body: `Manual artifact added during the story (${token}).`,
    });
  }
  return { goalId, token, title };
}

function mutateMissingReview(goalId: string, token: string) {
  const goal = findGoalRecord(projectName, goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  const artifactTitle = `Story manual note (${token})`;
  if (!listGoalArtifacts(projectName, goal).some((artifact) => artifact.title === artifactTitle)) {
    addGoalArtifact(projectName, goal, {
      kind: 'manual-note',
      title: artifactTitle,
      body: `Manual artifact added during the story (${token}).`,
    });
  }
  addGoalJudgment(projectName, goal, {
    artifactIds: [findArtifactId(goal, artifactTitle)],
    type: 'human',
    status: 'passed',
    body: `accepted: story complete (${token})`,
  });
  return { goalId, token, title: artifactTitle };
}

function mutateWorkspaceFailure(goalId: string, token: string) {
  const goal = findGoalRecord(projectName, goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  const title = `Workspace command failure (${token})`;
  if (!listGoalArtifacts(projectName, goal).some((artifact) => artifact.title === title)) {
    addGoalArtifact(projectName, goal, {
      kind: 'test-output',
      title,
      command: `sh -c \"echo story-workspace-stderr-${token} >&2; exit 5\"`,
      exitCode: 5,
      stderr: `story-workspace-stderr-${token}\\n`,
    });
  }
  return { goalId, token, title };
}

function mutate(goalId: string, action: string, token: string) {
  switch (action) {
    case 'planned-refresh':
      return mutatePlannedRefresh(goalId, token);
    case 'missing-file':
      return mutateMissingFile(goalId, token);
    case 'missing-manual':
      return mutateMissingManual(goalId, token);
    case 'missing-review':
      return mutateMissingReview(goalId, token);
    case 'workspace-failure':
      return mutateWorkspaceFailure(goalId, token);
    default:
      throw new Error(`Unknown mutate action: ${action}`);
  }
}

function resetMissingGoal(goalId: string) {
  const goal = findGoalRecord(projectName, goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  rmSync(getGoalValidationDir(projectName, goal), { recursive: true, force: true });
  writeGoalRecord(projectName, {
    ...goal,
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
  });
  return { goalId, reset: true };
}

function resetWorkspaceStory(goalId: string) {
  const goal = findGoalRecord(projectName, goalId);
  if (!goal) throw new Error(`Goal not found: ${goalId}`);
  rmSync(getGoalValidationDir(projectName, goal), { recursive: true, force: true });
  writeGoalRecord(projectName, {
    ...goal,
    validation: {
      criteria: [
        'Workspace artifact history is visible in the sidebar.',
        'A failed command artifact can appear after refresh.',
      ],
      requiredArtifacts: [
        { kind: 'manual-note', description: 'Workspace artifact note exists.' },
        { kind: 'test-output', description: 'Workspace command artifact exists.' },
      ],
      commands: ['sh -c \"echo story-workspace-stderr >&2; exit 5\"'],
      judgmentPrompt: 'Show how a workspace goal becomes failed after artifact arrives.',
    },
  });
  const refreshed = findGoalRecord(projectName, goalId);
  if (!refreshed) throw new Error(`Goal not found after reset: ${goalId}`);
  addGoalArtifact(projectName, refreshed, {
    kind: 'manual-note',
    title: 'Workspace story note',
    body: 'This workspace-backed goal starts with manual artifact only.',
  });
  return { goalId, reset: true };
}

function resetState(goalId: string, action: string) {
  switch (action) {
    case 'reset-missing':
      return resetMissingGoal(goalId);
    case 'reset-workspace':
      return resetWorkspaceStory(goalId);
    default:
      throw new Error(`Unknown reset action: ${action}`);
  }
}


const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (url.pathname !== '/mutate') {
      return new Response('not found', { status: 404, headers });
    }
    const goalId = url.searchParams.get('goal') ?? 'playwright-artifact-goal';
    const action = url.searchParams.get('action') ?? 'planned-refresh';
    const token = url.searchParams.get('token') ?? 'default';
    const mode = url.searchParams.get('mode') ?? 'mutate';
    try {
      const result = mode === 'reset' ? resetState(goalId, action) : mutate(goalId, action, token);
      return Response.json({ ok: true, ...result }, { headers });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500, headers });
    }
  },
});

console.log(JSON.stringify({ port: server.port, root }, null, 2));
