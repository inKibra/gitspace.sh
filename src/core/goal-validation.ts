import { createHash } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { basename, dirname, extname, join } from 'path';
import { spawnSync } from 'child_process';
import { getProjectBaseDir, getProjectDir, getProjectWorkspacesDir } from './config.js';
import { artifactsScope, captureArtifactsSync } from './artifacts.js';
import { getOpenJournalPhase } from './phase-journal.js';
import { isSameRunJudgment } from './goal-gates.js';
import { ensureWorkspaceStorageIgnored, getWorkspaceStorageDir } from './workspace-metadata.js';
import { SpacesError } from '../types/errors.js';
import { generateId } from '../utils/id.js';
import { sanitizeForFileSystem } from '../utils/sanitize.js';
import type {
  ArtifactKind,
  CommandExpectation,
  Evidence,
  Generation,
  GoalRecord,
  GoalValidation,
  Judgment,
  Requirement,
  RequirementStatus,
  Review,
  ReviewTone,
  TimelineEvent,
} from '../types/goals.js';

// ─── Paths (binary evidence storage only) ──────────────────────────────────

const PROJECT_GOAL_VALIDATION_DIR = join('.gitspace', 'goals', 'validation');
const WORKSPACE_GOAL_VALIDATION_DIR = 'validation';
const VALIDATION_ARTIFACTS_DIR = 'artifacts';

