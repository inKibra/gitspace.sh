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
import { defaultValidation, migrateGoalRecord, moveGoalValidationToWorkspace } from './goal-validation.js';
import { computeReadiness } from '../app/shared/goal-validation/readiness.js';
import { ensureWorkspaceStorageIgnored, getWorkspaceStatus, getWorkspaceStorageDir, setWorkspaceStatus } from './workspace-metadata.js';
import { SpacesError } from '../types/errors.js';
import { generateId } from '../utils/id.js';
import { sanitizeForFileSystem } from '../utils/sanitize.js';
import type { GoalChain, GoalChainState, GoalKanbanItem, GoalRecord, GoalUpdateInput, WorkspacePhaseCascadeItem, WorkspacePhaseChangePreview } from '../types/goals.js';

const PROJECT_GOAL_STORAGE_DIR = join('.gitspace', 'goals');
const PROJECT_GOAL_GITIGNORE_ENTRY = '.gitspace/goals/';
const PROJECT_GOAL_GITIGNORE_MARKER = '# gssh goal local state';
const PLANNED_GOAL_DIR = 'planned';
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
  const byId = new Map<string, GoalRecord>();
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
  if (goal.workspaceName) {
    return writeWorkspaceGoal(projectName, goal.workspaceName, goal);
  }
  return writePlannedGoal(projectName, goal);
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

export function addGoalNearWorkspace(projectName: string, workspaceName: string, title: string, position: 'before' | 'after'): GoalRecord {
  const { chain, goal } = ensureWorkspaceGoalChain(projectName, workspaceName);
  const newGoal: GoalRecord = writePlannedGoal(projectName, {
    version: 2,
    id: makeGoalId(title),
    chainId: chain.id,
    title,
    projectName,
    phase: goal.phase,
    plannedWorkspaceName: sanitizeForFileSystem(title) || undefined,
    doc: defaultGoalDoc(title),
    validation: defaultGoalValidation(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  const currentIndex = chain.goalIds.indexOf(goal.id);
  const goalIds = [...chain.goalIds];
  let insertIndex = position === 'before' ? currentIndex : currentIndex + 1;

  if (position === 'after') {
    while (insertIndex < goalIds.length) {
      const descendant = getGoalRecord(projectName, goalIds[insertIndex]);
      if (!descendant || descendant.workspaceName) {
        break;
      }
      insertIndex += 1;
    }
  }

  goalIds.splice(Math.max(0, insertIndex), 0, newGoal.id);
  upsertGoalChain(projectName, { ...chain, goalIds });
  return newGoal;
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
