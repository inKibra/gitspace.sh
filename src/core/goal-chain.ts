import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { getProjectDir, getProjectWorkspacesDir } from './config.js';
import { artifactsScope, captureArtifactsSync, readRolledUpGoalMd, readWorkspaceGoalMd } from './artifacts.js';
import { defaultValidation, getPlannedGoalValidationDir, migrateGoalRecord, moveGoalValidationToWorkspace } from './goal-validation.js';
import { computeReadiness } from '../app/shared/goal-validation/readiness.js';
import { ensureWorkspaceStorageIgnored, getWorkspaceStatus, getWorkspaceStorageDir, setWorkspaceStatus } from './workspace-metadata.js';
import { SpacesError } from '../types/errors.js';
import { queueGoalChangeNotify } from './goal-notify.js';
import { generateId } from '../utils/id.js';
import { sanitizeForFileSystem } from '../utils/sanitize.js';
import type { GoalChain, GoalChainState, GoalChainSummary, GoalChainSummaryGoal, GoalKanbanItem, GoalRecord, GoalUpdateInput, WorkspacePhaseCascadeItem, WorkspacePhaseChangePreview } from '../types/goals.js';

const PROJECT_GOAL_STORAGE_DIR = join('.gitspace', 'goals');
const PROJECT_GOAL_GITIGNORE_ENTRY = '.gitspace/goals/';
const PROJECT_GOAL_GITIGNORE_MARKER = '# gssh goal local state';
const PLANNED_GOAL_DIR = 'planned';
const ARCHIVED_GOAL_DIR = 'archived';
const CHAIN_STATE_FILE = 'chains.json';
const WORKSPACE_GOAL_FILE = 'goal.json';


const GOAL_PHASE_ORDER = ['plan', 'code', 'review', 'ship'] as const;

function phaseIndex(phase: GoalRecord['phase']): number {
  return GOAL_PHASE_ORDER.indexOf(phase);
}

function phaseAt(index: number): GoalRecord['phase'] {
  return GOAL_PHASE_ORDER[Math.max(0, Math.min(index, GOAL_PHASE_ORDER.length - 1))] ?? 'plan';
}

function nowIso(): string {
  return new Date().toISOString();
}

function assertSafeSegment(value: string, label: string): void {
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new SpacesError(`${label} must be a non-empty path segment`, 'USER_ERROR', 1);
  }
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  ensureParentDir(filePath);
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

export function getProjectGoalStorageDir(projectName: string): string {
  return join(getProjectDir(projectName), PROJECT_GOAL_STORAGE_DIR);
}

export function getProjectGoalChainStatePath(projectName: string): string {
  return join(getProjectGoalStorageDir(projectName), CHAIN_STATE_FILE);
}

export function getPlannedGoalPath(projectName: string, goalId: string): string {
  assertSafeSegment(goalId, 'goalId');
  return join(getProjectGoalStorageDir(projectName), PLANNED_GOAL_DIR, `${goalId}.json`);
}

export function getArchivedGoalPath(projectName: string, goalId: string): string {
  assertSafeSegment(goalId, 'goalId');
  return join(getProjectGoalStorageDir(projectName), ARCHIVED_GOAL_DIR, `${goalId}.json`);
}

export function getWorkspaceGoalPath(projectName: string, workspaceName: string): string {
  assertSafeSegment(workspaceName, 'workspaceName');
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  return join(getWorkspaceStorageDir(workspaceDir, workspaceName), WORKSPACE_GOAL_FILE);
}

export function ensureProjectGoalStorageIgnored(projectName: string): void {
  const gitignorePath = join(getProjectDir(projectName), '.gitignore');
  const alreadyIgnored =
    existsSync(gitignorePath) && readFileSync(gitignorePath, 'utf-8').includes(PROJECT_GOAL_GITIGNORE_ENTRY);
  if (alreadyIgnored) {
    return;
  }
  appendFileSync(
    gitignorePath,
    `\n${PROJECT_GOAL_GITIGNORE_MARKER}\n${PROJECT_GOAL_GITIGNORE_ENTRY}\n`,
    'utf-8',
  );
}

export function readGoalChainState(projectName: string): GoalChainState {
  return readJsonFile<GoalChainState>(getProjectGoalChainStatePath(projectName)) ?? {
    version: 1,
    updatedAt: nowIso(),
    chains: [],
  };
}

export function writeGoalChainState(projectName: string, state: GoalChainState): void {
  queueGoalChangeNotify(projectName);
  ensureProjectGoalStorageIgnored(projectName);
  writeJsonFile(getProjectGoalChainStatePath(projectName), {
    ...state,
    version: 1,
    updatedAt: nowIso(),
    chains: state.chains.map((chain) => ({
      ...chain,
      projectName,
      updatedAt: chain.updatedAt || nowIso(),
    })),
  });
}

export function upsertGoalChain(projectName: string, chain: GoalChain): GoalChain {
  const state = readGoalChainState(projectName);
  const timestamp = nowIso();
  const nextChain: GoalChain = {
    ...chain,
    projectName,
    createdAt: chain.createdAt || timestamp,
    updatedAt: timestamp,
  };
  const index = state.chains.findIndex((item) => item.id === chain.id);
  const chains = [...state.chains];
  if (index >= 0) {
    chains[index] = nextChain;
  } else {
    chains.push(nextChain);
  }
  writeGoalChainState(projectName, { ...state, chains });
  return nextChain;
}

export function readPlannedGoal(projectName: string, goalId: string): GoalRecord | null {
  const raw = readJsonFile<unknown>(getPlannedGoalPath(projectName, goalId));
  return raw ? migrateGoalRecord(raw) : null;
}

export function writePlannedGoal(projectName: string, goal: GoalRecord): GoalRecord {
  ensureProjectGoalStorageIgnored(projectName);
  const timestamp = nowIso();
  const nextGoal: GoalRecord = {
    ...goal,
    version: 2,
    projectName,
    createdAt: goal.createdAt || timestamp,
    updatedAt: timestamp,
    workspaceName: undefined,
  };
  writeJsonFile(getPlannedGoalPath(projectName, goal.id), nextGoal);
  return nextGoal;
}

export function readArchivedGoal(projectName: string, goalId: string): GoalRecord | null {
  const raw = readJsonFile<unknown>(getArchivedGoalPath(projectName, goalId));
  return raw ? migrateGoalRecord(raw) : null;
}

