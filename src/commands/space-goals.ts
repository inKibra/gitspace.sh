import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import {
  addGoalNearWorkspace,
  bindGoalToWorkspace,
  ensureWorkspaceGoalChain,
  findGoalRecord,
  getGoalRecord,
  listProjectGoalKanbanItems,
  moveGoalInChain,
  readGoalChainState,
  writeGoalRecord,
} from '../core/goal-chain.js';
import { getProjectBaseDir, getProjectWorkspacesDir, readProjectConfig } from '../core/config.js';
import { createWorktree } from '../core/git.js';
import { syncBundleWorkspaceState } from '../core/bundle-refresh.js';
import { setWorkspaceStatus } from '../core/workspace-metadata.js';
import {
  addRequirement,
  attachManualEvidence,
  recordHumanReview,
  removeRequirement,
  reopenRequirement,
  reorderRequirement,
  runGenerationCommand,
  runJudgmentCommand,
  runLlmJudgment,
  updateRequirement,
  type AddRequirementInput,
  type AttachEvidenceInput,
  type HumanReviewDecision,
  type UpdateRequirementInput,
} from '../core/goal-validation.js';
import { computeReadiness } from '../app/shared/goal-validation/readiness.js';
import { SpacesError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { sanitizeForFileSystem, isValidBranchName } from '../utils/sanitize.js';
import type {
  ArtifactKind,
  CommandExpectation,
  Generation,
  GoalRecord,
  Judgment,
  Requirement,
} from '../types/goals.js';

export interface SpaceCommandContext {
  project: string;
  workspace: string;
}

const REQUIREMENT_KINDS: ArtifactKind[] = ['screenshot', 'video', 'test-output', 'note', 'file', 'url'];
const EXPECT_KINDS: CommandExpectation['kind'][] = ['exit-zero', 'stdout-contains', 'stderr-empty', 'output-matches'];

function printJson(value: unknown): void {
  logger.log(JSON.stringify(value, null, 2));
}

function resolveActiveGoal(ctx: SpaceCommandContext): GoalRecord {
  const { goal } = ensureWorkspaceGoalChain(ctx.project, ctx.workspace);
  return goal;
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function readGoalBody(options: { file?: string; stdin?: boolean; body?: string }): string {
  if (options.stdin) return readStdin();
  if (options.file) return readFileSync(options.file, 'utf-8');
  if (options.body !== undefined) return options.body;
  throw new SpacesError('Provide --file, --stdin, or --body.', 'USER_ERROR', 1);
}

function readOptionalBody(options: { file?: string; stdin?: boolean; body?: string }): string | undefined {
  if (options.stdin) return readStdin();
  if (options.file) return readFileSync(options.file, 'utf-8');
  return options.body;
}

function resolveGoalForOption(ctx: SpaceCommandContext, goalToken?: string): GoalRecord {
  if (!goalToken) return resolveActiveGoal(ctx);
  const goal = findGoalRecord(ctx.project, goalToken);
  if (!goal) throw new SpacesError(`Goal not found: ${goalToken}`, 'USER_ERROR', 1);
  return goal;
}

function resolveRequirement(goal: GoalRecord, requirementToken: string): Requirement {
  const direct = goal.validation.requirements[requirementToken];
  if (direct) return direct;
  for (const id of goal.validation.reqOrder) {
    const r = goal.validation.requirements[id];
    if (r && r.title === requirementToken) return r;
  }
  throw new SpacesError(`Requirement not found: ${requirementToken}`, 'USER_ERROR', 1);
}

function assertKindArg(kind: string): ArtifactKind {
  if (!REQUIREMENT_KINDS.includes(kind as ArtifactKind)) {
    throw new SpacesError(`Invalid kind: ${kind}. Allowed: ${REQUIREMENT_KINDS.join(', ')}`, 'USER_ERROR', 1);
  }
  return kind as ArtifactKind;
}

function buildGeneration(input: { gen: string; genCommand?: string }): Generation {
  if (input.gen === 'manual') return { kind: 'manual' };
  if (input.gen === 'command') {
    if (!input.genCommand?.trim()) throw new SpacesError('--gen-command required for command generation.', 'USER_ERROR', 1);
    return { kind: 'command', command: input.genCommand.trim() };
  }
  throw new SpacesError(`Invalid --gen: ${input.gen}. Allowed: manual, command`, 'USER_ERROR', 1);
}

function buildJudgment(input: {
  judge: string;
  judgeCommand?: string;
  expect?: string;
  expectNeedle?: string;
  expectPattern?: string;
  modelHint?: string;
}): Judgment {
  if (input.judge === 'human') return { kind: 'human' };
  if (input.judge === 'llm') {
    const hint = input.modelHint?.trim();
    return hint ? { kind: 'llm', modelHint: hint } : { kind: 'llm' };
  }
  if (input.judge === 'command') {
    if (!input.judgeCommand?.trim()) throw new SpacesError('--judge-command required for command judgment.', 'USER_ERROR', 1);
    const expectKind = (input.expect ?? 'exit-zero') as CommandExpectation['kind'];
    if (!EXPECT_KINDS.includes(expectKind)) {
      throw new SpacesError(`Invalid --expect: ${expectKind}. Allowed: ${EXPECT_KINDS.join(', ')}`, 'USER_ERROR', 1);
    }
    let expect: CommandExpectation;
    if (expectKind === 'exit-zero') expect = { kind: 'exit-zero' };
    else if (expectKind === 'stderr-empty') expect = { kind: 'stderr-empty' };
    else if (expectKind === 'stdout-contains') {
      if (!input.expectNeedle?.trim()) throw new SpacesError('--expect-needle required for stdout-contains.', 'USER_ERROR', 1);
      expect = { kind: 'stdout-contains', needle: input.expectNeedle };
    } else {
      if (!input.expectPattern?.trim()) throw new SpacesError('--expect-pattern required for output-matches.', 'USER_ERROR', 1);
      expect = { kind: 'output-matches', pattern: input.expectPattern };
    }
    return { kind: 'command', command: input.judgeCommand.trim(), expect };
  }
  throw new SpacesError(`Invalid --judge: ${input.judge}. Allowed: human, llm, command`, 'USER_ERROR', 1);
}

function runGit(args: string[], cwd: string): { ok: true; stdout: string } | { ok: false; message: string; code: number } {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf-8' });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    const code = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 1;
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const message = Buffer.isBuffer(stderr) ? stderr.toString('utf-8').trim() : String(stderr ?? error);
    return { ok: false, message, code };
  }
}

function workspacePath(projectName: string, workspaceName: string): string {
  return join(getProjectWorkspacesDir(projectName), workspaceName);
}

function getCurrentBranchOrHead(path: string): string | null {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], path);
  if (branch.ok && branch.stdout && branch.stdout !== 'HEAD') return branch.stdout;
  const head = runGit(['rev-parse', 'HEAD'], path);
  return head.ok && head.stdout ? head.stdout : null;
}