function nowIso(): string {
  return new Date().toISOString();
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new SpacesError(`${label} must be a non-empty path segment`, 'USER_ERROR', 1);
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function ensureParentDir(filePath: string): void {
  ensureDir(dirname(filePath));
}

export function getPlannedGoalValidationDir(projectName: string, goalId: string): string {
  assertSafeSegment(goalId, 'goalId');
  return join(getProjectDir(projectName), PROJECT_GOAL_VALIDATION_DIR, goalId);
}

export function getWorkspaceGoalValidationDir(projectName: string, workspaceName: string): string {
  assertSafeSegment(workspaceName, 'workspaceName');
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  return join(getWorkspaceStorageDir(workspaceDir, workspaceName), WORKSPACE_GOAL_VALIDATION_DIR);
}

export function getGoalValidationDir(projectName: string, goal: GoalRecord): string {
  if (goal.workspaceName) {
    return getWorkspaceGoalValidationDir(projectName, goal.workspaceName);
  }
  return getPlannedGoalValidationDir(projectName, goal.id);
}

function ensureValidationDir(projectName: string, goal: GoalRecord): string {
  const validationDir = getGoalValidationDir(projectName, goal);
  if (goal.workspaceName) {
    const workspaceDir = join(getProjectWorkspacesDir(projectName), goal.workspaceName);
    ensureWorkspaceStorageIgnored(workspaceDir);
  }
  ensureDir(join(validationDir, VALIDATION_ARTIFACTS_DIR));
  return validationDir;
}

// ─── Defaults + id helpers ─────────────────────────────────────────────────

export function defaultValidation(): GoalValidation {
  return {
    reqOrder: [],
    requirements: {},
    events: [],
  };
}

const REQUIREMENT_KINDS: ArtifactKind[] = ['screenshot', 'video', 'test-output', 'note', 'file', 'url'];

function assertKind(kind: ArtifactKind): void {
  if (!REQUIREMENT_KINDS.includes(kind)) {
    throw new SpacesError(`Invalid requirement kind: ${kind}`, 'USER_ERROR', 1);
  }
}

function assertGeneration(generation: Generation): void {
  if (generation.kind !== 'manual' && generation.kind !== 'command') {
    throw new SpacesError(`Invalid generation kind: ${(generation as { kind: string }).kind}`, 'USER_ERROR', 1);
  }
  if (generation.kind === 'command' && !generation.command.trim()) {
    throw new SpacesError('Command generation requires a command.', 'USER_ERROR', 1);
  }
}

function assertJudgment(judgment: Judgment, generation: Generation): void {
  if (judgment.kind !== 'human' && judgment.kind !== 'llm' && judgment.kind !== 'command') {
    throw new SpacesError(`Invalid judgment kind: ${(judgment as { kind: string }).kind}`, 'USER_ERROR', 1);
  }
  if (judgment.kind === 'command') {
    // Same-run judging: no judge command is fine when the generation is a
    // command — expect is applied to the generation run itself.
    if (!judgment.command?.trim() && generation.kind !== 'command') {
      throw new SpacesError('Command judgment requires a command (omitting it — same-run judging — needs command generation).', 'USER_ERROR', 1);
    }
    if (!['exit-zero', 'stdout-contains', 'stderr-empty', 'output-matches'].includes(judgment.expect.kind)) {
      throw new SpacesError(`Invalid expect kind: ${judgment.expect.kind}`, 'USER_ERROR', 1);
    }
  }
}

function nextRequirementId(title: string): string {
  const base = sanitizeForFileSystem(title).slice(0, 40) || 'req';
  return `req-${base}-${generateId().slice(0, 8)}`;
}

function nextEvidenceId(): string {
  return `ev-${generateId().slice(0, 10)}`;
}

function nextReviewId(): string {
  return `rv-${generateId().slice(0, 10)}`;
}

function nextEventId(): string {
  return `evt-${generateId().slice(0, 10)}`;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function withRequirement(
  validation: GoalValidation,
  requirementId: string,
  update: (r: Requirement) => Requirement,
): { validation: GoalValidation; requirement: Requirement } {
  const cur = validation.requirements[requirementId];
  if (!cur) {
    throw new SpacesError(`Unknown requirement: ${requirementId}`, 'USER_ERROR', 1);
  }
  const requirement = update(cur);
  return {
    validation: {
      ...validation,
      requirements: { ...validation.requirements, [requirementId]: requirement },
    },
    requirement,
  };
}

/** Workspace/goal shape sufficient to resolve the open journal phase. */
export type GoalPhaseContext = Pick<GoalRecord, 'projectName' | 'workspaceName'>;

/**
 * Journal phase currently OPEN for this goal's workspace (phase-journal
 * join). Undefined for planned goals, workspaces without an artifacts
 * mount, or outside any phase.
 */
export function getOpenPhaseForGoal(goal: GoalPhaseContext): string | undefined {
  if (!goal.workspaceName) return undefined;
  try {
    const workspaceDir = join(getProjectWorkspacesDir(goal.projectName), goal.workspaceName);
    return getOpenJournalPhase(workspaceDir) ?? undefined;
  } catch {
    return undefined;
  }
}

function appendEvent(
  validation: GoalValidation,
  partial: Omit<TimelineEvent, 'id' | 'createdAt'>,
  phase?: string,
): GoalValidation {
  const event: TimelineEvent = {
    ...partial,
    ...(phase ? { phase } : {}),
    id: nextEventId(),
    createdAt: nowIso(),
  };
  return { ...validation, events: [...validation.events, event] };
}

/**
 * Phase divider event for the goal timeline (phase-journal join). Appended
 * by `space journal phase-start` / `phase-end` when the workspace has a goal.
 */
export function appendPhaseMarkerEvent(
  validation: GoalValidation,
  phase: string,
  action: 'started' | 'ended',
  note = '',
): GoalValidation {
  return appendEvent(validation, {
    requirementId: null,
    tone: 'violet',
    kind: 'phase',
    title: `phase ${action}: ${phase}`,
    body: note,
    payload: `phase.${action}\n  phase: ${phase}`,
  }, phase);
}

function inferMimeType(sourcePath: string, kind: ArtifactKind): string | undefined {
  const ext = extname(sourcePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.json') return 'application/json';
  if (ext === '.md') return 'text/markdown';
  if (kind === 'screenshot') return 'image/*';
  if (kind === 'video') return 'video/*';
  return undefined;
}

function copyEvidenceFile(
  validationDir: string,
  evidenceId: string,
  sourcePath: string,
  kind: ArtifactKind,
): Pick<Evidence, 'artifactPath' | 'mimeType' | 'sizeBytes' | 'displayName' | 'previewUrl' | 'body'> {
  if (!existsSync(sourcePath)) {
    throw new SpacesError(`Evidence file does not exist: ${sourcePath}`, 'USER_ERROR', 1);
  }
  const displayName = basename(sourcePath);
  const safeName = sanitizeForFileSystem(displayName) || 'artifact';
  const relativePath = join(VALIDATION_ARTIFACTS_DIR, `${evidenceId}-${safeName}`);
  const targetPath = join(validationDir, relativePath);
  ensureParentDir(targetPath);
  copyFileSync(sourcePath, targetPath);
  const mimeType = inferMimeType(sourcePath, kind);
  const bytes = readFileSync(sourcePath);
  const previewUrl = mimeType && (mimeType.startsWith('image/') || mimeType.startsWith('video/'))
    ? `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
    : undefined;
  const body = !previewUrl && mimeType?.startsWith('text/') ? bytes.toString('utf-8') : undefined;
  return {
    artifactPath: relativePath,
    mimeType,
    sizeBytes: statSync(sourcePath).size,
    displayName,
    previewUrl,
    body,
  };
}

/**
 * Store an evidence binary. Preferred home: the goal's artifacts mount
 * (docs/ARTIFACTS-FS.md — workspace goals → the workspace's artifacts branch,
 * planned goals → the base clone's main mount) as a committed capture with
 * git-notes provenance. Falls back to the legacy validation-dir copy when no
 * mount exists (pre-artifacts workspaces).
 */
function storeEvidenceFile(
  projectName: string,
  goal: GoalRecord,
  validationDir: string,
  evidenceId: string,
  sourcePath: string,
  kind: ArtifactKind,
): Pick<Evidence, 'artifactPath' | 'mimeType' | 'sizeBytes' | 'displayName' | 'previewUrl' | 'body'> {
  if (!existsSync(sourcePath)) {
    throw new SpacesError(`Evidence file does not exist: ${sourcePath}`, 'USER_ERROR', 1);
  }
  const root = goal.workspaceName
    ? join(getProjectWorkspacesDir(projectName), goal.workspaceName)
    : getProjectBaseDir(projectName);
  const scope = artifactsScope(root);
  const mountDir = scope.mountDir;
  if (!existsSync(join(mountDir, '.git'))) {
    return copyEvidenceFile(validationDir, evidenceId, sourcePath, kind);
  }
  const displayName = basename(sourcePath);
  const safeName = sanitizeForFileSystem(displayName) || 'artifact';
  // Evidence is goal provenance — `goals/<goal-id>/validation/...` for a
  // workspace, or `validation/<goal-id>/...` at root for a planned goal
  // evidenced from the base clone (which owns no goal folder).
  const relativePath = scope.rel(`validation/${goal.id}/${evidenceId}-${safeName}`);
  captureArtifactsSync(getProjectDir(projectName), mountDir, [{ path: relativePath, sourceFile: sourcePath }], {
    message: `evidence: ${goal.id} ${displayName}`,
    provenance: {
      goal: goal.id,
      workspace: goal.workspaceName ?? undefined,
      tool: 'goal-validation',
      evidence: evidenceId,
    },
  });
  const mimeType = inferMimeType(sourcePath, kind);
  const bytes = readFileSync(sourcePath);
  const previewUrl = mimeType && (mimeType.startsWith('image/') || mimeType.startsWith('video/'))
    ? `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`
    : undefined;
  const body = !previewUrl && mimeType?.startsWith('text/') ? bytes.toString('utf-8') : undefined;
  return {
    artifactPath: relativePath,
    mimeType,
    sizeBytes: statSync(sourcePath).size,
    displayName,
    previewUrl,
    body,
  };
}

/** Parse an optional `score: N` line (0-100) out of judgment text. */
function parseScoreLine(text: string): number | undefined {
  const match = /^\s*score:\s*(\d{1,3})\s*$/im.exec(text);
  if (!match) return undefined;
  const score = Number(match[1]);
  if (!Number.isFinite(score) || score < 0 || score > 100) return undefined;
  return score;
}

function truncate(value: string): string {
  const MAX = 32_000;
  if (value.length <= MAX) return value;
  return `${value.slice(0, MAX)}\n...[truncated ${value.length - MAX} chars]`;
}

function commandPasses(judgment: Judgment & { kind: 'command' }, exitCode: number, stdout: string, stderr: string): boolean {
  const expect = judgment.expect;
  if (expect.kind === 'exit-zero') return exitCode === 0;
  if (expect.kind === 'stdout-contains') return stdout.includes(expect.needle);
  if (expect.kind === 'stderr-empty') return stderr.trim() === '';
  if (expect.kind === 'output-matches') return new RegExp(expect.pattern).test(stdout);
  return false;
}

function describeExpectSatisfied(expect: CommandExpectation): string {
  if (expect.kind === 'exit-zero') return 'exit-zero satisfied (exit code 0).';
  if (expect.kind === 'stdout-contains') return `stdout contains "${expect.needle}".`;
  if (expect.kind === 'stderr-empty') return 'stderr-empty satisfied.';
  return `stdout matches /${expect.pattern}/.`;
}

function describeExpectFailed(expect: CommandExpectation, exitCode: number): string {
  if (expect.kind === 'exit-zero') return `exit-zero not satisfied (exit code ${exitCode}).`;
  if (expect.kind === 'stdout-contains') return `stdout does not contain "${expect.needle}".`;
  if (expect.kind === 'stderr-empty') return 'stderr is not empty.';
  return `stdout does not match /${expect.pattern}/.`;
}

function describeGenerationSummary(generation: Generation): string {
  return generation.kind === 'manual' ? 'manual' : `command (${generation.command})`;
}

function describeJudgmentSummary(judgment: Judgment, generation?: Generation): string {
  if (judgment.kind === 'human') return 'human';
  if (judgment.kind === 'llm') return judgment.modelHint ? `llm (${judgment.modelHint})` : 'llm';
  const sameRun = generation ? isSameRunJudgment({ generation, judgment }) : false;
  return `command · ${sameRun ? 'same-run · ' : ''}${judgment.expect.kind}`;
}

function contractAddedPayload(requirement: Requirement): string {
  const lines = [
    'contract.requirement.added',
    `  id: ${requirement.id}`,
    `  kind: ${requirement.kind}`,
    `  gen: ${requirement.generation.kind}`,
  ];
  if (requirement.generation.kind === 'command') lines.push(`  gen.command: ${requirement.generation.command}`);
  lines.push(`  jud: ${requirement.judgment.kind}`);
  if (requirement.judgment.kind === 'command') {
    lines.push(`  jud.command: ${requirement.judgment.command}`);
    lines.push(`  jud.expect: ${requirement.judgment.expect.kind}`);
    if (isSameRunJudgment(requirement)) lines.push('  jud.mode: same-run');
  }
  if (requirement.judgment.kind === 'llm' && requirement.judgment.modelHint) {
    lines.push(`  jud.model: ${requirement.judgment.modelHint}`);
  }
  if (requirement.wfPhase) lines.push(`  wfPhase: ${requirement.wfPhase}`);
  if (requirement.sliceId) lines.push(`  slice: ${requirement.sliceId}`);
  return lines.join('\n');
}

function deriveEvidenceMeta(
  input: { url?: string; body?: string },
  copied: Pick<Evidence, 'sizeBytes' | 'mimeType'>,
): string {
  if (input.url) return input.url;
  if (copied.sizeBytes !== undefined) {
    return `${copied.mimeType ?? 'file'} · ${(copied.sizeBytes / 1024).toFixed(1)} KB`;
  }
  if (input.body) return 'inline note';
  return 'evidence';
}

function artifactNameForKind(kind: ArtifactKind): string {
  if (kind === 'screenshot') return 'shot.png';
  if (kind === 'video') return 'recording.webm';
  if (kind === 'test-output') return 'test-output.txt';
  if (kind === 'file') return 'artifact';
  if (kind === 'url') return 'link';
  return 'note';
}

function validateAttachInputAgainstKind(kind: ArtifactKind, input: AttachEvidenceInput): void {
  if (kind === 'url') {
    if (!input.url?.trim()) throw new SpacesError('URL evidence requires a url.', 'USER_ERROR', 1);
    return;
  }
  if (kind === 'note') {
    if (!input.body?.trim()) throw new SpacesError('Note evidence requires inline body text.', 'USER_ERROR', 1);
    return;
  }
  if (kind === 'screenshot' || kind === 'video' || kind === 'file') {
    if (!input.path?.trim()) {
      throw new SpacesError(`${kind} evidence requires a local path.`, 'USER_ERROR', 1);
    }
    return;
  }
  if (kind === 'test-output') {
    if (!input.body?.trim() && !input.path?.trim()) {
      throw new SpacesError('Test-output evidence requires a path or body.', 'USER_ERROR', 1);
    }
  }
}

// ─── Public mutations: contract ─────────────────────────────────────────────

export interface AddRequirementInput {
  title: string;
  kind: ArtifactKind;
  rubric: string;
  required?: boolean;
  generation: Generation;
  judgment: Judgment;
  /** Goal-doc slice this requirement grounds itself in (heading slug —
   *  core/goal-workflow.ts parseDocSlices). Dangling ids are amber state. */
  sliceId?: string;
  /** Workflow phase that OWES this requirement (gate join). Overrides the
   *  open-journal-phase default when set explicitly at authoring time. */
  wfPhase?: string;
}

export function addRequirement(
  validation: GoalValidation,
  input: AddRequirementInput,
  ctx?: GoalPhaseContext,
): { validation: GoalValidation; requirement: Requirement } {
  const title = input.title.trim();
  if (!title) throw new SpacesError('Title is required.', 'USER_ERROR', 1);
  if (!input.rubric.trim()) throw new SpacesError('Rubric is required.', 'USER_ERROR', 1);
  assertKind(input.kind);
  assertGeneration(input.generation);
  assertJudgment(input.judgment, input.generation);

  const openPhase = ctx ? getOpenPhaseForGoal(ctx) : undefined;
  const phase = input.wfPhase?.trim() || openPhase;
  const id = nextRequirementId(title);
  const requirement: Requirement = {
    id,
    title,
    kind: input.kind,
    required: input.required ?? true,
    rubric: input.rubric.trim(),
    status: 'missing',
    generation: input.generation,
    judgment: input.judgment,
    evidence: [],
    reviews: [],
    ...(phase ? { wfPhase: phase } : {}),
    ...(input.sliceId?.trim() ? { sliceId: input.sliceId.trim() } : {}),
  };
  let next: GoalValidation = {
    ...validation,
    reqOrder: [...validation.reqOrder, id],
    requirements: { ...validation.requirements, [id]: requirement },
  };
  next = appendEvent(next, {
    requirementId: id,
    tone: 'blue',
    kind: 'contract',
    title: `Requirement added: ${title}`,
    body: `Produced by ${describeGenerationSummary(input.generation)}; judged by ${describeJudgmentSummary(input.judgment, input.generation)}.`,
    payload: contractAddedPayload(requirement),
  }, openPhase);
  return { validation: next, requirement };
}

export interface UpdateRequirementInput {
  title?: string;
  kind?: ArtifactKind;
  rubric?: string;
  required?: boolean;
  generation?: Generation;
  judgment?: Judgment;
}

export function updateRequirement(
  validation: GoalValidation,
  requirementId: string,
  patch: UpdateRequirementInput,
  ctx?: GoalPhaseContext,
): { validation: GoalValidation; requirement: Requirement } {
  const { validation: nextRequirements, requirement } = withRequirement(validation, requirementId, (r) => {
    const merged: Requirement = {
      ...r,
      title: patch.title?.trim() ?? r.title,
      kind: patch.kind ?? r.kind,
      rubric: patch.rubric?.trim() ?? r.rubric,
      required: patch.required ?? r.required,
      generation: patch.generation ?? r.generation,
      judgment: patch.judgment ?? r.judgment,
    };
    if (!merged.title) throw new SpacesError('Title is required.', 'USER_ERROR', 1);
    if (!merged.rubric) throw new SpacesError('Rubric is required.', 'USER_ERROR', 1);
    assertKind(merged.kind);
    assertGeneration(merged.generation);
    assertJudgment(merged.judgment, merged.generation);
    return merged;
  });
  const next = appendEvent(nextRequirements, {
    requirementId,
    tone: 'blue',
    kind: 'contract',
    title: `Requirement edited: ${requirement.title}`,
    body: 'Contract changed.',
    payload: `contract.requirement.updated\n  id: ${requirementId}`,
  }, ctx ? getOpenPhaseForGoal(ctx) : undefined);
  return { validation: next, requirement };
}

export function removeRequirement(
  validation: GoalValidation,
  requirementId: string,
  ctx?: GoalPhaseContext,
): GoalValidation {
  const cur = validation.requirements[requirementId];
  if (!cur) throw new SpacesError(`Unknown requirement: ${requirementId}`, 'USER_ERROR', 1);
  const remaining = { ...validation.requirements };
  delete remaining[requirementId];
  let next: GoalValidation = {
    ...validation,
    reqOrder: validation.reqOrder.filter((id) => id !== requirementId),
    requirements: remaining,
  };
  next = appendEvent(next, {
    requirementId,
    tone: 'blue',
    kind: 'contract',
    title: `Requirement removed: ${cur.title}`,
    body: 'Contract changed.',
    payload: `contract.requirement.removed\n  id: ${requirementId}`,
  }, ctx ? getOpenPhaseForGoal(ctx) : undefined);
  return next;
}

export function reorderRequirement(
  validation: GoalValidation,
  requirementId: string,
  position: number,
): GoalValidation {
  const idx = validation.reqOrder.indexOf(requirementId);
  if (idx < 0) throw new SpacesError(`Unknown requirement: ${requirementId}`, 'USER_ERROR', 1);
  const clamped = Math.max(0, Math.min(validation.reqOrder.length - 1, position));
  if (idx === clamped) return validation;
  const reqOrder = [...validation.reqOrder];
  reqOrder.splice(idx, 1);
  reqOrder.splice(clamped, 0, requirementId);
  return { ...validation, reqOrder };
}

// ─── Public mutations: fulfillment ──────────────────────────────────────────

export interface AttachEvidenceInput {
  name?: string;
  body?: string;
  url?: string;
  path?: string;
}

export function attachManualEvidence(
  projectName: string,
  goal: GoalRecord,
  requirementId: string,
  input: AttachEvidenceInput,
): { goal: GoalRecord; requirement: Requirement; evidence: Evidence } {
  const cur = goal.validation.requirements[requirementId];
  if (!cur) throw new SpacesError(`Unknown requirement: ${requirementId}`, 'USER_ERROR', 1);
  validateAttachInputAgainstKind(cur.kind, input);

  const validationDir = ensureValidationDir(projectName, goal);
  const evidenceId = nextEvidenceId();
  const copied = input.path ? storeEvidenceFile(projectName, goal, validationDir, evidenceId, input.path, cur.kind) : {};
  const evidence: Evidence = {
    id: evidenceId,
    name: input.name?.trim() || (input.path ? basename(input.path) : cur.title),
    meta: deriveEvidenceMeta(input, copied),
    source: 'manual',
    createdAt: nowIso(),
    body: input.body ?? copied.body,
    url: input.url,
    originalPath: input.path,
    artifactPath: copied.artifactPath,
    mimeType: copied.mimeType ?? (input.path ? inferMimeType(input.path, cur.kind) : undefined),
    sizeBytes: copied.sizeBytes,
    displayName: copied.displayName,
    previewUrl: copied.previewUrl,
  };

  const { validation: nextValidation, requirement } = withRequirement(goal.validation, requirementId, (r) => ({
    ...r,
    evidence: [...r.evidence, evidence],
    status: 'review',
  }));
  const withEvent = appendEvent(nextValidation, {
    requirementId,
    tone: 'amber',
    kind: 'generation',
    title: `Manual evidence attached: ${evidence.name}`,
    body: `Awaiting ${cur.judgment.kind} judgment on ${cur.title}.`,
    payload: `generation.manual\n  requirement: ${requirementId}\n  artifact: ${evidence.name}`,
  }, getOpenPhaseForGoal(goal));
  return {
    goal: { ...goal, validation: withEvent, updatedAt: nowIso() },
    requirement,
    evidence,
  };
}

export function runGenerationCommand(
  projectName: string,
  goal: GoalRecord,
  requirementId: string,
): { goal: GoalRecord; requirement: Requirement; evidence: Evidence; autoAccepted: boolean } {
  const cur = goal.validation.requirements[requirementId];
  if (!cur) throw new SpacesError(`Unknown requirement: ${requirementId}`, 'USER_ERROR', 1);
  if (cur.generation.kind !== 'command') {
    throw new SpacesError('Generation is not command-based for this requirement.', 'USER_ERROR', 1);
  }
  if (!goal.workspaceName) {
    throw new SpacesError('Generation commands require a workspace-backed goal.', 'USER_ERROR', 1);
  }
  const cwd = join(getProjectWorkspacesDir(projectName), goal.workspaceName);
  if (!existsSync(cwd)) {
    throw new SpacesError(`Workspace directory does not exist: ${cwd}`, 'USER_ERROR', 1);
  }
  const command = cur.generation.command;
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 8 });
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const stdout = truncate(result.stdout ?? '');
  const stderr = truncate(result.stderr ?? (result.error ? String(result.error) : ''));
  const evidenceId = nextEvidenceId();
  const artifactName = artifactNameForKind(cur.kind);
  const evidence: Evidence = {
    id: evidenceId,
    name: artifactName,
    meta: cur.kind === 'test-output' ? `exit ${exitCode}` : `produced by ${command.split(/\s+/)[0]}`,
    source: 'command',
    createdAt: nowIso(),
    command,
    exitCode,
    stdout,
    stderr,
  };
  let autoAccepted = false;
  const { validation: nextValidation, requirement } = withRequirement(goal.validation, requirementId, (r) => {
    let status: RequirementStatus = 'review';
    const reviews = [...r.reviews];
    if (r.judgment.kind === 'command' && commandPasses(r.judgment, exitCode, stdout, stderr)) {
      autoAccepted = true;
      status = 'accepted';
      reviews.push({
        id: nextReviewId(),
        tone: 'green',
        who: 'command',
        note: describeExpectSatisfied(r.judgment.expect),
        createdAt: nowIso(),
        judgeType: 'command',
        score: 100,
        cites: [evidence.id],
        rubricHash: hashRubric(r.rubric),
      });
    }
    return { ...r, evidence: [...r.evidence, evidence], status, reviews };
  });
  const phase = getOpenPhaseForGoal(goal);
  let withEvents: GoalValidation = appendEvent(nextValidation, {
    requirementId,
    tone: 'violet',
    kind: 'generation',
    title: `Command produced evidence: ${cur.title}`,
    body: command,
    payload: `generation.command.ran\n  requirement: ${requirementId}\n  command: ${command}\n  exit: ${exitCode}\n  artifact: ${artifactName}`,
  }, phase);
  if (autoAccepted && cur.judgment.kind === 'command') {
    withEvents = appendEvent(withEvents, {
      requirementId,
      tone: 'green',
      kind: 'review',
      title: `Command check passed: ${cur.title}`,
      body: describeExpectSatisfied(cur.judgment.expect),
      payload: `review.passed\n  requirement: ${requirementId}\n  judge: command\n  expect: ${cur.judgment.expect.kind}`,
    }, phase);
  }
  return {
    goal: { ...goal, validation: withEvents, updatedAt: nowIso() },
    requirement,
    evidence,
    autoAccepted,
  };
}

export function runJudgmentCommand(
  projectName: string,
  goal: GoalRecord,
  requirementId: string,
): { goal: GoalRecord; requirement: Requirement; review: Review } {
  const cur = goal.validation.requirements[requirementId];
  if (!cur) throw new SpacesError(`Unknown requirement: ${requirementId}`, 'USER_ERROR', 1);
  if (cur.judgment.kind !== 'command') {
    throw new SpacesError('Judgment is not command-based for this requirement.', 'USER_ERROR', 1);
  }
  const expect = cur.judgment.expect;
  const sameRun = isSameRunJudgment(cur);
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  let cites: string[];
  let payloadExtra = '';
  let noteSuffix = '';
  if (sameRun) {
    // Same-run judgment (gen==judge dedup): never re-execute — apply expect
    // to the latest generation run's captured evidence.
    const latest = [...cur.evidence].reverse().find((e) => e.source === 'command' && e.exitCode !== undefined);
    if (!latest) {
      throw new SpacesError(
        `No generation run to judge yet — run \`space goal artifact run --requirement ${requirementId}\` first (same-run judgment judges the generation run instead of re-executing).`,
        'USER_ERROR',
        1,
      );
    }
    exitCode = latest.exitCode ?? 1;
    stdout = latest.stdout ?? '';
    stderr = latest.stderr ?? '';
    cites = [latest.id];
    payloadExtra = `\n  mode: same-run\n  evidence: ${latest.id}`;
    noteSuffix = ` Judged generation run ${latest.id} (same-run; command not re-executed).`;
  } else {
    if (!goal.workspaceName) {
      throw new SpacesError('Judgment commands require a workspace-backed goal.', 'USER_ERROR', 1);
    }
    const cwd = join(getProjectWorkspacesDir(projectName), goal.workspaceName);
    if (!existsSync(cwd)) {
      throw new SpacesError(`Workspace directory does not exist: ${cwd}`, 'USER_ERROR', 1);
    }
    const result = spawnSync(cur.judgment.command, { cwd, shell: true, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 8 });
    exitCode = typeof result.status === 'number' ? result.status : 1;
    stdout = truncate(result.stdout ?? '');
    stderr = truncate(result.stderr ?? (result.error ? String(result.error) : ''));
    cites = cur.evidence.map((e) => e.id);
  }
  const passed = commandPasses(cur.judgment, exitCode, stdout, stderr);
  const note = `${passed ? describeExpectSatisfied(expect) : describeExpectFailed(expect, exitCode)}${noteSuffix}`;
  const tone: ReviewTone = passed ? 'green' : 'red';
  const review: Review = {
    id: nextReviewId(),
    tone,
    who: 'command',
    note,
    createdAt: nowIso(),
    judgeType: 'command',
    score: passed ? 100 : 0,
    cites,
    rubricHash: hashRubric(cur.rubric),
  };
  const { validation: nextValidation, requirement } = withRequirement(goal.validation, requirementId, (r) => ({
    ...r,
    reviews: [...r.reviews, review],
    status: passed ? 'accepted' : 'review',
  }));
  const withEvent = appendEvent(nextValidation, {
    requirementId,
    tone,
    kind: 'review',
    title: `Command check ${passed ? 'passed' : 'failed'}: ${cur.title}`,
    body: note,
    payload: `review.${passed ? 'passed' : 'failed'}\n  requirement: ${requirementId}\n  judge: command\n  expect: ${expect.kind}\n  exit: ${exitCode}${payloadExtra}`,
  }, getOpenPhaseForGoal(goal));
  return {
    goal: { ...goal, validation: withEvent, updatedAt: nowIso() },
    requirement,
    review,
  };
}