/**
 * Persist a goal to the project-level archived store. Stamps `archivedAt`
 * (first archive wins for provenance; callers wanting a fresh timestamp pass
 * an already-cleared field). Overwrites any prior archived copy of the same
 * id — the caller archives from the freshest source (the live goal.json at
 * delete time), so an older archived copy is strictly staler.
 */
export function writeArchivedGoal(projectName: string, goal: GoalRecord): GoalRecord {
  ensureProjectGoalStorageIgnored(projectName);
  const timestamp = nowIso();
  const nextGoal: GoalRecord = {
    ...goal,
    version: 2,
    projectName,
    archivedAt: goal.archivedAt || timestamp,
    updatedAt: timestamp,
  };
  writeJsonFile(getArchivedGoalPath(projectName, goal.id), nextGoal);
  return nextGoal;
}

/**
 * Archive a workspace-backed goal before its worktree (and the goal.json
 * inside it) is destroyed. Reads the live goal.json, relocates it to the
 * project-level archived store, and stamps `archivedAt`. The chain link is
 * deliberately KEPT — the id now resolves to the archived record via
 * listProjectGoalRecords' fallback. No-op (returns null) when the workspace
 * has no goal. Idempotent: re-archiving overwrites with the freshest state.
 */
/**
 * Recover a goal's body markdown from a `goals/<id>/goal.md` file, which the
 * canon mirror writes as `# <title>\n\n<body>\n<!-- blocks:… -->`. Strips the
 * mirror's leading title header and trailing machine blocks comment so the
 * result round-trips back to a record `doc.bodyMarkdown`. Best-effort: content
 * that doesn't match the mirror shape is returned as-is.
 */
function goalMdToBody(goalMd: string, title: string): string {
  let s = goalMd;
  const header = `# ${title}`;
  if (s.startsWith(header)) s = s.slice(header.length).replace(/^\n+/, '');
  s = s.replace(/\n?<!--\s*blocks:[\s\S]*-->\s*$/, '');
  return s.trimEnd();
}

/**
 * Resolve a goal's DISPLAY doc body, preferring the rich `goals/<id>/goal.md`
 * over the record's (often stub) embedded `doc.bodyMarkdown`. Fallback order:
 *   1. live workspace mount `goals/<id>/goal.md`  (freshest, unrolled edits)
 *   2. rolled-up `goals/<id>/goal.md` on artifacts main
 *   3. the record's embedded `doc.bodyMarkdown`    (last resort — archived stub)
 */
export function resolveGoalDocBody(projectName: string, goal: GoalRecord): string {
  if (goal.workspaceName) {
    const workspaceDir = join(getProjectWorkspacesDir(projectName), goal.workspaceName);
    const md = readWorkspaceGoalMd(workspaceDir, goal.id);
    if (md) return goalMdToBody(md, goal.title);
  }
  const rolled = readRolledUpGoalMd(getProjectDir(projectName), goal.id);
  if (rolled) return goalMdToBody(rolled, goal.title);
  return goal.doc?.bodyMarkdown ?? '';
}

export function archiveWorkspaceGoal(projectName: string, workspaceName: string): GoalRecord | null {
  const goal = readWorkspaceGoal(projectName, workspaceName);
  if (!goal) {
    return null;
  }
  // Capture the RICH doc (goals/<id>/goal.md, from the still-present workspace
  // mount, falling back to the rolled-up copy on artifacts main) into the
  // archived record — the record's own embedded doc is only a stub, and the
  // worktree (and its goal.md) is about to be destroyed. This makes the archived
  // record a true last-resort doc source after deletion.
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  const richMd = readWorkspaceGoalMd(workspaceDir, goal.id)
    ?? readRolledUpGoalMd(getProjectDir(projectName), goal.id);
  const richBody = richMd ? goalMdToBody(richMd, goal.title) : undefined;
  const goalToArchive: GoalRecord = richBody && richBody.length > (goal.doc?.bodyMarkdown?.length ?? 0)
    ? { ...goal, doc: { ...(goal.doc ?? { updatedAt: nowIso() }), bodyMarkdown: richBody } }
    : goal;
  // Force a fresh archive timestamp even if the live record somehow carried a
  // stale one (e.g. a previously-archived goal that was re-bound then deleted).
  const archived = writeArchivedGoal(projectName, { ...goalToArchive, archivedAt: nowIso() });
  queueGoalChangeNotify(projectName);
  return archived;
}

export function readWorkspaceGoal(projectName: string, workspaceName: string): GoalRecord | null {
  const raw = readJsonFile<unknown>(getWorkspaceGoalPath(projectName, workspaceName));
  return raw ? migrateGoalRecord(raw) : null;
}

export function writeWorkspaceGoal(projectName: string, workspaceName: string, goal: GoalRecord): GoalRecord {
  const timestamp = nowIso();
  const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
  ensureWorkspaceStorageIgnored(workspaceDir);
  const nextGoal: GoalRecord = {
    ...goal,
    version: 2,
    projectName,
    workspaceName,
    plannedWorkspaceName: goal.plannedWorkspaceName ?? workspaceName,
    updatedAt: timestamp,
  };
  writeJsonFile(getWorkspaceGoalPath(projectName, workspaceName), nextGoal);
  return nextGoal;
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => join(dir, entry));
}

export function listPlannedGoals(projectName: string): GoalRecord[] {
  const dir = join(getProjectGoalStorageDir(projectName), PLANNED_GOAL_DIR);
  return listJsonFiles(dir)
    .map((filePath) => {
      const raw = readJsonFile<unknown>(filePath);
      return raw ? migrateGoalRecord(raw) : null;
    })
    .filter((goal): goal is GoalRecord => goal !== null);
}

export function listArchivedGoals(projectName: string): GoalRecord[] {
  const dir = join(getProjectGoalStorageDir(projectName), ARCHIVED_GOAL_DIR);
  return listJsonFiles(dir)
    .map((filePath) => {
      const raw = readJsonFile<unknown>(filePath);
      return raw ? migrateGoalRecord(raw) : null;
    })
    .filter((goal): goal is GoalRecord => goal !== null);
}

export function listWorkspaceGoals(projectName: string): GoalRecord[] {
  const workspacesDir = getProjectWorkspacesDir(projectName);
  if (!existsSync(workspacesDir)) {
    return [];
  }
  return readdirSync(workspacesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readWorkspaceGoal(projectName, entry.name))
    .filter((goal): goal is GoalRecord => goal !== null);
}

