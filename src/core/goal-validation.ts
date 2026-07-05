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
import { artifactsMountDir, captureArtifactsSync } from './artifacts.js';
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

function assertJudgment(judgment: Judgment): void {
  if (judgment.kind !== 'human' && judgment.kind !== 'llm' && judgment.kind !== 'command') {
    throw new SpacesError(`Invalid judgment kind: ${(judgment as { kind: string }).kind}`, 'USER_ERROR', 1);
  }
  if (judgment.kind === 'command') {
    if (!judgment.command.trim()) {
      throw new SpacesError('Command judgment requires a command.', 'USER_ERROR', 1);
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

function appendEvent(
  validation: GoalValidation,
  partial: Omit<TimelineEvent, 'id' | 'createdAt'>,
): GoalValidation {
  const event: TimelineEvent = {
    ...partial,
    id: nextEventId(),
    createdAt: nowIso(),
  };
  return { ...validation, events: [...validation.events, event] };
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
  const mountDir = artifactsMountDir(root);
  if (!existsSync(join(mountDir, '.git'))) {
    return copyEvidenceFile(validationDir, evidenceId, sourcePath, kind);
  }
  const displayName = basename(sourcePath);
  const safeName = sanitizeForFileSystem(displayName) || 'artifact';
  const relativePath = `validation/${goal.id}/${evidenceId}-${safeName}`;
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

function describeJudgmentSummary(judgment: Judgment): string {
  if (judgment.kind === 'human') return 'human';
  if (judgment.kind === 'llm') return judgment.modelHint ? `llm (${judgment.modelHint})` : 'llm';
  return `command · ${judgment.expect.kind}`;
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
  }
  if (requirement.judgment.kind === 'llm' && requirement.judgment.modelHint) {
    lines.push(`  jud.model: ${requirement.judgment.modelHint}`);
  }
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
}

export function addRequirement(
  validation: GoalValidation,
  input: AddRequirementInput,
): { validation: GoalValidation; requirement: Requirement } {
  const title = input.title.trim();
  if (!title) throw new SpacesError('Title is required.', 'USER_ERROR', 1);
  if (!input.rubric.trim()) throw new SpacesError('Rubric is required.', 'USER_ERROR', 1);
  assertKind(input.kind);
  assertGeneration(input.generation);
  assertJudgment(input.judgment);

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
    body: `Produced by ${describeGenerationSummary(input.generation)}; judged by ${describeJudgmentSummary(input.judgment)}.`,
    payload: contractAddedPayload(requirement),
  });
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
    assertJudgment(merged.judgment);
    return merged;
  });
  const next = appendEvent(nextRequirements, {
    requirementId,
    tone: 'blue',
    kind: 'contract',
    title: `Requirement edited: ${requirement.title}`,
    body: 'Contract changed.',
    payload: `contract.requirement.updated\n  id: ${requirementId}`,
  });
  return { validation: next, requirement };
}

export function removeRequirement(validation: GoalValidation, requirementId: string): GoalValidation {
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
  });
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
  });
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
      });
    }
    return { ...r, evidence: [...r.evidence, evidence], status, reviews };
  });
  let withEvents: GoalValidation = appendEvent(nextValidation, {
    requirementId,
    tone: 'violet',
    kind: 'generation',
    title: `Command produced evidence: ${cur.title}`,
    body: command,
    payload: `generation.command.ran\n  requirement: ${requirementId}\n  command: ${command}\n  exit: ${exitCode}\n  artifact: ${artifactName}`,
  });
  if (autoAccepted && cur.judgment.kind === 'command') {
    withEvents = appendEvent(withEvents, {
      requirementId,
      tone: 'green',
      kind: 'review',
      title: `Command check passed: ${cur.title}`,
      body: describeExpectSatisfied(cur.judgment.expect),
      payload: `review.passed\n  requirement: ${requirementId}\n  judge: command\n  expect: ${cur.judgment.expect.kind}`,
    });
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
  if (!goal.workspaceName) {
    throw new SpacesError('Judgment commands require a workspace-backed goal.', 'USER_ERROR', 1);
  }
  const cwd = join(getProjectWorkspacesDir(projectName), goal.workspaceName);
  if (!existsSync(cwd)) {
    throw new SpacesError(`Workspace directory does not exist: ${cwd}`, 'USER_ERROR', 1);
  }
  const command = cur.judgment.command;
  const expect = cur.judgment.expect;
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf-8', maxBuffer: 1024 * 1024 * 8 });
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const stdout = truncate(result.stdout ?? '');
  const stderr = truncate(result.stderr ?? (result.error ? String(result.error) : ''));
  const passed = commandPasses(cur.judgment, exitCode, stdout, stderr);
  const note = passed ? describeExpectSatisfied(expect) : describeExpectFailed(expect, exitCode);
  const tone: ReviewTone = passed ? 'green' : 'red';
  const review: Review = { id: nextReviewId(), tone, who: 'command', note, createdAt: nowIso() };
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
    payload: `review.${passed ? 'passed' : 'failed'}\n  requirement: ${requirementId}\n  judge: command\n  expect: ${expect.kind}\n  exit: ${exitCode}`,
  });
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
  const review: Review = {
    id: nextReviewId(),
    tone: 'amber',
    who: cur.judgment.modelHint || 'llm',
    note: 'LLM judgment runner is not yet implemented. Apply the rubric manually or wire an LLM backend.',
    createdAt: nowIso(),
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
  });
  return {
    goal: { ...goal, validation: withEvent, updatedAt: nowIso() },
    requirement,
    review,
  };
}

export type HumanReviewDecision = 'pass' | 'changes' | 'fail';

export function recordHumanReview(
  goal: GoalRecord,
  requirementId: string,
  decision: HumanReviewDecision,
  note: string,
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
  const tone: ReviewTone = decision === 'pass' ? 'green' : decision === 'changes' ? 'amber' : 'red';
  const review: Review = {
    id: nextReviewId(),
    tone,
    who: 'human',
    note: trimmed || 'Accepted.',
    createdAt: nowIso(),
    createdBy,
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
  });
  return {
    goal: { ...goal, validation: withEvent, updatedAt: nowIso() },
    requirement,
    review,
  };
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
  });
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

export function migrateGoalRecord(raw: unknown): GoalRecord {
  const candidate = raw as LegacyGoalRecord;
  if (candidate && (candidate.version === 2) && isNewValidationShape(candidate.validation)) {
    return candidate as unknown as GoalRecord;
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