export function runLlmJudgment(
  goal: GoalRecord,
  requirementId: string,
): { goal: GoalRecord; requirement: Requirement; review: Review } {
  const cur = goal.validation.requirements[requirementId];
  if (!cur) throw new SpacesError(`Unknown requirement: ${requirementId}`, 'USER_ERROR', 1);
  if (cur.judgment.kind !== 'llm') {
    throw new SpacesError('Judgment is not LLM-based for this requirement.', 'USER_ERROR', 1);
  }
  // LLM runner not yet implemented. Record an honest "unavailable" review
  // rather than fabricating a pass.
  const judgmentText = 'LLM judgment runner is not yet implemented. Apply the rubric manually or wire an LLM backend.';
  const review: Review = {
    id: nextReviewId(),
    tone: 'amber',
    who: cur.judgment.modelHint || 'llm',
    note: judgmentText,
    createdAt: nowIso(),
    judgeType: 'llm',
    // When a real runner lands, its output may carry a "score: N" line.
    score: parseScoreLine(judgmentText),
    rubricHash: hashRubric(cur.rubric),
    cites: cur.evidence.map((e) => e.id),
  };
  const { validation: nextValidation, requirement } = withRequirement(goal.validation, requirementId, (r) => ({
    ...r,
    reviews: [...r.reviews, review],
    status: 'review',
  }));
  const withEvent = appendEvent(nextValidation, {
    requirementId,
    tone: 'amber',
    kind: 'review',
    title: `LLM judgment unavailable: ${cur.title}`,
    body: review.note,
    payload: `review.llm.unavailable\n  requirement: ${requirementId}\n  model: ${cur.judgment.modelHint || 'runner default'}`,
  }, getOpenPhaseForGoal(goal));
  return {
    goal: { ...goal, validation: withEvent, updatedAt: nowIso() },
    requirement,
    review,
  };
}