function gitHead(path: string): string | undefined {
  const head = runGit(['rev-parse', 'HEAD'], path);
  return head.ok && head.stdout ? head.stdout : undefined;
}

function gitBranch(path: string): string | undefined {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], path);
  return branch.ok && branch.stdout && branch.stdout !== 'HEAD' ? branch.stdout : undefined;
}

function isDirty(path: string): boolean {
  const status = runGit(['status', '--porcelain'], path);
  if (!status.ok || status.stdout.length === 0) {
    return false;
  }
  return status.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .some((line) => {
      if (line === '?? .gitignore' && isGeneratedWorkspaceGitignore(path)) {
        return false;
      }
      if (line === '?? .gitspace/' && isGeneratedWorkspaceStorageTree(path)) {
        return false;
      }
      return true;
    });
}
const WORKSPACE_STORAGE_GITIGNORE_MARKER = '# gssh workspace local state';
const WORKSPACE_STORAGE_GITIGNORE_ENTRY = '.gitspace/workspace/';

function isGeneratedWorkspaceGitignore(path: string): boolean {
  try {
    return readFileSync(join(path, '.gitignore'), 'utf-8').trim() === `${WORKSPACE_STORAGE_GITIGNORE_MARKER}\n${WORKSPACE_STORAGE_GITIGNORE_ENTRY}`;
  } catch {
    return false;
  }
}

