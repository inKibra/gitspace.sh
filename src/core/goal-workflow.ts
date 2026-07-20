/**
 * Goal ⟷ rubric ⟷ workflow interconnect — the fs-bound half (core, non-UI).
 *
 * Loads the workspace's single canonical `*.workflow.json` and applies the
 * human-only gate waive. All pure interconnect logic (doc slices, computed
 * gates, spec warnings) lives in core/goal-gates.ts so the web panes can
 * share it.
 *
 * - Workflow: ONE `*.workflow.json` per workspace on the artifacts mount is
 *   canonical. Its phase list is the phase-name canon (unknown names warn,
 *   never gate). Workflow phases reference slice ids only — the rubric is
 *   the declaration of record (Requirement.wfPhase / Requirement.sliceId);
 *   the workflow never lists requirement ids.
 * - A human-only waive (UI seam, 'goal-gate-waive') or a `phase-end
 *   --revert` are the escape hatches for an unsatisfied gate.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SpacesError } from '../types/errors.js';
import type { GoalRecord } from '../types/goals.js';
import {
  parseDocSlices,
  workflowPhaseNames,
  workflowSpecWarnings,
  type WorkspaceWorkflow,
  type WorkspaceWorkflowSpec,
} from './goal-gates.js';
import { artifactsScope } from './artifacts.js';

// ─── Workspace workflow (single canonical *.workflow.json) ─────────────────

function artifactsMountDirFor(workspaceDir: string): string {
  return join(workspaceDir, '.gitspace', 'artifacts');
}

/** A workspace's workflow spec is a GOAL artifact — it lives in the goal
 *  folder the workspace owns, not at the mount root (docs/ARTIFACTS-FS.md).
 *  Globbing the mount root would find every OTHER goal's spec once branches
 *  roll up, which is exactly the "multiple workflow specs" error below. */
function workflowSearchDirFor(workspaceDir: string): string {
  return artifactsScope(workspaceDir).rootDir;
}

export function listWorkflowSpecPaths(workspaceDir: string): string[] {
  if (!existsSync(join(artifactsMountDirFor(workspaceDir), '.git'))) return [];
  const dir = workflowSearchDirFor(workspaceDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.workflow.json')).sort();
}

/**
 * Load THE workflow for a workspace. One `*.workflow.json` on the artifacts
 * mount is canonical; zero is fine (no workflow — everything behaves as
 * before); more than one is an error listing the offending paths.
 */
export function loadWorkspaceWorkflow(workspaceDir: string): WorkspaceWorkflow | null {
  const paths = listWorkflowSpecPaths(workspaceDir);
  if (paths.length === 0) return null;
  if (paths.length > 1) {
    throw new SpacesError(
      `Multiple workflow specs on the artifacts mount — a workspace has ONE workflow. Found: ${paths.join(', ')}. Remove or merge the extras.`,
      'USER_ERROR',
      1,
    );
  }
  const path = paths[0]!;
  const abs = join(workflowSearchDirFor(workspaceDir), path);
  let spec: WorkspaceWorkflowSpec;
  try {
    spec = JSON.parse(readFileSync(abs, 'utf8')) as WorkspaceWorkflowSpec;
  } catch (e) {
    throw new SpacesError(`Unreadable workflow spec ${path}: ${e instanceof Error ? e.message : String(e)}`, 'USER_ERROR', 1);
  }
  return { path, spec };
}

/**
 * Best-effort workflow load: never throws. Journal/requirement paths use
 * this — a broken workflow degrades to warnings (`space workflow validate`
 * is the surface that hard-errors), it never bricks phase journaling.
 */
export function tryLoadWorkspaceWorkflow(workspaceDir: string): { workflow: WorkspaceWorkflow | null; error?: string } {
  try {
    return { workflow: loadWorkspaceWorkflow(workspaceDir) };
  } catch (e) {
    return { workflow: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Workflow validation (space workflow validate) ─────────────────────────

export interface WorkflowValidationResult {
  /** Path of the validated spec, when one exists. */
  path?: string;
  phases: string[];
  /** Amber state: dangling slice refs, duplicate/empty phase names, … */
  warnings: string[];
  /** Slice ids currently derivable from the goal doc. */
  docSliceIds: string[];
}

/**
 * Validate the workspace's workflow against the goal doc. Throws
 * (SpacesError) on multiple workflows or parse errors; everything else —
 * dangling slice refs, phase-name oddities — is a WARNING (amber state
 * data), never a hard failure.
 */
export function validateWorkspaceWorkflow(
  workspaceDir: string,
  goal: Pick<GoalRecord, 'doc'> | null,
): WorkflowValidationResult {
  const workflow = loadWorkspaceWorkflow(workspaceDir);
  const docSliceIds = parseDocSlices(goal?.doc.bodyMarkdown ?? '').map((s) => s.id);
  if (!workflow) {
    return { phases: [], warnings: [], docSliceIds };
  }
  return {
    path: workflow.path,
    phases: workflowPhaseNames(workflow),
    warnings: workflowSpecWarnings(workflow.spec, docSliceIds),
    docSliceIds,
  };
}

// ─── Human-only gate waive (daemon/protocol seam — no CLI flag) ────────────

/**
 * Waive a phase gate. HUMAN-ONLY: reachable through the daemon command
 * 'goal-gate-waive' (the UI waive button) — the CLI deliberately has NO
 * waive flag, so agents cannot waive their own gates. Records a timeline
 * event kind 'gate' carrying the phase, reason, and actor.
 */
export async function waiveGoalGate(
  projectName: string,
  goalId: string,
  phase: string,
  reason: string,
  actor = 'human/ui',
): Promise<GoalRecord> {
  if (!reason.trim()) {
    throw new SpacesError('A reason is required to waive a gate.', 'USER_ERROR', 1);
  }
  const { getGoalRecord, writeGoalRecord } = await import('./goal-chain.js');
  const { appendGateWaiveEvent } = await import('./goal-validation.js');
  const { withGoalLock } = await import('./goal-lock.js');
  return withGoalLock(projectName, () => {
    const goal = getGoalRecord(projectName, goalId);
    if (!goal) throw new SpacesError(`Goal not found: ${goalId}`, 'USER_ERROR', 1);
    return writeGoalRecord(projectName, {
      ...goal,
      validation: appendGateWaiveEvent(goal.validation, phase, reason.trim(), actor),
    });
  });
}