export type HumanReviewDecision = 'pass' | 'changes' | 'fail';

/** Canon pin: hash of a requirement's rubric text (docs/REVIEW-GUIDE.md). */
export function hashRubric(rubric: string): string {
  return `sha256:${createHash('sha256').update(rubric.trim()).digest('hex').slice(0, 16)}`;
}

/**
 * A requirement's acceptance is stale when the rubric changed after the
 * accepting judgment was recorded (accepted-at-hash ≠ current hash).
 * Unpinned legacy acceptances are never reported stale.
 */
export function isAcceptanceStale(requirement: import('../types/goals.js').Requirement): boolean {
  if (requirement.status !== 'accepted') return false;
  const accepting = [...(requirement.reviews ?? [])].reverse().find((r) => r.tone === 'green' && r.rubricHash);
  if (!accepting?.rubricHash) return false;
  return accepting.rubricHash !== hashRubric(requirement.rubric);
}

export function recordHumanReview(
  goal: GoalRecord,
  requirementId: string,
  decision: HumanReviewDecision,
  note: string,
  score?: number,
  createdBy?: string,
): { goal: GoalRecord; requirement: Requirement; review: Review } {
  const cur = goal.validation.requirements[requirementId];
  if (!cur) throw new SpacesError(`Unknown requirement: ${requirementId}`, 'USER_ERROR', 1);
  if (cur.judgment.kind !== 'human') {
    throw new SpacesError('Judgment is not human for this requirement.', 'USER_ERROR', 1);
  }
  const trimmed = note.trim();
  if ((decision === 'fail' || decision === 'changes') && !trimmed) {
    throw new SpacesError('A note is required to fail or request changes.', 'USER_ERROR', 1);
  }
  if (score !== undefined && (!Number.isFinite(score) || score < 0 || score > 100)) {
    throw new SpacesError('Score must be a number between 0 and 100.', 'USER_ERROR', 1);
  }
  const tone: ReviewTone = decision === 'pass' ? 'green' : decision === 'changes' ? 'amber' : 'red';
  const review: Review = {
    id: nextReviewId(),
    tone,
    who: 'human',
    note: trimmed || 'Accepted.',
    createdAt: nowIso(),
    createdBy,
    judgeType: 'human',
    score,
    rubricHash: hashRubric(cur.rubric),
  };
  const { validation: nextValidation, requirement } = withRequirement(goal.validation, requirementId, (r) => {
    let status: RequirementStatus;
    let evidence = r.evidence;
    if (decision === 'pass') status = 'accepted';
    else if (decision === 'fail') { status = 'missing'; evidence = []; }
    else status = 'review';
    return { ...r, reviews: [...r.reviews, review], status, evidence };
  });
  const withEvent = appendEvent(nextValidation, {
    requirementId,
    tone,
    kind: 'review',
    title: `Human review ${decision === 'pass' ? 'passed' : decision === 'changes' ? 'needs changes' : 'failed'}: ${cur.title}`,
    body: review.note,
    payload: `review.${decision === 'pass' ? 'passed' : decision === 'changes' ? 'needs_changes' : 'failed'}\n  requirement: ${requirementId}\n  judge: human${createdBy ? `\n  by: ${createdBy}` : ''}`,
  }, getOpenPhaseForGoal(goal));
  return {
    goal: { ...goal, validation: withEvent, updatedAt: nowIso() },
    requirement,
    review,
  };
}