function isGeneratedWorkspaceStorageTree(path: string): boolean {
  try {
    const entries = readdirSync(join(path, '.gitspace'));
    return entries.length === 1 && entries[0] === 'workspace';
  } catch {
    return false;
  }
}


function isAncestor(repoPath: string, parentHead: string, childHead: string): boolean | null {
  const result = runGit(['merge-base', '--is-ancestor', parentHead, childHead], repoPath);
  if (result.ok) return true;
  if (result.code === 1) return false;
  return null;
}

// ─── Chain commands ─────────────────────────────────────────────────────────

export function showSpaceChain(ctx: SpaceCommandContext, options: { json?: boolean } = {}): void {
  const active = resolveActiveGoal(ctx);
  const state = readGoalChainState(ctx.project);
  const chain = state.chains.find((item) => item.id === active.chainId);
  if (!chain) throw new SpacesError(`Chain not found: ${active.chainId}`, 'USER_ERROR', 1);
  const items = listProjectGoalKanbanItems(ctx.project).filter((item) => item.chainId === chain.id);
  if (options.json) {
    printJson({ chain, goals: items });
    return;
  }
  logger.log(`${chain.title} (${chain.id})`);
  for (const item of items) {
    const marker = item.workspaceName === ctx.workspace ? '*' : ' ';
    const workspace = item.workspaceName ?? item.plannedWorkspaceName ?? 'no-workspace';
    logger.log(`${marker} ${item.chainPosition}. ${workspace} · ${item.phase} · ${item.status} · ${item.title}`);
  }
}

export function addSpaceChainGoal(ctx: SpaceCommandContext, title: string, position: 'before' | 'after', options: { json?: boolean } = {}): void {
  const goal = addGoalNearWorkspace(ctx.project, ctx.workspace, title, position);
  if (options.json) {
    printJson(goal);
    return;
  }
  logger.success(`Added goal ${position} current workspace: ${goal.title}`);
}

export function moveSpaceChainGoal(ctx: SpaceCommandContext, sourceToken: string, targetToken: string, position: 'before' | 'after', options: { json?: boolean } = {}): void {
  const chain = moveGoalInChain(ctx.project, sourceToken, targetToken, position);
  if (options.json) {
    printJson(chain);
    return;
  }
  logger.success(`Saved goal order for chain ${chain.title}. Git stack unchanged; run space stack status when ready.`);
}

// ─── Goal doc ──────────────────────────────────────────────────────────────

export function showSpaceGoal(ctx: SpaceCommandContext, options: { json?: boolean } = {}): void {
  const goal = resolveActiveGoal(ctx);
  if (options.json) {
    printJson(goal);
    return;
  }
  logger.log(`Goal: ${goal.title}`);
  logger.log(`Phase: ${goal.phase}`);
  logger.log(`Workspace: ${goal.workspaceName ?? goal.plannedWorkspaceName ?? 'not created'}`);
  logger.log('');
  logger.log(goal.doc.bodyMarkdown.trimEnd());
}

export function setSpaceGoal(ctx: SpaceCommandContext, options: { file?: string; stdin?: boolean; body?: string; json?: boolean }): void {
  const goal = resolveActiveGoal(ctx);
  const bodyMarkdown = readGoalBody(options);
  const updated = writeGoalRecord(ctx.project, {
    ...goal,
    doc: {
      ...goal.doc,
      bodyMarkdown,
      updatedAt: new Date().toISOString(),
    },
  });
  if (options.json) {
    printJson(updated);
    return;
  }
  logger.success(`Updated goal doc: ${updated.title}`);
}