export function listProjectGoalRecords(projectName: string): GoalRecord[] {
  // Resolution precedence (lowest → highest, later writes win by id):
  //   archived (fallback for a deleted workspace) < planned (not yet started)
  //   < live workspace goal (freshest/editable). An archived record only
  //   surfaces when no live/planned record with that id exists.
  const byId = new Map<string, GoalRecord>();
  for (const goal of listArchivedGoals(projectName)) {
    byId.set(goal.id, goal);
  }
  for (const goal of listPlannedGoals(projectName)) {
    byId.set(goal.id, goal);
  }
  for (const goal of listWorkspaceGoals(projectName)) {
    byId.set(goal.id, goal);
  }
  return [...byId.values()];
}

function defaultGoalDoc(title: string): GoalRecord['doc'] {
  return {
    bodyMarkdown: `# ${title}\n\n## Objective\n\n## Non-goals\n\n## Validation\n`,
    updatedAt: nowIso(),
  };
}

function defaultGoalValidation(): GoalRecord['validation'] {
  return defaultValidation();
}

function makeGoalId(title: string): string {
  const sanitized = sanitizeForFileSystem(title).slice(0, 48);
  return `${sanitized || 'goal'}-${generateId().slice(0, 8)}`;
}

function makeChainId(title: string): string {
  const sanitized = sanitizeForFileSystem(title).slice(0, 48);
  return `chain-${sanitized || 'chain'}-${generateId().slice(0, 8)}`;
}

export function findGoalRecord(projectName: string, token: string): GoalRecord | null {
  const goals = listProjectGoalRecords(projectName);
  return goals.find((goal) =>
    goal.id === token ||
    goal.workspaceName === token ||
    goal.plannedWorkspaceName === token ||
    goal.title === token
  ) ?? null;
}

export function getGoalRecord(projectName: string, goalId: string): GoalRecord | null {
  return listProjectGoalRecords(projectName).find((goal) => goal.id === goalId) ?? null;
}

export function writeGoalRecord(projectName: string, goal: GoalRecord): GoalRecord {
  // CLI-write visibility (ticket #3): queue a fire-and-forget daemon notify
  // so watching clients get a scoped delta instead of waiting on a poll.
  queueGoalChangeNotify(projectName);
  if (goal.workspaceName) {
    const written = writeWorkspaceGoal(projectName, goal.workspaceName, goal);
    mirrorGoalCanonToArtifacts(projectName, goal.workspaceName, written);
    return written;
  }
  return writePlannedGoal(projectName, goal);
}

/**
 * Canon write-through (docs/REVIEW-GUIDE.md): mirror the goal doc + rubric to
 * the workspace's artifacts branch so canon history is append-only via git.
 * Journal snapshots and judgments pin hashes into this history. Never blocks
 * a goal write — degrades silently without a mount.
 */
function mirrorGoalCanonToArtifacts(projectName: string, workspaceName: string, goal: GoalRecord): void {
  try {
    const workspaceDir = join(getProjectWorkspacesDir(projectName), workspaceName);
    const scope = artifactsScope(workspaceDir);
    if (!existsSync(join(scope.mountDir, '.git'))) return;
    const rubricCanon = {
      goalId: goal.id,
      requirements: (goal.validation?.reqOrder ?? Object.keys(goal.validation?.requirements ?? {}))
        .map((id) => goal.validation?.requirements?.[id])
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({ id: r.id, title: r.title, kind: r.kind, required: r.required, rubric: r.rubric, judgment: r.judgment })),
    };
    const goalMd = [
      `# ${goal.title}`,
      '',
      goal.doc?.bodyMarkdown ?? '',
      goal.doc?.blocks?.length ? `\n<!-- blocks:${JSON.stringify(goal.doc.blocks)} -->` : '',
    ].join('\n');
    // Canon lands in the goal's own folder (`goals/<goal-id>/goal.md`), not at
    // the mount root. Root canon is exactly what used to make two workspace
    // branches collide on roll-up (docs/ARTIFACTS-FS.md "Tree layout").
    const files = [
      { path: scope.rel('goal.md'), content: goalMd },
      { path: scope.rel('rubric.json'), content: `${JSON.stringify(rubricCanon, null, 2)}\n` },
    ];
    // Skip the commit when canon is unchanged (captureArtifactsSync would
    // no-op on identical content, but avoid the git round-trip entirely).
    const unchanged = files.every((f) => {
      const target = join(scope.mountDir, f.path);
      return existsSync(target) && readFileSync(target, 'utf-8') === f.content;
    });
    if (unchanged) return;
    captureArtifactsSync(getProjectDir(projectName), scope.mountDir, files, {
      message: `canon: goal ${goal.id}`,
      provenance: { tool: 'goal-canon' },
    });
  } catch {
    /* canon mirroring must never break goal persistence */
  }
}

export function updateGoalRecord(projectName: string, goalId: string, updates: GoalUpdateInput): GoalRecord {
  const current = getGoalRecord(projectName, goalId);
  if (!current) {
    throw new SpacesError(`Goal not found: ${goalId}`, 'USER_ERROR', 1);
  }
  return writeGoalRecord(projectName, {
    ...current,
    ...updates,
    doc: updates.doc ?? current.doc,
    validation: updates.validation ?? current.validation,
    sourceRefs: updates.sourceRefs ?? current.sourceRefs,
    updatedAt: nowIso(),
  });
}

export function resolveWorkspaceGoal(projectName: string, workspaceName: string): GoalRecord | null {
  return readWorkspaceGoal(projectName, workspaceName)
    ?? listPlannedGoals(projectName).find((goal) => goal.plannedWorkspaceName === workspaceName)
    ?? null;
}

function getEffectiveGoalPhase(projectName: string, goal: GoalRecord): GoalRecord['phase'] {
  if (!goal.workspaceName) {
    return 'plan';
  }
  return getWorkspaceStatus(projectName, goal.workspaceName) ?? goal.phase;
}

function buildGoalPhaseMap(projectName: string, goalIds: string[], overrides: Map<string, GoalRecord['phase']> = new Map()) {
  const goalsById = new Map(listProjectGoalRecords(projectName).map((item) => [item.id, item]));
  const phases = new Map<string, GoalRecord['phase']>();
  for (const goalId of goalIds) {
    const chainGoal = goalsById.get(goalId);
    if (chainGoal) {
      phases.set(goalId, overrides.get(goalId) ?? getEffectiveGoalPhase(projectName, chainGoal));
    }
  }
  return { goalsById, phases };
}