export type Verdict = 'accept' | 'reject';

/**
 * In-phase judging (goal-rubric-workflow interconnect): a reviewer — agent
 * applying an llm-kind rubric, or a human — records an accept/reject verdict
 * against a requirement. Command-kind judgments auto-judge on `review run`
 * and are refused here. Accept pins the rubric hash (canon pin) and flips
 * the requirement to accepted, which is what computed phase gates count.
 */
export function recordRequirementVerdict(
  goal: GoalRecord,
  requirementId: string,
  verdict: Verdict,
  notes: string,
  createdBy?: string,
): { goal: GoalRecord; requirement: Requirement; review: Review } {
  const cur = goal.validation.requirements[requirementId];
  if (!cur) throw new SpacesError(`Unknown requirement: ${requirementId}`, 'USER_ERROR', 1);
  if (cur.judgment.kind === 'command') {
    throw new SpacesError('Command-judged requirements auto-judge via `space goal review run`, not verdict.', 'USER_ERROR', 1);
  }
  const trimmed = notes.trim();
  if (!trimmed) {
    throw new SpacesError('--notes is required: say what the verdict is grounded in.', 'USER_ERROR', 1);
  }
  const tone: ReviewTone = verdict === 'accept' ? 'green' : 'red';
  const review: Review = {
    id: nextReviewId(),
    tone,
    who: cur.judgment.kind === 'llm' ? (cur.judgment.modelHint || 'llm') : 'human',
    note: trimmed,
    createdAt: nowIso(),
    createdBy,
    judgeType: cur.judgment.kind,
    cites: cur.evidence.map((e) => e.id),
    rubricHash: hashRubric(cur.rubric),
  };
  const { validation: nextValidation, requirement } = withRequirement(goal.validation, requirementId, (r) => ({
    ...r,
    reviews: [...r.reviews, review],
    status: verdict === 'accept' ? 'accepted' : 'review',
  }));
  const withEvent = appendEvent(nextValidation, {
    requirementId,
    tone,
    kind: 'review',
    title: `Verdict ${verdict === 'accept' ? 'accepted' : 'rejected'}: ${cur.title}`,
    body: review.note,
    payload: `review.verdict.${verdict === 'accept' ? 'accepted' : 'rejected'}\n  requirement: ${requirementId}\n  judge: ${cur.judgment.kind}${createdBy ? `\n  by: ${createdBy}` : ''}`,
  }, getOpenPhaseForGoal(goal));
  return {
    goal: { ...goal, validation: withEvent, updatedAt: nowIso() },
    requirement,
    review,
  };
}