export function editSpaceGoal(ctx: SpaceCommandContext, options: { editor?: string; json?: boolean } = {}): void {
  const goal = resolveActiveGoal(ctx);
  const editor = options.editor || process.env.EDITOR;
  if (!editor) {
    throw new SpacesError('EDITOR is not set. Use `space goal set --file goal.md` or pass --editor.', 'USER_ERROR', 1);
  }
  const filePath = join(tmpdir(), `gssh-goal-${goal.id}.md`);
  writeFileSync(filePath, goal.doc.bodyMarkdown, 'utf-8');
  execFileSync(editor, [filePath], { stdio: 'inherit' });
  const bodyMarkdown = readFileSync(filePath, 'utf-8');
  setSpaceGoal(ctx, { body: bodyMarkdown, json: options.json });
}

// ─── Requirements ──────────────────────────────────────────────────────────

export interface AddRequirementOptions {
  goal?: string;
  title: string;
  kind: string;
  rubric: string;
  required?: boolean;
  optional?: boolean;
  gen: string;
  genCommand?: string;
  judge: string;
  judgeCommand?: string;
  expect?: string;
  expectNeedle?: string;
  expectPattern?: string;
  modelHint?: string;
  json?: boolean;
}

export function addSpaceGoalRequirement(ctx: SpaceCommandContext, options: AddRequirementOptions): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const input: AddRequirementInput = {
    title: options.title,
    kind: assertKindArg(options.kind),
    rubric: options.rubric,
    required: options.required === undefined ? !options.optional : options.required,
    generation: buildGeneration(options),
    judgment: buildJudgment(options),
  };
  const { validation, requirement } = addRequirement(goal.validation, input, goal);
  const updated = writeGoalRecord(ctx.project, { ...goal, validation });
  if (options.json) {
    printJson({ goalId: updated.id, requirement });
    return;
  }
  logger.success(`Declared ${requirement.required ? 'required' : 'optional'} requirement: ${requirement.title}`);
}

export interface UpdateRequirementOptions {
  goal?: string;
  requirement: string;
  title?: string;
  kind?: string;
  rubric?: string;
  required?: boolean;
  optional?: boolean;
  gen?: string;
  genCommand?: string;
  judge?: string;
  judgeCommand?: string;
  expect?: string;
  expectNeedle?: string;
  expectPattern?: string;
  modelHint?: string;
  json?: boolean;
}

export function updateSpaceGoalRequirement(ctx: SpaceCommandContext, options: UpdateRequirementOptions): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const current = resolveRequirement(goal, options.requirement);
  const patch: UpdateRequirementInput = {};
  if (options.title !== undefined) patch.title = options.title;
  if (options.kind !== undefined) patch.kind = assertKindArg(options.kind);
  if (options.rubric !== undefined) patch.rubric = options.rubric;
  if (options.required !== undefined) patch.required = options.required;
  else if (options.optional) patch.required = false;
  if (options.gen !== undefined) patch.generation = buildGeneration({ gen: options.gen, genCommand: options.genCommand });
  if (options.judge !== undefined) {
    patch.judgment = buildJudgment({
      judge: options.judge,
      judgeCommand: options.judgeCommand,
      expect: options.expect,
      expectNeedle: options.expectNeedle,
      expectPattern: options.expectPattern,
      modelHint: options.modelHint,
    });
  }
  const { validation, requirement } = updateRequirement(goal.validation, current.id, patch, goal);
  const updated = writeGoalRecord(ctx.project, { ...goal, validation });
  if (options.json) {
    printJson({ goalId: updated.id, requirement });
    return;
  }
  logger.success(`Updated requirement: ${requirement.title}`);
}

