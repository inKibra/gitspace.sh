/**
 * Goal ⟷ rubric ⟷ workflow interconnect (core, non-UI).
 *
 * - Doc slices: heading-anchored sections of the goal doc, parsed at read
 *   time (ids are NEVER stored in the doc). id = slugified heading, with a
 *   `-2`/`-3`… suffix on collisions.
 * - Workflow: ONE `*.workflow.json` per workspace on the artifacts mount is
 *   canonical. Its phase list is the phase-name canon (unknown names warn,
 *   never gate). Workflow phases reference slice ids only — the rubric is
 *   the declaration of record (Requirement.wfPhase / Requirement.sliceId);
 *   the workflow never lists requirement ids.
 * - Gates: computed, never stored — a phase's gate is satisfied iff every
 *   owed requirement (wfPhase == phase, required) is accepted. Trivially
 *   satisfied when nothing is owed. A human-only waive (UI seam,
 *   'goal-gate-waive') or a `phase-end --revert` are the escape hatches.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SpacesError } from '../types/errors.js';
import type { GoalRecord, Requirement, TimelineEvent } from '../types/goals.js';

// ─── Doc slices ─────────────────────────────────────────────────────────────

export interface DocSlice {
  /** Stable-ish id: slugified heading text (deduped with -2/-3… suffixes). */
  id: string;
  /** Heading text as written (without the leading #s). */
  heading: string;
  /** Heading level (1-6). */
  level: number;
  /** 0-based line index of the heading in bodyMarkdown. */
  line: number;
}