function assertChainGoalOrderPhasesAllowed(
  projectName: string,
  goalIds: string[],
  overrides: Map<string, GoalRecord['phase']> = new Map(),
): void {
  const { goalsById, phases } = buildGoalPhaseMap(projectName, goalIds, overrides);
  for (let ancestorIndex = 0; ancestorIndex < goalIds.length; ancestorIndex += 1) {
    const ancestorId = goalIds[ancestorIndex];
    const ancestorPhase = ancestorId ? phases.get(ancestorId) : undefined;
    if (!ancestorPhase) continue;
    for (let descendantIndex = ancestorIndex + 1; descendantIndex < goalIds.length; descendantIndex += 1) {
      const descendantId = goalIds[descendantIndex];
      const descendantPhase = descendantId ? phases.get(descendantId) : undefined;
      if (!descendantPhase) continue;
      if (phaseIndex(descendantPhase) > phaseIndex(ancestorPhase)) {
        const ancestor = goalsById.get(ancestorId);
        const descendant = goalsById.get(descendantId);
        throw new SpacesError(
          `Cannot order "${descendant?.title ?? descendantId}" after "${ancestor?.title ?? ancestorId}": ${descendantPhase} is further along than ${ancestorPhase}.`,
          'USER_ERROR',
          1,
        );
      }
    }
  }
}

export function previewWorkspaceGoalPhaseChange(projectName: string, workspaceName: string, phase: GoalRecord['phase']): WorkspacePhaseChangePreview {
  const goal = readWorkspaceGoal(projectName, workspaceName);
  if (!goal) {
    return {
      allowed: true,
      requiresCascade: false,
      requestedPhase: phase,
      affected: [],
      message: `Move "${workspaceName}" to ${phase}.`,
    };
  }

  const state = readGoalChainState(projectName);
  const chain = state.chains.find((item) => item.id === goal.chainId);
  if (!chain) {
    return {
      allowed: true,
      requiresCascade: false,
      requestedPhase: phase,
      affected: [],
      message: `Move "${goal.title}" to ${phase}.`,
    };
  }

  const index = chain.goalIds.indexOf(goal.id);
  if (index < 0) {
    return {
      allowed: true,
      requiresCascade: false,
      requestedPhase: phase,
      affected: [],
      message: `Move "${goal.title}" to ${phase}.`,
    };
  }

  const { goalsById, phases } = buildGoalPhaseMap(projectName, chain.goalIds);
  let maxAllowedIndex = GOAL_PHASE_ORDER.length - 1;
  for (let ancestorIndex = 0; ancestorIndex < index; ancestorIndex += 1) {
    const ancestorId = chain.goalIds[ancestorIndex];
    const ancestorPhase = ancestorId ? phases.get(ancestorId) : undefined;
    if (ancestorPhase) {
      maxAllowedIndex = Math.min(maxAllowedIndex, phaseIndex(ancestorPhase));
    }
  }

  if (phaseIndex(phase) > maxAllowedIndex) {
    const maxAllowedPhase = phaseAt(maxAllowedIndex);
    return {
      allowed: false,
      requiresCascade: false,
      requestedPhase: phase,
      maxAllowedPhase,
      affected: [],
      message: `Cannot move "${goal.title}" to ${phase}. Max allowed phase is ${maxAllowedPhase} because an ancestor is only ${maxAllowedPhase}.`,
    };
  }

  const affected: WorkspacePhaseCascadeItem[] = [];
  let ceilingIndex = phaseIndex(phase);
  for (let descendantIndex = index + 1; descendantIndex < chain.goalIds.length; descendantIndex += 1) {
    const descendantId = chain.goalIds[descendantIndex];
    if (!descendantId) continue;
    const descendant = goalsById.get(descendantId);
    const descendantPhase = phases.get(descendantId);
    if (!descendant || !descendantPhase) continue;
    const nextIndex = Math.min(phaseIndex(descendantPhase), ceilingIndex);
    if (descendant.workspaceName && nextIndex < phaseIndex(descendantPhase)) {
      affected.push({
        workspaceName: descendant.workspaceName,
        goalId: descendant.id,
        title: descendant.title,
        from: descendantPhase,
        to: phaseAt(nextIndex),
      });
    }
    ceilingIndex = nextIndex;
  }

  if (affected.length > 0) {
    return {
      allowed: true,
      requiresCascade: true,
      requestedPhase: phase,
      affected,
      message: `Moving "${goal.title}" to ${phase} also requires moving ${affected.length} descendant workspace${affected.length === 1 ? '' : 's'} back.`,
    };
  }

  return {
    allowed: true,
    requiresCascade: false,
    requestedPhase: phase,
    affected: [],
    message: `Move "${goal.title}" to ${phase}.`,
  };
}

export function applyWorkspaceGoalPhaseChange(projectName: string, workspaceName: string, phase: GoalRecord['phase'], options: { cascade?: boolean } = {}): WorkspacePhaseChangePreview {
  const preview = previewWorkspaceGoalPhaseChange(projectName, workspaceName, phase);
  if (!preview.allowed) {
    throw new SpacesError(preview.message, 'USER_ERROR', 1);
  }
  if (preview.requiresCascade && !options.cascade) {
    throw new SpacesError(preview.message, 'USER_ERROR', 1);
  }

  setWorkspaceStatus(projectName, workspaceName, phase);
  const goal = readWorkspaceGoal(projectName, workspaceName);
  if (goal) {
    writeWorkspaceGoal(projectName, workspaceName, { ...goal, phase });
  }
  for (const item of preview.affected) {
    setWorkspaceStatus(projectName, item.workspaceName, item.to);
    const descendantGoal = readWorkspaceGoal(projectName, item.workspaceName);
    if (descendantGoal) {
      writeWorkspaceGoal(projectName, item.workspaceName, { ...descendantGoal, phase: item.to });
    }
  }
  return preview;
}


export function assertWorkspaceGoalPhaseAllowed(projectName: string, workspaceName: string, phase: GoalRecord['phase']): void {
  const preview = previewWorkspaceGoalPhaseChange(projectName, workspaceName, phase);
  if (!preview.allowed || preview.requiresCascade) {
    throw new SpacesError(preview.message, 'USER_ERROR', 1);
  }
}

export function setWorkspaceStatusForGoalChain(projectName: string, workspaceName: string, phase: GoalRecord['phase']): void {
  applyWorkspaceGoalPhaseChange(projectName, workspaceName, phase, { cascade: false });
}