export function removeSpaceGoalRequirement(ctx: SpaceCommandContext, options: { goal?: string; requirement: string; json?: boolean }): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const current = resolveRequirement(goal, options.requirement);
  const validation = removeRequirement(goal.validation, current.id, goal);
  const updated = writeGoalRecord(ctx.project, { ...goal, validation });
  if (options.json) {
    printJson({ goalId: updated.id, removedRequirementId: current.id });
    return;
  }
  logger.success(`Removed requirement: ${current.title}`);
}

export function reorderSpaceGoalRequirement(ctx: SpaceCommandContext, options: { goal?: string; requirement: string; position: number; json?: boolean }): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const current = resolveRequirement(goal, options.requirement);
  const validation = reorderRequirement(goal.validation, current.id, options.position);
  const updated = writeGoalRecord(ctx.project, { ...goal, validation });
  if (options.json) {
    printJson({ goalId: updated.id, requirementId: current.id, position: options.position });
    return;
  }
  logger.success(`Moved requirement "${current.title}" to position ${options.position}.`);
}

export function listSpaceGoalRequirements(ctx: SpaceCommandContext, options: { goal?: string; json?: boolean } = {}): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const requirements = goal.validation.reqOrder
    .map((id) => goal.validation.requirements[id])
    .filter((r): r is Requirement => Boolean(r));
  if (options.json) {
    printJson({ goalId: goal.id, requirements });
    return;
  }
  logger.log(`Requirements for ${goal.title}:`);
  if (requirements.length === 0) {
    logger.log('No requirements declared yet.');
    return;
  }
  for (const r of requirements) {
    const gen = r.generation.kind === 'manual' ? 'manual' : `command (${r.generation.command})`;
    const jud =
      r.judgment.kind === 'human' ? 'human'
      : r.judgment.kind === 'llm' ? (r.judgment.modelHint ? `llm (${r.judgment.modelHint})` : 'llm')
      : `command · ${r.judgment.expect.kind}`;
    logger.log(`${r.id} · ${r.required ? 'required' : 'optional'} · ${r.kind} · ${r.status} · ${r.title}`);
    logger.log(`  rubric: ${r.rubric}`);
    logger.log(`  gen: ${gen}`);
    logger.log(`  judge: ${jud}`);
  }
}

// ─── Fulfillment ───────────────────────────────────────────────────────────

export function attachSpaceGoalEvidence(ctx: SpaceCommandContext, options: {
  goal?: string;
  requirement: string;
  name?: string;
  body?: string;
  file?: string;
  stdin?: boolean;
  path?: string;
  url?: string;
  json?: boolean;
}): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const requirement = resolveRequirement(goal, options.requirement);
  const input: AttachEvidenceInput = {
    name: options.name,
    body: readOptionalBody(options),
    path: options.path,
    url: options.url,
  };
  const result = attachManualEvidence(ctx.project, goal, requirement.id, input);
  writeGoalRecord(ctx.project, result.goal);
  if (options.json) {
    printJson({ goalId: goal.id, requirementId: requirement.id, evidence: result.evidence });
    return;
  }
  logger.success(`Attached evidence to ${requirement.title}: ${result.evidence.name}`);
}

export function runSpaceGoalGeneration(ctx: SpaceCommandContext, options: { goal?: string; requirement: string; json?: boolean }): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const requirement = resolveRequirement(goal, options.requirement);
  const result = runGenerationCommand(ctx.project, goal, requirement.id);
  writeGoalRecord(ctx.project, result.goal);
  if (options.json) {
    printJson({ goalId: goal.id, requirementId: requirement.id, evidence: result.evidence, autoAccepted: result.autoAccepted });
    return;
  }
  logger.success(`Generation command produced evidence for ${requirement.title}${result.autoAccepted ? ' (auto-accepted by command judgment)' : ''}.`);
}

