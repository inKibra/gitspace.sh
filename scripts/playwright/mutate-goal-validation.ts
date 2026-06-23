#!/usr/bin/env bun
import { resolve } from 'path';
import { addGoalArtifact, listGoalArtifacts } from '../../src/core/goal-validation.js';
import { findGoalRecord, writeGoalRecord } from '../../src/core/goal-chain.js';

const rootArg = process.argv[2];
if (!rootArg) throw new Error('Usage: bun scripts/playwright/mutate-goal-validation.ts <workspace-root> [token]');
const root = resolve(rootArg);
const token = process.argv[3] ?? 'default';
process.env.GITSPACE_WORKSPACE_ROOT = root;

const projectName = 'demo';
const goalId = 'playwright-artifact-goal';
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

console.log(JSON.stringify({ root, goalId, mutated: true }, null, 2));