// ─── Gate events (goal-rubric-workflow interconnect) ────────────────────────

/**
 * Human-only gate waive event. Appended by the daemon 'goal-gate-waive'
 * command (UI seam) — never by the CLI. The waived phase lives in the
 * payload (`phase: <name>`), which is what gateStatusForPhase matches on;
 * the event's `phase` stamp is also set to that phase for timeline grouping.
 */
export function appendGateWaiveEvent(
  validation: GoalValidation,
  phase: string,
  reason: string,
  actor = 'human/ui',
): GoalValidation {
  return appendEvent(validation, {
    requirementId: null,
    tone: 'amber',
    kind: 'gate',
    title: `gate waived: ${phase}`,
    body: reason,
    payload: `gate.waived\n  phase: ${phase}\n  actor: ${actor}\n  reason: ${reason}`,
  }, phase);
}

/** Gate escape hatch #2: the phase was reverted (requirements need rewrite —
 *  typically back to plan). Allowed without a satisfied gate; the gate stays
 *  red and the journal entry closes marked reverted. */
export function appendGateRevertEvent(
  validation: GoalValidation,
  fromPhase: string,
  toTarget: string,
  reason: string,
): GoalValidation {
  return appendEvent(validation, {
    requirementId: null,
    tone: 'red',
    kind: 'gate',
    title: `phase reverted → ${toTarget}`,
    body: reason,
    payload: `gate.reverted\n  phase: ${fromPhase}\n  to: ${toTarget}\n  reason: ${reason}`,
  }, fromPhase);
}