export function runSpaceGoalJudgment(ctx: SpaceCommandContext, options: { goal?: string; requirement: string; json?: boolean }): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const requirement = resolveRequirement(goal, options.requirement);
  if (requirement.judgment.kind === 'command') {
    const result = runJudgmentCommand(ctx.project, goal, requirement.id);
    writeGoalRecord(ctx.project, result.goal);
    if (options.json) printJson({ goalId: goal.id, requirementId: requirement.id, review: result.review });
    else logger.success(`Command check ${result.review.tone === 'green' ? 'passed' : 'failed'}: ${result.review.note}`);
    return;
  }
  if (requirement.judgment.kind === 'llm') {
    const result = runLlmJudgment(goal, requirement.id);
    writeGoalRecord(ctx.project, result.goal);
    if (options.json) printJson({ goalId: goal.id, requirementId: requirement.id, review: result.review });
    else logger.log(result.review.note);
    return;
  }
  throw new SpacesError('Human judgment is recorded via `space goal review record`, not run.', 'USER_ERROR', 1);
}

export function recordSpaceGoalHumanReview(ctx: SpaceCommandContext, options: {
  goal?: string;
  requirement: string;
  decision: HumanReviewDecision | string;
  body?: string;
  file?: string;
  stdin?: boolean;
  score?: number;
  createdBy?: string;
  json?: boolean;
}): void {
  const decisions: HumanReviewDecision[] = ['pass', 'changes', 'fail'];
  if (!decisions.includes(options.decision as HumanReviewDecision)) {
    throw new SpacesError(`Invalid --decision: ${options.decision}. Allowed: ${decisions.join(', ')}`, 'USER_ERROR', 1);
  }
  const goal = resolveGoalForOption(ctx, options.goal);
  const requirement = resolveRequirement(goal, options.requirement);
  const note = readOptionalBody(options) ?? '';
  const result = recordHumanReview(goal, requirement.id, options.decision as HumanReviewDecision, note, options.score, options.createdBy);
  writeGoalRecord(ctx.project, result.goal);
  if (options.json) {
    printJson({ goalId: goal.id, requirementId: requirement.id, review: result.review });
    return;
  }
  logger.success(`Recorded ${options.decision} on ${requirement.title}.`);
}

export function reopenSpaceGoalRequirement(ctx: SpaceCommandContext, options: { goal?: string; requirement: string; json?: boolean }): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const requirement = resolveRequirement(goal, options.requirement);
  const result = reopenRequirement(goal, requirement.id);
  writeGoalRecord(ctx.project, result.goal);
  if (options.json) {
    printJson({ goalId: goal.id, requirementId: requirement.id, status: result.requirement.status });
    return;
  }
  logger.success(`Reopened requirement for review: ${requirement.title}`);
}

// ─── Status ────────────────────────────────────────────────────────────────

export function showSpaceGoalStatus(ctx: SpaceCommandContext, options: { goal?: string; json?: boolean } = {}): void {
  const goal = resolveGoalForOption(ctx, options.goal);
  const readiness = computeReadiness(goal.validation);
  if (options.json) {
    printJson({ goalId: goal.id, readiness });
    return;
  }
  logger.log(`Validation readiness for ${goal.title}: ${readiness.status}`);
  logger.log(readiness.summary);
  logger.log(readiness.detail);
  logger.log(`Required: ${readiness.totals.total} · missing: ${readiness.totals.missing} · review: ${readiness.totals.review} · accepted: ${readiness.totals.accepted}`);
}

// ─── Workspace creation ────────────────────────────────────────────────────

function resolvePreviousGoal(projectName: string, goal: GoalRecord): GoalRecord | null {
  const state = readGoalChainState(projectName);
  const chain = state.chains.find((item) => item.id === goal.chainId);
  if (!chain) return null;
  const index = chain.goalIds.indexOf(goal.id);
  if (index <= 0) return null;
  return getGoalRecord(projectName, chain.goalIds[index - 1]);
}