export function slugifySliceId(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

/**
 * Parse the goal doc into heading-anchored slices. ATX headings only
 * (`# `…`###### `); fenced code blocks are skipped so `# comment` lines in
 * code never become slices. Duplicate headings dedupe as `id-2`, `id-3`, …
 */
export function parseDocSlices(bodyMarkdown: string): DocSlice[] {
  const slices: DocSlice[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  const lines = bodyMarkdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const heading = match[2]!.trim();
    if (!heading) continue;
    const base = slugifySliceId(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    slices.push({
      id: count === 1 ? base : `${base}-${count}`,
      heading,
      level: match[1]!.length,
      line: i,
    });
  }
  return slices;
}

// ─── Workspace workflow (single canonical *.workflow.json) ─────────────────

/** Minimal shape we rely on from WorkflowSpecData (blocks/types/content.ts).
 *  Parsed structurally so core stays decoupled from zod block schemas. */
export interface WorkspaceWorkflowSpec {
  recipe?: string;
  phases?: Array<{
    name?: string;
    /** Slice ids this phase reads from the goal doc (interconnect seam). */
    slices?: string[];
    created?: Array<{ name?: string; type?: string; sliceId?: string }>;
  }>;
}

export interface WorkspaceWorkflow {
  /** Path of the spec relative to the artifacts mount. */
  path: string;
  spec: WorkspaceWorkflowSpec;
}

function artifactsMountDirFor(workspaceDir: string): string {
  return join(workspaceDir, '.gitspace', 'artifacts');
}

export function listWorkflowSpecPaths(workspaceDir: string): string[] {
  const mount = artifactsMountDirFor(workspaceDir);
  if (!existsSync(join(mount, '.git'))) return [];
  return readdirSync(mount).filter((f) => f.endsWith('.workflow.json')).sort();
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
  const abs = join(artifactsMountDirFor(workspaceDir), path);
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

export function workflowPhaseNames(workflow: WorkspaceWorkflow | null): string[] {
  return (workflow?.spec.phases ?? [])
    .map((p) => (typeof p?.name === 'string' ? p.name.trim() : ''))
    .filter((name) => name.length > 0);
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
  const known = new Set(docSliceIds);
  const warnings: string[] = [];
  if (!workflow) {
    return { phases: [], warnings, docSliceIds };
  }
  const phases = workflowPhaseNames(workflow);
  const rawPhases = workflow.spec.phases ?? [];
  if (rawPhases.length !== phases.length) {
    warnings.push('Workflow has phase entries without a usable name.');
  }
  const dupes = phases.filter((name, i) => phases.indexOf(name) !== i);
  for (const dupe of [...new Set(dupes)]) {
    warnings.push(`Duplicate phase name in workflow: "${dupe}".`);
  }
  for (const phase of rawPhases) {
    const label = typeof phase?.name === 'string' && phase.name.trim() ? phase.name.trim() : '(unnamed)';
    for (const sliceId of phase?.slices ?? []) {
      if (!known.has(sliceId)) {
        warnings.push(`Phase "${label}" references slice "${sliceId}" that is not a heading in the goal doc.`);
      }
    }
    for (const artifact of phase?.created ?? []) {
      if (artifact?.sliceId && !known.has(artifact.sliceId)) {
        warnings.push(`Phase "${label}" artifact "${artifact.name ?? artifact.sliceId}" references slice "${artifact.sliceId}" that is not a heading in the goal doc.`);
      }
    }
  }
  return { path: workflow.path, phases, warnings, docSliceIds };
}

// ─── Computed gates ─────────────────────────────────────────────────────────

export interface GateStatus {
  phase: string;
  /** Requirements owed by this phase (wfPhase == phase), contract order. */
  owed: Requirement[];
  /** Owed + required + not accepted — what blocks the gate. */
  unmet: Requirement[];
  /** true iff every owed required requirement is accepted (trivially true
   *  when nothing is owed). Waives do NOT flip this — see `waived`. */
  satisfied: boolean;
  /** A human waived this gate (timeline event kind 'gate', actor human/ui). */
  waived: boolean;
  /** satisfied || waived — may the phase end? */
  passable: boolean;
}

function isWaiveEventForPhase(event: TimelineEvent, phase: string): boolean {
  return event.kind === 'gate'
    && event.payload.startsWith('gate.waived')
    && event.payload.split('\n').some((line) => line.trim() === `phase: ${phase}`);
}

/**
 * Computed gate for a workflow phase: satisfied iff every owed requirement
 * (wfPhase == phase, required) is accepted; trivially satisfied when none
 * are owed. Optional requirements are listed as owed but never block.
 */
export function gateStatusForPhase(goal: Pick<GoalRecord, 'validation'>, phase: string): GateStatus {
  const validation = goal.validation;
  const owed = (validation.reqOrder ?? [])
    .map((id) => validation.requirements[id])
    .filter((r): r is Requirement => Boolean(r))
    .filter((r) => r.wfPhase === phase);
  const unmet = owed.filter((r) => r.required !== false && r.status !== 'accepted');
  const waived = (validation.events ?? []).some((e) => isWaiveEventForPhase(e, phase));
  const satisfied = unmet.length === 0;
  return { phase, owed, unmet, satisfied, waived, passable: satisfied || waived };
}

/** One line per owed requirement — the contract printout phase-start and a
 *  blocked phase-end both show the agent. */
export function describeOwedRequirement(r: Requirement): string {
  const bits = [
    `${r.id} · ${r.status}${r.required === false ? ' · optional' : ''}`,
    `  rubric: ${r.rubric}`,
  ];
  if (r.generation.kind === 'command') bits.push(`  generate: space goal artifact run --requirement ${r.id}   (${r.generation.command})`);
  else bits.push(`  generate: space goal artifact attach --requirement ${r.id} …   (manual)`);
  if (r.judgment.kind === 'command') bits.push(`  judge: space goal review run --requirement ${r.id}   (${r.judgment.command} · ${r.judgment.expect.kind})`);
  else if (r.judgment.kind === 'llm') bits.push(`  judge: space goal requirement verdict --requirement ${r.id} --accept|--reject --notes "…"   (llm${r.judgment.modelHint ? ` · ${r.judgment.modelHint}` : ''})`);
  else bits.push(`  judge: space goal requirement verdict --requirement ${r.id} --accept|--reject --notes "…"   (human)`);
  if (r.sliceId) bits.push(`  slice: ${r.sliceId}`);
  return bits.join('\n');
}

// ─── Human-only gate waive (daemon/protocol seam — no CLI flag) ────────────

/**
 * Waive a phase gate. HUMAN-ONLY: reachable through the daemon command
 * 'goal-gate-waive' (a UI button in a later pass) — the CLI deliberately has
 * NO waive flag, so agents cannot waive their own gates. Records a timeline
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