export function reopenRequirement(
  goal: GoalRecord,
  requirementId: string,
): { goal: GoalRecord; requirement: Requirement } {
  const { validation: nextValidation, requirement } = withRequirement(goal.validation, requirementId, (r) => ({
    ...r,
    status: 'review',
  }));
  const withEvent = appendEvent(nextValidation, {
    requirementId,
    tone: 'amber',
    kind: 'review',
    title: `Review reopened: ${requirement.title}`,
    body: 'Previously accepted; reopened for re-review.',
    payload: `review.reopened\n  requirement: ${requirementId}`,
  }, getOpenPhaseForGoal(goal));
  return {
    goal: { ...goal, validation: withEvent, updatedAt: nowIso() },
    requirement,
  };
}

// ─── Migration from legacy v1 goal records ─────────────────────────────────

interface LegacyRequirement {
  id?: string;
  kind?: string;
  title?: string;
  description?: string;
  required?: boolean;
}
interface LegacyJudgmentPlan {
  type?: 'human' | 'llm';
  humanInstructions?: string;
  llmPrompt?: string;
}
interface LegacyValidation {
  criteria?: string[];
  artifactRequirements?: LegacyRequirement[];
  judgmentPlan?: LegacyJudgmentPlan;
  commands?: string[];
}
type LegacyGoalRecord = Omit<GoalRecord, 'version' | 'validation'> & {
  version?: number;
  validation?: LegacyValidation | GoalValidation;
};