async function createWorkspaceFromProjectBase(projectName: string, workspaceName: string, branchName: string): Promise<void> {
  const config = readProjectConfig(projectName);
  const baseDir = getProjectBaseDir(projectName);
  const workspacesDir = getProjectWorkspacesDir(projectName);
  await createWorktree(baseDir, join(workspacesDir, workspaceName), branchName, config.baseBranch, false);
}

async function createWorkspaceFromParent(projectName: string, workspaceName: string, branchName: string, parentWorkspaceName: string): Promise<boolean> {
  const parentPath = workspacePath(projectName, parentWorkspaceName);
  if (!existsSync(parentPath)) return false;
  const parentRef = getCurrentBranchOrHead(parentPath);
  if (!parentRef) return false;
  const targetPath = workspacePath(projectName, workspaceName);
  const baseDir = getProjectBaseDir(projectName);
  const result = runGit(['worktree', 'add', '-b', branchName, targetPath, parentRef, '--no-track'], baseDir);
  if (!result.ok) {
    logger.warning(`Unable to branch from ${parentWorkspaceName}: ${result.message}`);
    return false;
  }
  if (isDirty(parentPath)) {
    logger.warning(`Created from ${parentWorkspaceName} HEAD; uncommitted parent changes were not included.`);
  }
  return true;
}

export async function createSpaceChainWorkspace(ctx: SpaceCommandContext, options: { goal?: string; name?: string; branch?: string; json?: boolean } = {}): Promise<void> {
  const activeGoal = resolveActiveGoal(ctx);
  const goal = options.goal ? findGoalRecord(ctx.project, options.goal) : activeGoal;
  if (!goal) throw new SpacesError(`Goal not found: ${options.goal}`, 'USER_ERROR', 1);
  if (goal.workspaceName) throw new SpacesError(`Goal already has workspace: ${goal.workspaceName}`, 'USER_ERROR', 1);
  const workspaceName = sanitizeForFileSystem(options.name ?? goal.plannedWorkspaceName ?? goal.title);
  if (!workspaceName) throw new SpacesError('Workspace name must contain at least one letter or number.', 'USER_ERROR', 1);
  const branchName = options.branch ?? workspaceName;
  if (!isValidBranchName(branchName)) throw new SpacesError(`Invalid branch name: ${branchName}`, 'USER_ERROR', 1);
  const targetPath = workspacePath(ctx.project, workspaceName);
  if (existsSync(targetPath)) throw new SpacesError(`Workspace already exists: ${workspaceName}`, 'USER_ERROR', 1);

  const previous = resolvePreviousGoal(ctx.project, goal);
  let stacked = false;
  if (previous?.workspaceName) {
    stacked = await createWorkspaceFromParent(ctx.project, workspaceName, branchName, previous.workspaceName);
  } else {
    logger.warning('Unable to branch from previous goal workspace; creating from project base branch.');
  }
  if (!stacked) {
    await createWorkspaceFromProjectBase(ctx.project, workspaceName, branchName);
  }
  setWorkspaceStatus(ctx.project, workspaceName, goal.phase);
  const bound = bindGoalToWorkspace(ctx.project, goal.id, workspaceName);
  mkdirSync(targetPath, { recursive: true });
  syncBundleWorkspaceState(ctx.project, targetPath);

  if (options.json) {
    printJson({ workspaceName, branchName, stacked, goal: bound });
    return;
  }
  logger.success(`Created workspace ${workspaceName} for goal ${bound.title}${stacked ? ' from previous goal workspace' : ''}.`);
}

// ─── Stack status ──────────────────────────────────────────────────────────

export interface StackStatusEdge {
  parentGoalId: string;
  childGoalId: string;
  parentWorkspace?: string;
  childWorkspace?: string;
  parentBranch?: string;
  childBranch?: string;
  parentHead?: string;
  childHead?: string;
  status: 'aligned' | 'needs-rebase' | 'missing-workspace' | 'missing-branch' | 'dirty-worktree' | 'unknown';
  message?: string;
}