export function ensureWorkspaceGoalChain(projectName: string, workspaceName: string): { chain: GoalChain; goal: GoalRecord } {
  const existingGoal = resolveWorkspaceGoal(projectName, workspaceName);
  const state = readGoalChainState(projectName);

  if (existingGoal) {
    const chain = state.chains.find((item) => item.id === existingGoal.chainId);
    if (chain) {
      return { chain, goal: existingGoal };
    }
  }

  const timestamp = nowIso();
  const goalId = existingGoal?.id ?? makeGoalId(workspaceName);
  const chainId = existingGoal?.chainId ?? goalId;
  const goal: GoalRecord = existingGoal ?? {
    version: 2,
    id: goalId,
    chainId,
    title: workspaceName,
    projectName,
    phase: getWorkspaceStatus(projectName, workspaceName) ?? 'code',
    plannedWorkspaceName: workspaceName,
    workspaceName,
    doc: defaultGoalDoc(workspaceName),
    validation: defaultGoalValidation(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const writtenGoal = writeGoalRecord(projectName, { ...goal, chainId });
  const chain: GoalChain = {
    id: chainId,
    title: writtenGoal.title,
    projectName,
    goalIds: [writtenGoal.id],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { chain: upsertGoalChain(projectName, chain), goal: writtenGoal };
}

/** One row of a rendered chain order — what `--dry-run` prints. */
export interface ChainOrderEntry {
  id: string;
  title: string;
  status: 'planned' | 'workspace-backed';
  workspaceName?: string;
  phase: GoalRecord['phase'];
  position: number;
}

/** Shared result of a chain-mutating verb, so `--dry-run` and the real
 *  write return the identical shape (the preview IS the plan). */
export interface ChainMutationResult {
  chain: GoalChain;
  goalIds: string[];
  order: ChainOrderEntry[];
  /** The goal added (add verbs) or removed (remove verb). */
  goal?: GoalRecord;
  /** Non-fatal guard/cascade notes to surface to the caller. */
  warnings: string[];
  dryRun: boolean;
  /** Remove verb: whether the planned doc was (or would be) deleted. */
  deletedPlannedDoc?: boolean;
}

/** Render a prospective chain order without writing it. `pending` lets the
 *  caller describe a goal that does not exist on disk yet (dry-run adds). */
function describeChainOrder(projectName: string, goalIds: string[], pending?: GoalRecord): ChainOrderEntry[] {
  const byId = new Map(listProjectGoalRecords(projectName).map((goal) => [goal.id, goal]));
  if (pending) byId.set(pending.id, pending);
  const entries: ChainOrderEntry[] = [];
  goalIds.forEach((goalId, index) => {
    const goal = byId.get(goalId);
    if (!goal) return;
    entries.push({
      id: goal.id,
      title: goal.title,
      status: goal.workspaceName ? 'workspace-backed' : 'planned',
      workspaceName: goal.workspaceName ?? goal.plannedWorkspaceName,
      phase: goal.phase,
      position: index + 1,
    });
  });
  return entries;
}

/** Run the reorder guard and collect its complaint instead of throwing —
 *  used where a phase conflict is worth reporting but not worth refusing. */
function collectPhaseOrderWarning(projectName: string, goalIds: string[], warnings: string[]): void {
  try {
    assertChainGoalOrderPhasesAllowed(projectName, goalIds);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
}

export interface AddGoalToChainInput {
  title: string;
  /** Anchored insert: goal id / workspace / planned workspace / title. */
  anchor?: string;
  /** Anchored insert side. Ignored for `tail` / `index`. */
  position?: 'before' | 'after';
  /** Absolute insert at the end of the chain. */
  tail?: boolean;
  /** Absolute insert at a 0-indexed position. */
  index?: number;
  dryRun?: boolean;
}

/**
 * Insert a planned goal into the active workspace's chain. Supports anchored
 * inserts (`--goal <target>` + before/after, defaulting to the active goal)
 * and absolute inserts (`--tail`, `--at <index>`). Enforces the same
 * phase-legality rule the reorder path enforces.
 */
export function addGoalToChain(
  projectName: string,
  workspaceName: string,
  input: AddGoalToChainInput,
): ChainMutationResult {
  const { chain, goal: activeGoal } = ensureWorkspaceGoalChain(projectName, workspaceName);
  const goalIds = [...chain.goalIds];
  const warnings: string[] = [];

  let insertIndex: number;
  let phaseSourceId: string | undefined;

  if (input.index !== undefined) {
    if (!Number.isInteger(input.index) || input.index < 0) {
      throw new SpacesError(`--at must be a non-negative integer (got ${input.index}).`, 'USER_ERROR', 1);
    }
    if (input.index > goalIds.length) {
      throw new SpacesError(
        `--at ${input.index} is past the end of the chain (${goalIds.length} goal${goalIds.length === 1 ? '' : 's'}). Use --tail to append.`,
        'USER_ERROR',
        1,
      );
    }
    insertIndex = input.index;
    phaseSourceId = goalIds[insertIndex] ?? goalIds[goalIds.length - 1];
  } else if (input.tail) {
    insertIndex = goalIds.length;
    phaseSourceId = goalIds[goalIds.length - 1];
  } else {
    const position = input.position ?? 'after';
    const anchor = input.anchor ? findGoalRecord(projectName, input.anchor) : activeGoal;
    if (!anchor) {
      throw new SpacesError(`Anchor goal not found: ${input.anchor}`, 'USER_ERROR', 1);
    }
    const anchorIndex = goalIds.indexOf(anchor.id);
    if (anchorIndex < 0) {
      throw new SpacesError(`Anchor goal is not in chain ${chain.title}: ${input.anchor ?? anchor.id}`, 'USER_ERROR', 1);
    }
    insertIndex = position === 'before' ? anchorIndex : anchorIndex + 1;
    // With an IMPLICIT anchor (the active goal), `after` lands past any
    // planned goals already trailing it, so repeated add-after calls append
    // in the order they were issued. An EXPLICIT --goal anchor is taken
    // literally: "after X" means immediately after X.
    if (position === 'after' && !input.anchor) {
      while (insertIndex < goalIds.length) {
        const descendant = getGoalRecord(projectName, goalIds[insertIndex]);
        if (!descendant || descendant.workspaceName) break;
        insertIndex += 1;
      }
    }
    phaseSourceId = anchor.id;
  }

  const phaseSource = phaseSourceId ? getGoalRecord(projectName, phaseSourceId) : undefined;
  const timestamp = nowIso();
  const pendingGoal: GoalRecord = {
    version: 2,
    id: makeGoalId(input.title),
    chainId: chain.id,
    title: input.title,
    projectName,
    phase: phaseSource?.phase ?? activeGoal.phase,
    plannedWorkspaceName: sanitizeForFileSystem(input.title) || undefined,
    doc: defaultGoalDoc(input.title),
    validation: defaultGoalValidation(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const nextGoalIds = [...goalIds];
  nextGoalIds.splice(Math.max(0, insertIndex), 0, pendingGoal.id);

  // A brand-new planned goal always reads as phase `plan`. The reorder guard
  // forbids a descendant from outpacing an ancestor, so the only way this
  // insert can be illegal is if something at or after `insertIndex` has
  // already moved past plan. (The new goal as a *descendant* is always fine.)
  const { goalsById, phases } = buildGoalPhaseMap(projectName, goalIds);
  for (let i = insertIndex; i < goalIds.length; i += 1) {
    const descendantId = goalIds[i];
    const descendantPhase = descendantId ? phases.get(descendantId) : undefined;
    if (descendantPhase && phaseIndex(descendantPhase) > phaseIndex('plan')) {
      const descendant = descendantId ? goalsById.get(descendantId) : undefined;
      throw new SpacesError(
        `Cannot insert "${input.title}" before "${descendant?.title ?? descendantId}": ${descendantPhase} is further along than plan.`,
        'USER_ERROR',
        1,
      );
    }
  }
  // Surface (never block on) a pre-existing violation in the untouched order.
  collectPhaseOrderWarning(projectName, goalIds, warnings);

  if (input.dryRun) {
    return {
      chain: { ...chain, goalIds: nextGoalIds },
      goalIds: nextGoalIds,
      order: describeChainOrder(projectName, nextGoalIds, pendingGoal),
      goal: pendingGoal,
      warnings,
      dryRun: true,
    };
  }

  const newGoal = writePlannedGoal(projectName, pendingGoal);
  const nextChain = upsertGoalChain(projectName, { ...chain, goalIds: nextGoalIds });
  return {
    chain: nextChain,
    goalIds: nextGoalIds,
    order: describeChainOrder(projectName, nextGoalIds),
    goal: newGoal,
    warnings,
    dryRun: false,
  };
}

export function addGoalNearWorkspace(projectName: string, workspaceName: string, title: string, position: 'before' | 'after'): GoalRecord {
  const result = addGoalToChain(projectName, workspaceName, { title, position });
  return result.goal as GoalRecord;
}

/**
 * List the project's chains projected for the create-goal UI: each chain's
 * title plus its goals in order with their EFFECTIVE phase (a planned goal
 * with no workspace always reads as 'plan'). The UI uses the phases to offer
 * only positions that `addPlannedGoalToChain` would accept.
 */
export function listGoalChainSummaries(projectName: string): GoalChainSummary[] {
  const state = readGoalChainState(projectName);
  const goalsById = new Map(listProjectGoalRecords(projectName).map((goal) => [goal.id, goal]));
  return state.chains.map((chain) => {
    const goals: GoalChainSummaryGoal[] = [];
    for (const goalId of chain.goalIds) {
      const goal = goalsById.get(goalId);
      if (!goal) continue;
      goals.push({
        id: goal.id,
        title: goal.title,
        phase: getEffectiveGoalPhase(projectName, goal),
        status: goal.workspaceName ? 'workspace-backed' : 'planned',
      });
    }
    return { id: chain.id, title: chain.title, goals };
  });
}

/** Where a new planned goal lands in an existing chain. Mirrors the legal
 *  spots the UI is allowed to offer. */
export type AddPlannedGoalPosition =
  | { kind: 'tail' }
  | { kind: 'index'; index: number }
  | { kind: 'anchor'; anchor: string; side: 'before' | 'after' };

export interface AddPlannedGoalToChainInput {
  title: string;
  /** Target an existing chain by id. Mutually exclusive with newChainTitle. */
  chainId?: string;
  /** Create a brand-new chain seeded with this goal as its only member. */
  newChainTitle?: string;
  /** Position within an existing chain. Ignored when newChainTitle is set
   *  (a new chain is empty, so the goal is its tail). Defaults to tail. */
  position?: AddPlannedGoalPosition;
}

/**
 * Chain-centric goal creation — no workspace involved. Either seeds a NEW
 * chain with a first planned goal, or inserts a planned goal at a position in
 * an EXISTING chain. Enforces the same phase-legality rule as `addGoalToChain`:
 * a brand-new goal reads as 'plan', so an insert is refused if any goal at or
 * after the insert point has advanced past 'plan'. The workspace-free sibling
 * of `addGoalToChain`.
 */
export function addPlannedGoalToChain(
  projectName: string,
  input: AddPlannedGoalToChainInput,
): ChainMutationResult {
  const title = input.title.trim();
  if (!title) {
    throw new SpacesError('Goal title is required.', 'USER_ERROR', 1);
  }
  const timestamp = nowIso();

  // ── New chain: create the chain and seed it with this single planned goal ──
  if (input.newChainTitle !== undefined) {
    const chainTitle = input.newChainTitle.trim();
    if (!chainTitle) {
      throw new SpacesError('Chain title is required.', 'USER_ERROR', 1);
    }
    const chainId = makeChainId(chainTitle);
    const pendingGoal: GoalRecord = {
      version: 2,
      id: makeGoalId(title),
      chainId,
      title,
      projectName,
      phase: 'plan',
      plannedWorkspaceName: sanitizeForFileSystem(title) || undefined,
      doc: defaultGoalDoc(title),
      validation: defaultGoalValidation(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const newGoal = writePlannedGoal(projectName, pendingGoal);
    const chain = upsertGoalChain(projectName, {
      id: chainId,
      title: chainTitle,
      projectName,
      goalIds: [newGoal.id],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return {
      chain,
      goalIds: chain.goalIds,
      order: describeChainOrder(projectName, chain.goalIds),
      goal: newGoal,
      warnings: [],
      dryRun: false,
    };
  }

  // ── Existing chain: insert at the requested (legal) position ──
  if (!input.chainId) {
    throw new SpacesError('addPlannedGoalToChain requires a chainId or a newChainTitle.', 'USER_ERROR', 1);
  }
  const state = readGoalChainState(projectName);
  const chain = state.chains.find((item) => item.id === input.chainId);
  if (!chain) {
    throw new SpacesError(`Chain not found: ${input.chainId}`, 'USER_ERROR', 1);
  }
  const goalIds = [...chain.goalIds];
  const position = input.position ?? { kind: 'tail' };

  let insertIndex: number;
  if (position.kind === 'tail') {
    insertIndex = goalIds.length;
  } else if (position.kind === 'index') {
    if (!Number.isInteger(position.index) || position.index < 0 || position.index > goalIds.length) {
      throw new SpacesError(
        `Insert index ${position.index} is out of range for chain "${chain.title}" (${goalIds.length} goal${goalIds.length === 1 ? '' : 's'}).`,
        'USER_ERROR',
        1,
      );
    }
    insertIndex = position.index;
  } else {
    const anchorIndex = goalIds.indexOf(position.anchor);
    if (anchorIndex < 0) {
      throw new SpacesError(`Anchor goal is not in chain "${chain.title}": ${position.anchor}`, 'USER_ERROR', 1);
    }
    insertIndex = position.side === 'before' ? anchorIndex : anchorIndex + 1;
  }

  // A brand-new planned goal always reads as phase `plan`. The insert is
  // illegal iff any goal at or after `insertIndex` has advanced past plan.
  const { goalsById, phases } = buildGoalPhaseMap(projectName, goalIds);
  for (let i = insertIndex; i < goalIds.length; i += 1) {
    const descendantId = goalIds[i];
    const descendantPhase = descendantId ? phases.get(descendantId) : undefined;
    if (descendantPhase && phaseIndex(descendantPhase) > phaseIndex('plan')) {
      const descendant = descendantId ? goalsById.get(descendantId) : undefined;
      throw new SpacesError(
        `Cannot insert "${title}" before "${descendant?.title ?? descendantId}": ${descendantPhase} is further along than plan.`,
        'USER_ERROR',
        1,
      );
    }
  }

  const pendingGoal: GoalRecord = {
    version: 2,
    id: makeGoalId(title),
    chainId: chain.id,
    title,
    projectName,
    phase: 'plan',
    plannedWorkspaceName: sanitizeForFileSystem(title) || undefined,
    doc: defaultGoalDoc(title),
    validation: defaultGoalValidation(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const nextGoalIds = [...goalIds];
  nextGoalIds.splice(Math.max(0, insertIndex), 0, pendingGoal.id);

  const warnings: string[] = [];
  // Surface (never block on) a pre-existing violation in the untouched order.
  collectPhaseOrderWarning(projectName, goalIds, warnings);

  const newGoal = writePlannedGoal(projectName, pendingGoal);
  const nextChain = upsertGoalChain(projectName, { ...chain, goalIds: nextGoalIds });
  return {
    chain: nextChain,
    goalIds: nextGoalIds,
    order: describeChainOrder(projectName, nextGoalIds),
    goal: newGoal,
    warnings,
    dryRun: false,
  };
}

export interface RemoveGoalFromChainOptions {
  /** Required to detach a workspace-backed goal. */
  force?: boolean;
  /** Detach from the chain but leave planned/<id>.json on disk. */
  detachOnly?: boolean;
  dryRun?: boolean;
}

/**
 * Remove a goal from its chain. A planned goal is detached AND its doc is
 * deleted (unless `detachOnly`). A workspace-backed goal is never dropped
 * implicitly — it needs `force`, and even then only detaches; the worktree
 * and its goal.json are left alone.
 */
export function removeGoalFromChain(
  projectName: string,
  token: string,
  options: RemoveGoalFromChainOptions = {},
): ChainMutationResult {
  const goal = findGoalRecord(projectName, token);
  if (!goal) {
    throw new SpacesError(`Goal not found: ${token}`, 'USER_ERROR', 1);
  }

  const state = readGoalChainState(projectName);
  const chain = state.chains.find((item) => item.id === goal.chainId);
  if (!chain) {
    throw new SpacesError(`Chain not found: ${goal.chainId}`, 'USER_ERROR', 1);
  }
  if (!chain.goalIds.includes(goal.id)) {
    throw new SpacesError(`Goal is not in chain ${chain.title}: ${token}`, 'USER_ERROR', 1);
  }

  if (goal.workspaceName && !options.force) {
    throw new SpacesError(
      `"${goal.title}" is backed by workspace "${goal.workspaceName}". Remove the workspace first ` +
        `(\`gssh workspace remove ${goal.workspaceName} --project ${projectName}\`), or pass --force to detach ` +
        'the goal from the chain and leave the worktree in place.',
      'USER_ERROR',
      1,
    );
  }

  const warnings: string[] = [];
  const nextGoalIds = chain.goalIds.filter((id) => id !== goal.id);
  if (nextGoalIds.length === 0) {
    warnings.push(`Chain "${chain.title}" will have no goals left after this removal.`);
  }
  if (goal.workspaceName) {
    warnings.push(
      `Workspace "${goal.workspaceName}" and its goal.json are left in place; only the chain link is removed.`,
    );
  }
  // Removing a member of a legal order cannot introduce a violation, but
  // report it rather than silently swallow if the chain was already bad.
  collectPhaseOrderWarning(projectName, nextGoalIds, warnings);

  const deletesPlannedDoc = !goal.workspaceName && !options.detachOnly;
  if (!goal.workspaceName && options.detachOnly) {
    warnings.push(`Planned doc kept at ${getPlannedGoalPath(projectName, goal.id)} (orphaned — no chain references it).`);
  }

  if (options.dryRun) {
    return {
      chain: { ...chain, goalIds: nextGoalIds },
      goalIds: nextGoalIds,
      order: describeChainOrder(projectName, nextGoalIds),
      goal,
      warnings,
      dryRun: true,
      deletedPlannedDoc: deletesPlannedDoc,
    };
  }

  const nextChain = upsertGoalChain(projectName, { ...chain, goalIds: nextGoalIds });
  if (deletesPlannedDoc) {
    rmSync(getPlannedGoalPath(projectName, goal.id), { force: true });
    rmSync(getPlannedGoalValidationDir(projectName, goal.id), { recursive: true, force: true });
  }

  return {
    chain: nextChain,
    goalIds: nextGoalIds,
    order: describeChainOrder(projectName, nextGoalIds),
    goal,
    warnings,
    dryRun: false,
    deletedPlannedDoc: deletesPlannedDoc,
  };
}

export function moveGoalInChain(projectName: string, sourceToken: string, targetToken: string, position: 'before' | 'after'): GoalChain {
  const source = findGoalRecord(projectName, sourceToken);
  const target = findGoalRecord(projectName, targetToken);
  if (!source) {
    throw new SpacesError(`Goal not found: ${sourceToken}`, 'USER_ERROR', 1);
  }
  if (!target) {
    throw new SpacesError(`Target goal not found: ${targetToken}`, 'USER_ERROR', 1);
  }
  if (source.chainId !== target.chainId) {
    throw new SpacesError('Cannot move goals across chains in the linear MVP.', 'USER_ERROR', 1);
  }
  const state = readGoalChainState(projectName);
  const chain = state.chains.find((item) => item.id === source.chainId);
  if (!chain) {
    throw new SpacesError(`Chain not found: ${source.chainId}`, 'USER_ERROR', 1);
  }
  const withoutSource = chain.goalIds.filter((id) => id !== source.id);
  const targetIndex = withoutSource.indexOf(target.id);
  if (targetIndex < 0) {
    throw new SpacesError(`Target goal is not in chain: ${targetToken}`, 'USER_ERROR', 1);
  }
  const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
  withoutSource.splice(insertIndex, 0, source.id);
  assertChainGoalOrderPhasesAllowed(projectName, withoutSource);
  return upsertGoalChain(projectName, { ...chain, goalIds: withoutSource });
}

/**
 * Preview a reorder without writing: same resolution + guards as
 * `moveGoalInChain`, but returns the prospective order instead of saving it.
 */
export function previewMoveGoalInChain(
  projectName: string,
  sourceToken: string,
  targetToken: string,
  position: 'before' | 'after',
): ChainMutationResult {
  const source = findGoalRecord(projectName, sourceToken);
  const target = findGoalRecord(projectName, targetToken);
  if (!source) {
    throw new SpacesError(`Goal not found: ${sourceToken}`, 'USER_ERROR', 1);
  }
  if (!target) {
    throw new SpacesError(`Target goal not found: ${targetToken}`, 'USER_ERROR', 1);
  }
  if (source.chainId !== target.chainId) {
    throw new SpacesError('Cannot move goals across chains in the linear MVP.', 'USER_ERROR', 1);
  }
  const state = readGoalChainState(projectName);
  const chain = state.chains.find((item) => item.id === source.chainId);
  if (!chain) {
    throw new SpacesError(`Chain not found: ${source.chainId}`, 'USER_ERROR', 1);
  }
  const withoutSource = chain.goalIds.filter((id) => id !== source.id);
  const targetIndex = withoutSource.indexOf(target.id);
  if (targetIndex < 0) {
    throw new SpacesError(`Target goal is not in chain: ${targetToken}`, 'USER_ERROR', 1);
  }
  withoutSource.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, source.id);
  assertChainGoalOrderPhasesAllowed(projectName, withoutSource);
  return {
    chain: { ...chain, goalIds: withoutSource },
    goalIds: withoutSource,
    order: describeChainOrder(projectName, withoutSource),
    goal: source,
    warnings: [],
    dryRun: true,
  };
}

export function listProjectGoalKanbanItems(projectName: string): GoalKanbanItem[] {
  const state = readGoalChainState(projectName);
  const goalsById = new Map(listProjectGoalRecords(projectName).map((goal) => [goal.id, goal]));
  const result: GoalKanbanItem[] = [];

  for (const chain of state.chains) {
    const chainGoals = chain.goalIds.map((goalId) => goalsById.get(goalId));
    chainGoals.forEach((goal, index) => {
      if (!goal) {
        return;
      }
      const previous = index > 0 ? chainGoals[index - 1] : undefined;
      const blockedReason = previous && !previous.workspaceName
        ? `Previous goal ${previous.title} has no workspace yet`
        : undefined;
      result.push({
        id: goal.id,
        chainId: chain.id,
        chainTitle: chain.title,
        title: goal.title,
        projectName,
        phase: goal.phase,
        plannedWorkspaceName: goal.plannedWorkspaceName,
        workspaceName: goal.workspaceName,
        status: goal.workspaceName ? 'workspace-backed' : 'planned',
        chainPosition: index + 1,
        chainLength: chain.goalIds.length,
        previousGoalId: previous?.id,
        previousWorkspaceName: previous?.workspaceName ?? previous?.plannedWorkspaceName,
        blockedReason,
        doc: goal.doc,
        validation: {
          ...goal.validation,
          readiness: computeReadiness(goal.validation),
        },
        sourceRefs: goal.sourceRefs,
        updatedAt: goal.updatedAt,
      });
    });
  }

  return result;
}

export function findPlannedGoalForWorkspace(projectName: string, workspaceName: string): GoalKanbanItem | null {
  return listProjectGoalKanbanItems(projectName).find((goal) =>
    goal.status === 'planned' && goal.plannedWorkspaceName === workspaceName
  ) ?? null;
}


export function bindGoalToWorkspace(projectName: string, goalId: string, workspaceName: string): GoalRecord {
  assertSafeSegment(goalId, 'goalId');
  assertSafeSegment(workspaceName, 'workspaceName');

  const planned = readPlannedGoal(projectName, goalId);
  const existingWorkspaceGoal = readWorkspaceGoal(projectName, workspaceName);
  const goal = planned ?? existingWorkspaceGoal;
  if (!goal) {
    throw new SpacesError(`Goal not found: ${goalId}`, 'USER_ERROR', 1);
  }

  const bound = writeWorkspaceGoal(projectName, workspaceName, {
    ...goal,
    workspaceName,
    plannedWorkspaceName: goal.plannedWorkspaceName ?? workspaceName,
  });
  setWorkspaceStatus(projectName, workspaceName, bound.phase);
  moveGoalValidationToWorkspace(projectName, goal.id, workspaceName);

  const plannedPath = getPlannedGoalPath(projectName, goalId);
  if (existsSync(plannedPath)) {
    rmSync(plannedPath, { force: true });
  }

  return bound;
}

export function bindPlannedGoalForWorkspace(projectName: string, workspaceName: string): GoalRecord | null {
  const plannedGoal = findPlannedGoalForWorkspace(projectName, workspaceName);
  if (!plannedGoal) {
    return null;
  }
  return bindGoalToWorkspace(projectName, plannedGoal.id, workspaceName);
}