const LEGACY_KIND_MAP: Record<string, ArtifactKind> = {
  image: 'screenshot',
  'manual-note': 'note',
  text: 'note',
  log: 'note',
  screenshot: 'screenshot',
  video: 'video',
  'test-output': 'test-output',
  note: 'note',
  file: 'file',
  url: 'url',
};

function isNewValidationShape(value: unknown): value is GoalValidation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<GoalValidation>;
  return Array.isArray(v.reqOrder) && typeof v.requirements === 'object' && v.requirements !== null && Array.isArray(v.events);
}

/**
 * Backfill Review.judgeType from the legacy `who` field when unambiguous
 * ('human'/'llm'/'command'). Existing reviews are otherwise left untouched.
 */
function backfillReviewJudgeTypes(validation: GoalValidation): GoalValidation {
  let changed = false;
  const requirements: Record<string, Requirement> = {};
  for (const [id, req] of Object.entries(validation.requirements)) {
    let reqChanged = false;
    const reviews = req.reviews.map((review) => {
      if (review.judgeType) return review;
      if (review.who === 'human' || review.who === 'llm' || review.who === 'command') {
        reqChanged = true;
        const judgeType: Review['judgeType'] = review.who;
        return { ...review, judgeType };
      }
      return review;
    });
    if (reqChanged) {
      changed = true;
      requirements[id] = { ...req, reviews };
    } else {
      requirements[id] = req;
    }
  }
  return changed ? { ...validation, requirements } : validation;
}

export function migrateGoalRecord(raw: unknown): GoalRecord {
  const candidate = raw as LegacyGoalRecord;
  if (candidate && (candidate.version === 2) && isNewValidationShape(candidate.validation)) {
    const record = candidate as unknown as GoalRecord;
    const validation = backfillReviewJudgeTypes(record.validation);
    return validation === record.validation ? record : { ...record, validation };
  }
  const legacy = (candidate.validation ?? {}) as LegacyValidation;
  const reqOrder: string[] = [];
  const requirements: Record<string, Requirement> = {};
  for (const lr of legacy.artifactRequirements ?? []) {
    const kind = LEGACY_KIND_MAP[lr.kind ?? ''] ?? 'note';
    const title = lr.title?.trim() || 'Untitled requirement';
    const id = lr.id || nextRequirementId(title);
    reqOrder.push(id);
    requirements[id] = {
      id,
      title,
      kind,
      required: lr.required !== false,
      rubric: (lr.description ?? '').trim() || title,
      status: 'missing',
      generation: { kind: 'manual' },
      judgment: { kind: 'human' },
      evidence: [],
      reviews: [],
    };
  }
  const migrated: GoalRecord = {
    ...(candidate as unknown as GoalRecord),
    version: 2,
    validation: {
      reqOrder,
      requirements,
      events: [],
    },
  };
  return migrated;
}

// ─── Move binary evidence dir on workspace bind ────────────────────────────

export function moveGoalValidationToWorkspace(
  projectName: string,
  goalId: string,
  workspaceName: string,
): void {
  const plannedDir = getPlannedGoalValidationDir(projectName, goalId);
  if (!existsSync(plannedDir)) return;
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  ensureWorkspaceStorageIgnored(workspaceDir);
  const workspaceValidationDir = getWorkspaceGoalValidationDir(projectName, workspaceName);
  ensureParentDir(workspaceValidationDir);
  if (existsSync(workspaceValidationDir)) {
    const entries = readdirSync(workspaceValidationDir);
    if (entries.length > 0) {
      throw new SpacesError(
        `Workspace validation directory is not empty: ${workspaceValidationDir}`,
        'USER_ERROR',
        1,
      );
    }
    rmSync(workspaceValidationDir, { recursive: true, force: true });
  }
  renameSync(plannedDir, workspaceValidationDir);
}