export function getSpaceStackStatus(ctx: SpaceCommandContext): { status: string; currentGoalId: string; youAreNext: boolean; edges: StackStatusEdge[] } {
  const active = resolveActiveGoal(ctx);
  const state = readGoalChainState(ctx.project);
  const chain = state.chains.find((item) => item.id === active.chainId);
  if (!chain) throw new SpacesError(`Chain not found: ${active.chainId}`, 'USER_ERROR', 1);
  const goals = chain.goalIds.map((goalId) => getGoalRecord(ctx.project, goalId));
  const repoPath = getProjectBaseDir(ctx.project);
  const edges: StackStatusEdge[] = [];

  for (let index = 0; index < goals.length - 1; index += 1) {
    const parent = goals[index];
    const child = goals[index + 1];
    if (!parent || !child) continue;
    const edge: StackStatusEdge = {
      parentGoalId: parent.id,
      childGoalId: child.id,
      parentWorkspace: parent.workspaceName,
      childWorkspace: child.workspaceName,
      status: 'unknown',
    };
    if (!parent.workspaceName || !child.workspaceName) {
      edge.status = 'missing-workspace';
      edge.message = !parent.workspaceName ? 'Parent workspace is not created.' : 'Child workspace is not created.';
      edges.push(edge);
      continue;
    }
    const parentPath = workspacePath(ctx.project, parent.workspaceName);
    const childPath = workspacePath(ctx.project, child.workspaceName);
    edge.parentBranch = gitBranch(parentPath);
    edge.childBranch = gitBranch(childPath);
    edge.parentHead = gitHead(parentPath);
    edge.childHead = gitHead(childPath);
    if (!edge.parentHead || !edge.childHead) {
      edge.status = 'missing-branch';
      edge.message = 'Unable to resolve one or both workspace HEADs.';
      edges.push(edge);
      continue;
    }
    if (isDirty(parentPath) || isDirty(childPath)) {
      edge.status = 'dirty-worktree';
      edge.message = 'One or both adjacent worktrees have uncommitted changes.';
      edges.push(edge);
      continue;
    }
    const ancestor = isAncestor(repoPath, edge.parentHead, edge.childHead);
    edge.status = ancestor === true ? 'aligned' : ancestor === false ? 'needs-rebase' : 'unknown';
    edges.push(edge);
  }

  const firstBlocking = edges.find((edge) => edge.status !== 'aligned');
  const activeIndex = goals.findIndex((goal) => goal?.id === active.id);
  const previousEdges = edges.slice(0, Math.max(0, activeIndex));
  const currentIncoming = activeIndex > 0 ? edges[activeIndex - 1] : undefined;
  const youAreNext = Boolean(currentIncoming && currentIncoming.status === 'needs-rebase' && previousEdges.slice(0, -1).every((edge) => edge.status === 'aligned'));
  return {
    status: firstBlocking ? firstBlocking.status : 'aligned',
    currentGoalId: active.id,
    youAreNext,
    edges,
  };
}

export function showSpaceStackStatus(ctx: SpaceCommandContext, options: { json?: boolean } = {}): void {
  const status = getSpaceStackStatus(ctx);
  if (options.json) {
    printJson(status);
    return;
  }
  logger.log(`Status: ${status.status}`);
  if (status.youAreNext) logger.log('You are next to rebase.');
  const firstBlocking = status.edges.find((edge) => edge.status !== 'aligned');
  if (!status.youAreNext && firstBlocking) {
    logger.log(`Blocking edge: ${firstBlocking.parentWorkspace ?? firstBlocking.parentGoalId} → ${firstBlocking.childWorkspace ?? firstBlocking.childGoalId}: ${firstBlocking.status}`);
  }
  for (const edge of status.edges) {
    logger.log(`${edge.parentWorkspace ?? edge.parentGoalId} → ${edge.childWorkspace ?? edge.childGoalId}: ${edge.status}`);
  }
}
