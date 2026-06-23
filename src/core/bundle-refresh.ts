/**
 * Bundle refresh detection and execution.
 *
 * Tracks bundle state per workspace scope, keeps project-level merged keys,
 * and persists confirm-step history by step fingerprint.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { basename, join, resolve, sep } from 'path';
import { logger } from '../utils/logger.js';

import {
  getProjectBaseDir,
  getProjectWorkspacesDir,
  readProjectConfig,
  updateProjectConfig,
} from './config.js';
import { runOnboarding, KEEP_EXISTING_SECRET, type OnboardingOptions } from '../utils/onboarding.js';
import { deleteProjectSecret, getProjectSecret, getProjectSecrets, setProjectSecret } from '../utils/secrets.js';
import { checkCommandExists } from '../utils/deps.js';
import { SpacesError } from '../types/errors.js';
import type {
  ConfirmStep,
  ConfirmStepResult,
  OnboardingStep,
  SecretStep,
  SpacesBundle,
} from '../types/bundle.js';
import type {
  BundleConfirmHistoryEntry,
  ProjectConfig,
  WorkspaceBundleState,
} from '../types/config.js';
import type {
  BundleRefreshPlan,
  BundleRefreshStep,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type {
  BundleConfigState,
  BundleConfigStep,
  BundleConfigSubmission,
} from '../types/bundle-config.js';

const BUNDLE_FILENAME = 'bundle.json';
const BASE_SCOPE = '__base__';

/**
 * Result of bundle change detection.
 */
export interface BundleChangeResult {
  /** Whether a bundle exists */
  hasBundle: boolean;
  /** Whether the bundle has changed since last processed for this scope */
  hasChanged: boolean;
  /** The current bundle (if exists) */
  currentBundle?: SpacesBundle;
  /** Hash of the current bundle content */
  currentHash?: string;
  /** Hash previously recorded for this scope (or base fallback) */
  previousHash?: string;
  /** Path to the bundle directory */
  bundlePath?: string;
  /** Parse error if bundle.json is invalid */
  parseError?: string;
  /** Scope key used for this detection (workspace name or __base__) */
  scope?: string;
  /** Where the active bundle.json was resolved from */
  bundleSource?: 'workspace' | 'base';
  /** Where baseline state came from for comparison */
  baselineSource?: 'scope' | 'base' | 'inferred' | 'none';
  /** Key-level onboarding requirement diff between baseline and current bundle */
  requirementsDiff?: BundleRequirementsDiff;
  /** Human-readable summary lines explaining change status */
  changeSummary?: string[];
}

/**
 * Options for bundle refresh.
 */
export interface BundleRefreshOptions {
  /** Force refresh even if no changes detected */
  force?: boolean;
  /** Run in non-interactive mode (skip prompting when changes are detected) */
  nonInteractive?: boolean;
  /** Allow workspace scope to fall back to base repo bundle.json */
  allowBaseFallback?: boolean;
}

export interface BundleResolutionOptions {
  allowBaseFallback?: boolean;
}

/**
 * Result of bundle refresh.
 */
export interface BundleRefreshResult {
  /** Whether refresh prompts were performed */
  refreshed: boolean;
  /** Whether refresh completed successfully */
  completed: boolean;
  /** Merged non-secret values stored in config */
  newValues?: Record<string, string>;
  /** Merged secret key list stored in config */
  newSecretKeys?: string[];
  /** Error message if failed */
  error?: string;
}

interface LoadBundleResult {
  bundle: SpacesBundle | null;
  error?: string;
}

interface BundleRequirements {
  requiredInputKeys: string[];
  requiredSecretKeys: string[];
  confirmFingerprints: string[];
}

interface BundleSyncResult {
  hasBundle: boolean;
  parseError?: string;
  scope?: string;
  bundle?: SpacesBundle;
  bundleHash?: string;
  bundlePath?: string;
  bundleSource?: 'workspace' | 'base';
}

interface BundleRequirementsDiff {
  inputAdded: string[];
  inputRemoved: string[];
  secretsAdded: string[];
  secretsRemoved: string[];
  confirmsAdded: string[];
  confirmsRemoved: string[];
}

/**
 * Compute a hash of the full bundle content for change detection.
 */
export function hashBundle(bundle: SpacesBundle): string {
  const stable = deepSortForHash(bundle);
  const content = JSON.stringify(stable);
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Compute a stable fingerprint for a confirm step.
 *
 * Re-check behavior is keyed to this fingerprint, not the whole bundle hash.
 */
export function getConfirmStepFingerprint(step: ConfirmStep): string {
  const stable = deepSortForHash({
    type: step.type,
    id: step.id,
    title: step.title,
    description: step.description,
    required: step.required !== false,
    checkCommand: step.checkCommand ?? null,
    installUrl: step.installUrl ?? null,
    confirmPrompt: step.confirmPrompt ?? null,
  });

  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

/**
 * Get the bundle scope key for this path.
 *
 * - workspace path -> workspace name
 * - base path or unknown path -> __base__
 */
export function getBundleScopeKey(projectName: string, workspacePath?: string): string {
  if (!workspacePath) {
    return BASE_SCOPE;
  }

  const resolvedWorkspacePath = resolve(workspacePath);
  const resolvedWorkspacesDir = resolve(getProjectWorkspacesDir(projectName));

  if (
    resolvedWorkspacePath === resolvedWorkspacesDir ||
    !resolvedWorkspacePath.startsWith(`${resolvedWorkspacesDir}${sep}`)
  ) {
    return BASE_SCOPE;
  }

  const relative = resolvedWorkspacePath.slice(resolvedWorkspacesDir.length + 1);
  const workspaceName = relative.split(sep)[0];
  return workspaceName || BASE_SCOPE;
}

function deepSortForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => deepSortForHash(item));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = deepSortForHash(record[key]);
    }
    return sorted;
  }

  return value;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function diffKeys(previous: string[], current: string[]): { added: string[]; removed: string[] } {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);

  const added = current.filter((key) => !previousSet.has(key));
  const removed = previous.filter((key) => !currentSet.has(key));

  return {
    added: uniqueSorted(added),
    removed: uniqueSorted(removed),
  };
}

function buildRequirementsDiff(
  previous: BundleRequirements,
  current: BundleRequirements
): BundleRequirementsDiff {
  const input = diffKeys(previous.requiredInputKeys, current.requiredInputKeys);
  const secrets = diffKeys(previous.requiredSecretKeys, current.requiredSecretKeys);
  const confirms = diffKeys(previous.confirmFingerprints, current.confirmFingerprints);

  return {
    inputAdded: input.added,
    inputRemoved: input.removed,
    secretsAdded: secrets.added,
    secretsRemoved: secrets.removed,
    confirmsAdded: confirms.added,
    confirmsRemoved: confirms.removed,
  };
}

function sourceLabel(source?: 'workspace' | 'base'): string {
  if (source === 'workspace') {
    return 'workspace bundle (.gitspace/bundle.json in workspace)';
  }

  return 'project base bundle (.gitspace/bundle.json in base repo)';
}

function baselineLabel(source?: 'scope' | 'base' | 'inferred' | 'none'): string {
  switch (source) {
    case 'scope':
      return 'workspace scope';
    case 'base':
      return 'base scope (__base__)';
    case 'inferred':
      return 'inferred matching workspace scope';
    case 'none':
    default:
      return 'none';
  }
}

function buildBundleChangeSummary(changes: BundleChangeResult): string[] {
  const lines: string[] = [];

  if (!changes.hasBundle) {
    lines.push('No bundle detected for this workspace/project scope.');
    return lines;
  }

  lines.push(`Bundle source: ${sourceLabel(changes.bundleSource)}.`);
  lines.push(`Baseline source: ${baselineLabel(changes.baselineSource)}.`);

  if (changes.hasChanged) {
    lines.push(
      `Bundle hash changed (${changes.previousHash ?? 'none'} -> ${changes.currentHash ?? 'unknown'}).`
    );

    if (changes.baselineSource === 'none') {
      lines.push(
        `No previously recorded bundle state for scope "${changes.scope ?? BASE_SCOPE}".`
      );
    }

    const diff = changes.requirementsDiff;
    if (diff) {
      if (diff.inputAdded.length > 0) {
        lines.push(`Required input keys added: ${diff.inputAdded.join(', ')}.`);
      }
      if (diff.inputRemoved.length > 0) {
        lines.push(`Required input keys removed: ${diff.inputRemoved.join(', ')}.`);
      }
      if (diff.secretsAdded.length > 0) {
        lines.push(`Required secret keys added: ${diff.secretsAdded.join(', ')}.`);
      }
      if (diff.secretsRemoved.length > 0) {
        lines.push(`Required secret keys removed: ${diff.secretsRemoved.join(', ')}.`);
      }
      if (diff.confirmsAdded.length > 0 || diff.confirmsRemoved.length > 0) {
        lines.push(
          `Confirm checks changed (+${diff.confirmsAdded.length} / -${diff.confirmsRemoved.length}).`
        );
      }
    }
  } else {
    lines.push('Bundle hash matches the recorded baseline for this scope.');
  }

  return lines;
}

/**
 * Format bundle change details for user-facing messages.
 */
export function formatBundleChangeDetails(changes: BundleChangeResult): string {
  const summary = changes.changeSummary ?? buildBundleChangeSummary(changes);
  return summary.join('\n');
}

function loadBundle(bundleDir: string): LoadBundleResult {
  const bundlePath = join(bundleDir, BUNDLE_FILENAME);
  if (!existsSync(bundlePath)) {
    return { bundle: null };
  }

  try {
    const content = readFileSync(bundlePath, 'utf-8');
    const bundle = JSON.parse(content) as SpacesBundle;
    return { bundle };
  } catch (error) {
    const errorMessage = error instanceof SyntaxError
      ? `Invalid JSON in bundle.json: ${error.message}`
      : `Failed to load bundle: ${error}`;
    logger.warning(errorMessage);
    return { bundle: null, error: errorMessage };
  }
}

function resolveBundleLocation(
  projectName: string,
  workspacePath?: string,
  options: BundleResolutionOptions = {},
): { bundleDir: string; bundleSource: 'workspace' | 'base' } | null {
  const allowBaseFallback = options.allowBaseFallback ?? true;

  if (workspacePath) {
    const workspaceBundleDir = join(workspacePath, '.gitspace');
    if (existsSync(join(workspaceBundleDir, BUNDLE_FILENAME))) {
      return {
        bundleDir: workspaceBundleDir,
        bundleSource: 'workspace',
      };
    }

    if (!allowBaseFallback) {
      return null;
    }
  }

  const baseDir = getProjectBaseDir(projectName);
  const baseBundleDir = join(baseDir, '.gitspace');
  if (existsSync(join(baseBundleDir, BUNDLE_FILENAME))) {
    return {
      bundleDir: baseBundleDir,
      bundleSource: 'base',
    };
  }

  return null;
}

function getBundleRequirements(bundle: SpacesBundle): BundleRequirements {
  const steps = bundle.onboarding || [];
  const inputKeys: string[] = [];
  const secretKeys: string[] = [];
  const confirmFingerprints: string[] = [];

  for (const step of steps) {
    if (step.type === 'input') {
      inputKeys.push(step.configKey);
      continue;
    }

    if (step.type === 'secret') {
      secretKeys.push(step.configKey);
      continue;
    }

    if (step.type === 'confirm') {
      confirmFingerprints.push(getConfirmStepFingerprint(step));
    }
  }

  return {
    requiredInputKeys: uniqueSorted(inputKeys),
    requiredSecretKeys: uniqueSorted(secretKeys),
    confirmFingerprints: uniqueSorted(confirmFingerprints),
  };
}

function applyWorkspaceState(
  config: ProjectConfig,
  scope: string,
  bundleHash: string,
  bundle: SpacesBundle
): {
  bundleWorkspaceState: Record<string, WorkspaceBundleState>;
  mergedSecretKeys: string[];
  requirements: BundleRequirements;
} {
  const existingState = config.bundleWorkspaceState || {};
  const requirements = getBundleRequirements(bundle);

  const nextState: Record<string, WorkspaceBundleState> = {
    ...existingState,
    [scope]: {
      scope,
      bundleHash,
      requiredInputKeys: requirements.requiredInputKeys,
      requiredSecretKeys: requirements.requiredSecretKeys,
      confirmFingerprints: requirements.confirmFingerprints,
      updatedAt: new Date().toISOString(),
    },
  };

  const requiredSecretUnion = Object.values(nextState)
    .flatMap((entry) => entry.requiredSecretKeys);
  const mergedSecretKeys = uniqueSorted([
    ...(config.bundleSecretKeys || []),
    ...requiredSecretUnion,
  ]);

  return {
    bundleWorkspaceState: nextState,
    mergedSecretKeys,
    requirements,
  };
}

/**
 * Sync bundle metadata for a workspace scope without running onboarding prompts.
 *
 * This keeps per-workspace requirements and merged project-level key lists up to date.
 */
export function syncBundleWorkspaceState(projectName: string, workspacePath?: string): BundleSyncResult {
  const bundleLocation = resolveBundleLocation(projectName, workspacePath);
  if (!bundleLocation) {
    return { hasBundle: false };
  }

  const { bundleDir, bundleSource } = bundleLocation;

  const { bundle, error } = loadBundle(bundleDir);
  if (!bundle) {
    return {
      hasBundle: false,
      parseError: error,
    };
  }

  const scope = getBundleScopeKey(projectName, workspacePath);
  const bundleHash = hashBundle(bundle);
  const config = readProjectConfig(projectName);
  let nextState = config.bundleWorkspaceState || {};
  let mergedSecretKeys = config.bundleSecretKeys || [];

  if (bundleSource === 'base' || scope === BASE_SCOPE) {
    const baseApplied = applyWorkspaceState(config, BASE_SCOPE, bundleHash, bundle);
    nextState = baseApplied.bundleWorkspaceState;
    mergedSecretKeys = baseApplied.mergedSecretKeys;
  }

  if (scope !== BASE_SCOPE) {
    const scopedApplied = applyWorkspaceState(
      {
        ...config,
        bundleWorkspaceState: nextState,
        bundleSecretKeys: mergedSecretKeys,
      },
      scope,
      bundleHash,
      bundle
    );

    nextState = scopedApplied.bundleWorkspaceState;
    mergedSecretKeys = scopedApplied.mergedSecretKeys;
  }

  updateProjectConfig(projectName, {
    bundleWorkspaceState: nextState,
    bundleSecretKeys: mergedSecretKeys.length > 0 ? mergedSecretKeys : undefined,
  });

  return {
    hasBundle: true,
    scope,
    bundle,
    bundleHash,
    bundlePath: bundleDir,
    bundleSource,
  };
}

/**
 * Detect if bundle has changed for the current workspace scope.
 */
export function detectBundleChanges(
  projectName: string,
  workspacePath?: string,
  options: BundleResolutionOptions = {},
): BundleChangeResult {
  const result: BundleChangeResult = {
    hasBundle: false,
    hasChanged: false,
  };

  const bundleLocation = resolveBundleLocation(projectName, workspacePath, options);
  if (!bundleLocation) {
    return result;
  }

  const { bundleDir, bundleSource } = bundleLocation;

  const { bundle, error } = loadBundle(bundleDir);
  if (!bundle) {
    if (error) {
      result.parseError = error;
    }
    return result;
  }

  const scope = getBundleScopeKey(projectName, workspacePath);
  const currentHash = hashBundle(bundle);
  const currentRequirements = getBundleRequirements(bundle);
  const config = readProjectConfig(projectName);
  const state = config.bundleWorkspaceState || {};

  const scopeState = state[scope];
  const baseState = state[BASE_SCOPE];
  const inferredState = Object.values(state).find((entry) => entry.bundleHash === currentHash);

  const baselineState = scopeState || baseState || inferredState;
  const baselineSource: 'scope' | 'base' | 'inferred' | 'none' = scopeState
    ? 'scope'
    : baseState
      ? 'base'
      : inferredState
        ? 'inferred'
        : 'none';

  const previousHash = baselineState?.bundleHash;
  const previousRequirements: BundleRequirements = {
    requiredInputKeys: baselineState?.requiredInputKeys || [],
    requiredSecretKeys: baselineState?.requiredSecretKeys || [],
    confirmFingerprints: baselineState?.confirmFingerprints || [],
  };
  const requirementsDiff = buildRequirementsDiff(previousRequirements, currentRequirements);

  result.hasBundle = true;
  result.currentBundle = bundle;
  result.currentHash = currentHash;
  result.previousHash = previousHash;
  result.bundlePath = bundleDir;
  result.bundleSource = bundleSource;
  result.scope = scope;
  result.baselineSource = baselineSource;
  result.requirementsDiff = requirementsDiff;
  result.hasChanged = previousHash !== currentHash;
  result.changeSummary = buildBundleChangeSummary(result);

  return result;
}

function resolveWorkspaceNameFromPath(workspacePath: string): string {
  return basename(resolve(workspacePath));
}

function shouldIncludeInputStep(
  key: string,
  previousValues: Record<string, string>,
  diff?: BundleRequirementsDiff,
  baselineSource?: 'scope' | 'base' | 'inferred' | 'none'
): boolean {
  if (baselineSource === 'none') {
    return true;
  }

  if (diff?.inputAdded.includes(key)) {
    return true;
  }

  const existing = previousValues[key];
  return !existing;
}

function shouldIncludeSecretStep(
  key: string,
  existingSecrets: Record<string, string>,
  diff?: BundleRequirementsDiff,
  baselineSource?: 'scope' | 'base' | 'inferred' | 'none'
): boolean {
  if (baselineSource === 'none') {
    return true;
  }

  if (Object.prototype.hasOwnProperty.call(existingSecrets, key)) {
    return false;
  }

  if (diff?.secretsAdded.includes(key)) {
    return true;
  }

  return true;
}

function makeStepDescription(step: OnboardingStep): string {
  if (step.required === false) {
    return `${step.description}\n\n(Optional)`;
  }

  return step.description;
}

function buildPendingRequirementsSummary(steps: BundleRefreshStep[]): string[] {
  const required = steps.filter((step) => step.required !== false);
  if (required.length === 0) {
    return [];
  }

  const inputKeys = required
    .filter((step) => (step.type === 'input' || step.type === 'select') && step.configKey)
    .map((step) => step.configKey as string);
  const secretKeys = required
    .filter((step) => step.type === 'secret' && step.configKey)
    .map((step) => step.configKey as string);
  const confirmTitles = required
    .filter((step) => step.type === 'confirm')
    .map((step) => step.title);

  const lines: string[] = [];
  if (inputKeys.length > 0) {
    lines.push(`Missing required input values: ${inputKeys.join(', ')}.`);
  }
  if (secretKeys.length > 0) {
    lines.push(`Missing required secrets: ${secretKeys.join(', ')}.`);
  }
  if (confirmTitles.length > 0) {
    lines.push(`Pending required checks: ${confirmTitles.join(', ')}.`);
  }

  return lines;
}

async function resolveConfirmResult(
  step: ConfirmStep,
  confirmHistory: Record<string, BundleConfirmHistoryEntry>
): Promise<{ result?: ConfirmStepResult; checkedAt?: string }> {
  const fingerprint = getConfirmStepFingerprint(step);
  const history = confirmHistory[fingerprint];
  if (history) {
    return {
      result: {
        status: history.status,
        checkCommand: history.checkCommand,
      },
      checkedAt: history.checkedAt,
    };
  }

  if (step.checkCommand) {
    const exists = await checkCommandExists(step.checkCommand);
    if (exists) {
      return {
        result: {
          status: 'passed',
          checkCommand: step.checkCommand,
        },
      };
    }
  }

  return {};
}

function hasRequiredRefreshSteps(plan: BundleRefreshPlan): boolean {
  return plan.steps.some((step) => step.required !== false);
}


export async function getBundleRefreshPlan(
  projectName: string,
  workspacePath: string,
  workspaceId?: string
): Promise<BundleRefreshPlan> {
  const workspaceName = resolveWorkspaceNameFromPath(workspacePath);
  const resolvedWorkspaceId = workspaceId ?? `${projectName}:${workspaceName}`;
  const changes = detectBundleChanges(projectName, workspacePath);
  const details = formatBundleChangeDetails(changes);

  const emptyPlan: BundleRefreshPlan = {
    projectName,
    workspaceId: resolvedWorkspaceId,
    workspaceName,
    workspacePath: resolve(workspacePath),
    hasBundle: changes.hasBundle,
    hasChanged: changes.hasChanged,
    scope: changes.scope,
    bundleSource: changes.bundleSource,
    baselineSource: changes.baselineSource,
    details,
    currentHash: changes.currentHash,
    previousHash: changes.previousHash,
    steps: [],
    autoConfirmResults: {},
  };

  if (!changes.hasBundle || !changes.currentBundle) {
    return emptyPlan;
  }

  const config = readProjectConfig(projectName);
  const previousValues = config.bundleValues || {};
  const confirmHistory = config.bundleConfirmHistory || {};
  const secretStepKeys = (changes.currentBundle.onboarding || [])
    .filter((step): step is SecretStep => step.type === 'secret')
    .map((step) => step.configKey);
  const existingSecrets = await getProjectSecrets(projectName, secretStepKeys);
  const diff = changes.requirementsDiff;
  const steps: BundleRefreshStep[] = [];
  const autoConfirmResults: Record<string, ConfirmStepResult> = {};

  for (const onboardingStep of changes.currentBundle.onboarding || []) {
    if (onboardingStep.type === 'input' || onboardingStep.type === 'select') {
      const include = shouldIncludeInputStep(
        onboardingStep.configKey,
        previousValues,
        diff,
        changes.baselineSource
      );
      if (!include) {
        continue;
      }

      steps.push({
        id: onboardingStep.id,
        type: onboardingStep.type,
        title: onboardingStep.title,
        description: makeStepDescription(onboardingStep),
        required: onboardingStep.required,
        configKey: onboardingStep.configKey,
        defaultValue: previousValues[onboardingStep.configKey] ?? onboardingStep.defaultValue,
        validationPattern: onboardingStep.type === 'input' ? onboardingStep.validationPattern : undefined,
        validationMessage: onboardingStep.type === 'input' ? onboardingStep.validationMessage : undefined,
        options: onboardingStep.type === 'select' ? onboardingStep.options : undefined,
      });
      continue;
    }

    if (onboardingStep.type === 'secret') {
      const include = shouldIncludeSecretStep(
        onboardingStep.configKey,
        existingSecrets,
        diff,
        changes.baselineSource
      );
      if (!include) {
        continue;
      }

      steps.push({
        id: onboardingStep.id,
        type: onboardingStep.type,
        title: onboardingStep.title,
        description: makeStepDescription(onboardingStep),
        required: onboardingStep.required,
        configKey: onboardingStep.configKey,
        validationPattern: onboardingStep.validationPattern,
        validationMessage: onboardingStep.validationMessage,
        hasExistingSecret: Object.prototype.hasOwnProperty.call(existingSecrets, onboardingStep.configKey),
      });
      continue;
    }

    if (onboardingStep.type === 'confirm') {
      const fingerprint = getConfirmStepFingerprint(onboardingStep);
      const history = confirmHistory[fingerprint];
      if (history?.status === 'passed') {
        autoConfirmResults[onboardingStep.id] = {
          status: 'passed',
          checkCommand: onboardingStep.checkCommand,
        };
        continue;
      }

      if (onboardingStep.checkCommand) {
        const exists = await checkCommandExists(onboardingStep.checkCommand);
        if (exists) {
          autoConfirmResults[onboardingStep.id] = {
            status: 'passed',
            checkCommand: onboardingStep.checkCommand,
          };
          continue;
        }
      }

      steps.push({
        id: onboardingStep.id,
        type: onboardingStep.type,
        title: onboardingStep.title,
        description: makeStepDescription(onboardingStep),
        required: onboardingStep.required,
        checkCommand: onboardingStep.checkCommand,
        installUrl: onboardingStep.installUrl,
        confirmPrompt: onboardingStep.confirmPrompt,
      });
      continue;
    }

    if (onboardingStep.type === 'info' && changes.baselineSource === 'none') {
      steps.push({
        id: onboardingStep.id,
        type: onboardingStep.type,
        title: onboardingStep.title,
        description: makeStepDescription(onboardingStep),
        required: onboardingStep.required,
      });
    }
  }

  const pendingSummary = buildPendingRequirementsSummary(steps);
  const detailsWithPending = pendingSummary.length > 0
    ? [details, ...pendingSummary].join('\n')
    : details;

  return {
    ...emptyPlan,
    details: detailsWithPending,
    steps,
    autoConfirmResults,
  };
}

export async function applyBundleRefreshSubmission(
  projectName: string,
  workspacePath: string,
  submission: BundleRefreshSubmission
): Promise<void> {
  const changes = detectBundleChanges(projectName, workspacePath);
  if (!changes.hasBundle || !changes.currentBundle || !changes.currentHash) {
    throw new SpacesError(changes.parseError || 'No bundle found for workspace', 'USER_ERROR', 1);
  }

  const scope = changes.scope || BASE_SCOPE;
  const bundle = changes.currentBundle;
  const bundleHash = changes.currentHash;
  const config = readProjectConfig(projectName);
  const confirmHistory = config.bundleConfirmHistory || {};
  const stateApplied = applyWorkspaceState(config, scope, bundleHash, bundle);

  const newValues: Record<string, string> = {
    ...(config.bundleValues || {}),
    ...submission.inputValues,
  };

  const secretKeys = new Set<string>(stateApplied.mergedSecretKeys);
  for (const key of Object.keys(submission.secretValues)) {
    secretKeys.add(key);
  }

  for (const [key, value] of Object.entries(submission.secretValues)) {
    if (!value || value === KEEP_EXISTING_SECRET) {
      continue;
    }
    await setProjectSecret(projectName, key, value);
  }

  const historyNext: Record<string, BundleConfirmHistoryEntry> = {
    ...confirmHistory,
  };

  const allConfirmResults: Record<string, ConfirmStepResult> = {
    ...submission.confirmResults,
  };

  for (const step of bundle.onboarding || []) {
    if (step.type !== 'confirm') {
      continue;
    }

    if (!allConfirmResults[step.id] && step.checkCommand) {
      const exists = await checkCommandExists(step.checkCommand);
      if (exists) {
        allConfirmResults[step.id] = {
          status: 'passed',
          checkCommand: step.checkCommand,
        };
      }
    }

    const result = allConfirmResults[step.id];
    if (!result) {
      continue;
    }

    const fingerprint = getConfirmStepFingerprint(step);
    historyNext[fingerprint] = {
      fingerprint,
      stepId: step.id,
      checkCommand: step.checkCommand,
      status: result.status,
      scope,
      bundleHash,
      checkedAt: new Date().toISOString(),
    };
  }

  updateProjectConfig(projectName, {
    bundleValues: Object.keys(newValues).length > 0 ? newValues : undefined,
    bundleSecretKeys: secretKeys.size > 0 ? uniqueSorted([...secretKeys]) : undefined,
    bundleWorkspaceState: stateApplied.bundleWorkspaceState,
    bundleConfirmHistory: Object.keys(historyNext).length > 0 ? historyNext : undefined,
  });
}

export async function getBundleConfigState(
  projectName: string,
  workspacePath: string,
  workspaceId?: string
): Promise<BundleConfigState> {
  const workspaceName = resolveWorkspaceNameFromPath(workspacePath);
  const resolvedWorkspaceId = workspaceId ?? `${projectName}:${workspaceName}`;
  const changes = detectBundleChanges(projectName, workspacePath);
  const details = formatBundleChangeDetails(changes);

  const emptyState: BundleConfigState = {
    projectName,
    workspaceId: resolvedWorkspaceId,
    workspaceName,
    workspacePath: resolve(workspacePath),
    hasBundle: false,
    scope: changes.scope,
    bundleSource: changes.bundleSource,
    currentHash: changes.currentHash,
    details,
    steps: [],
  };

  if (!changes.hasBundle || !changes.currentBundle) {
    return emptyState;
  }

  const config = readProjectConfig(projectName);
  const inputValues = config.bundleValues || {};
  const confirmHistory = config.bundleConfirmHistory || {};
  const secretStepKeys = (changes.currentBundle.onboarding || [])
    .filter((step): step is SecretStep => step.type === 'secret')
    .map((step) => step.configKey);
  const existingSecrets = await getProjectSecrets(projectName, secretStepKeys);
  const steps: BundleConfigStep[] = [];

  for (const step of changes.currentBundle.onboarding || []) {
    if (step.type === 'input' || step.type === 'select') {
      steps.push({
        id: step.id,
        type: step.type,
        title: step.title,
        description: step.description,
        required: step.required,
        configKey: step.configKey,
        defaultValue: step.defaultValue,
        validationPattern: step.type === 'input' ? step.validationPattern : undefined,
        validationMessage: step.type === 'input' ? step.validationMessage : undefined,
        value: inputValues[step.configKey],
        options: step.type === 'select' ? step.options : undefined,
      });
      continue;
    }

    if (step.type === 'secret') {
      steps.push({
        id: step.id,
        type: step.type,
        title: step.title,
        description: step.description,
        required: step.required,
        configKey: step.configKey,
        validationPattern: step.validationPattern,
        validationMessage: step.validationMessage,
        hasSecret: Object.prototype.hasOwnProperty.call(existingSecrets, step.configKey),
      });
      continue;
    }

    if (step.type === 'confirm') {
      const resolved = await resolveConfirmResult(step, confirmHistory);
      steps.push({
        id: step.id,
        type: step.type,
        title: step.title,
        description: step.description,
        required: step.required,
        checkCommand: step.checkCommand,
        installUrl: step.installUrl,
        confirmPrompt: step.confirmPrompt,
        confirmResult: resolved.result,
        confirmCheckedAt: resolved.checkedAt,
      });
      continue;
    }

    steps.push({
      id: step.id,
      type: step.type,
      title: step.title,
      description: step.description,
      required: step.required,
    });
  }

  return {
    ...emptyState,
    hasBundle: true,
    bundleName: changes.currentBundle.name,
    bundleVersion: changes.currentBundle.version,
    steps,
  };
}

export async function applyBundleConfigSubmission(
  projectName: string,
  workspacePath: string,
  submission: BundleConfigSubmission
): Promise<void> {
  const changes = detectBundleChanges(projectName, workspacePath);
  if (!changes.hasBundle || !changes.currentBundle || !changes.currentHash) {
    throw new SpacesError(changes.parseError || 'No bundle found for workspace', 'USER_ERROR', 1);
  }

  const scope = changes.scope || BASE_SCOPE;
  const bundle = changes.currentBundle;
  const bundleHash = changes.currentHash;
  const config = readProjectConfig(projectName);
  const confirmHistory = config.bundleConfirmHistory || {};
  const stateApplied = applyWorkspaceState(config, scope, bundleHash, bundle);

  const inputValues = submission.inputValues || {};
  const secretValues = submission.secretValues || {};
  const confirmResults = submission.confirmResults || {};

  const newValues: Record<string, string> = {
    ...(config.bundleValues || {}),
    ...inputValues,
  };

  const secretKeys = new Set<string>(stateApplied.mergedSecretKeys);

  for (const [key, value] of Object.entries(secretValues)) {
    if (value === '') {
      await deleteProjectSecret(projectName, key);
      secretKeys.delete(key);
      continue;
    }

    if (!value || value === KEEP_EXISTING_SECRET) {
      continue;
    }

    await setProjectSecret(projectName, key, value);
    secretKeys.add(key);
  }

  const historyNext: Record<string, BundleConfirmHistoryEntry> = {
    ...confirmHistory,
  };

  for (const step of bundle.onboarding || []) {
    if (step.type !== 'confirm') {
      continue;
    }

    const result = confirmResults[step.id];
    if (!result) {
      continue;
    }

    const fingerprint = getConfirmStepFingerprint(step);
    historyNext[fingerprint] = {
      fingerprint,
      stepId: step.id,
      checkCommand: step.checkCommand,
      status: result.status,
      scope,
      bundleHash,
      checkedAt: new Date().toISOString(),
    };
  }

  updateProjectConfig(projectName, {
    bundleValues: Object.keys(newValues).length > 0 ? newValues : undefined,
    bundleSecretKeys: secretKeys.size > 0 ? uniqueSorted([...secretKeys]) : undefined,
    bundleWorkspaceState: stateApplied.bundleWorkspaceState,
    bundleConfirmHistory: Object.keys(historyNext).length > 0 ? historyNext : undefined,
  });
}

/**
 * Refresh bundle onboarding.
 *
 * Re-runs onboarding for steps that require input, while skipping confirm/check
 * steps whose fingerprint was already confirmed.
 */
export async function refreshBundle(
  projectName: string,
  workspacePath?: string,
  options: BundleRefreshOptions = {}
): Promise<BundleRefreshResult> {
  const result: BundleRefreshResult = {
    refreshed: false,
    completed: false,
  };

  const changes = detectBundleChanges(projectName, workspacePath, {
    allowBaseFallback: options.allowBaseFallback,
  });
  if (!changes.hasBundle) {
    result.error = changes.parseError || 'No bundle found';
    return result;
  }

  const scope = changes.scope || BASE_SCOPE;
  const bundle = changes.currentBundle!;
  const bundleHash = changes.currentHash!;


  const plan = workspacePath ? await getBundleRefreshPlan(projectName, workspacePath) : undefined;

  if (!changes.hasChanged && !options.force && (!plan || !hasRequiredRefreshSteps(plan))) {
    // Keep per-scope state and merged key list fresh.
    syncBundleWorkspaceState(projectName, workspacePath);
    result.refreshed = false;
    result.completed = true;
    return result;
  }

  if (options.nonInteractive) {
    if (!changes.hasChanged && plan && hasRequiredRefreshSteps(plan)) {
      result.error = `Bundle content is unchanged but required bundle configuration is incomplete.\n${plan.details}`;
      return result;
    }

    // Still sync metadata so required key lists merge across workspaces.
    syncBundleWorkspaceState(projectName, workspacePath);
    logger.info('Bundle has changed but running in non-interactive mode, skipping refresh');
    result.refreshed = false;
    result.completed = true;
    return result;
  }

  const config = readProjectConfig(projectName);
  const previousValues = config.bundleValues || {};
  const configuredSecretKeys = config.bundleSecretKeys || [];
  const confirmHistory = config.bundleConfirmHistory || {};
  const steps = bundle.onboarding || [];
  const plannedStepIds = plan ? new Set(plan.steps.map((step) => step.id)) : undefined;


  // Only prompt for confirm/check steps when the fingerprint changed or is new.
  const stepsToRun: OnboardingStep[] = [];
  for (const step of steps) {
    if (plannedStepIds && !plannedStepIds.has(step.id)) {
      continue;
    }

    if (step.type !== 'confirm') {
      stepsToRun.push(step);
      continue;
    }

    const fingerprint = getConfirmStepFingerprint(step);
    const history = confirmHistory[fingerprint];
    if (history?.status === 'passed') {
      logger.dim(`Skipping confirm step "${step.title}" (already confirmed)`);
      continue;
    }

    stepsToRun.push(step);
  }

  // Verify which secrets actually exist in keychain.
  const existingSecretKeys: string[] = [];
  for (const key of configuredSecretKeys) {
    const exists = await getProjectSecret(projectName, key);
    if (exists !== null) {
      existingSecretKeys.push(key);
    } else {
      logger.debug(`Secret '${key}' not found in keychain, will prompt for new value`);
    }
  }

  const onboardingOptions: OnboardingOptions = {
    previousValues,
    previousSecretKeys: existingSecretKeys,
    title: 'Bundle Refresh',
    isRefresh: true,
  };

  const onboardingResult = await runOnboarding(stepsToRun, onboardingOptions);
  if (!onboardingResult.completed) {
    result.error = 'Onboarding cancelled';
    return result;
  }

  const stateApplied = applyWorkspaceState(config, scope, bundleHash, bundle);

  // Merge input values.
  const newValues: Record<string, string> = {
    ...previousValues,
    ...onboardingResult.inputValues,
  };

  // Merge secret keys from config + workspace requirements + newly entered secrets.
  const newSecretKeysSet = new Set(stateApplied.mergedSecretKeys);
  for (const key of Object.keys(onboardingResult.secretValues)) {
    newSecretKeysSet.add(key);
  }

  // Persist new secret values to keychain.
  for (const step of steps) {
    if (step.type !== 'secret') {
      continue;
    }

    const secretStep = step as SecretStep;
    const value = onboardingResult.secretValues[secretStep.configKey];
    if (value && value !== KEEP_EXISTING_SECRET) {
      await setProjectSecret(projectName, secretStep.configKey, value);
    }
  }

  const historyNext: Record<string, BundleConfirmHistoryEntry> = {
    ...confirmHistory,
  };

  for (const step of steps) {
    if (step.type !== 'confirm') {
      continue;
    }

    const fingerprint = getConfirmStepFingerprint(step);
    const stepResult = onboardingResult.confirmResults[step.id];
    if (!stepResult) {
      continue;
    }

    historyNext[fingerprint] = {
      fingerprint,
      stepId: step.id,
      checkCommand: step.checkCommand,
      status: stepResult.status,
      scope,
      bundleHash,
      checkedAt: new Date().toISOString(),
    };
  }

  updateProjectConfig(projectName, {
    bundleValues: Object.keys(newValues).length > 0 ? newValues : undefined,
    bundleSecretKeys: newSecretKeysSet.size > 0
      ? uniqueSorted([...newSecretKeysSet])
      : undefined,
    bundleWorkspaceState: stateApplied.bundleWorkspaceState,
    bundleConfirmHistory: Object.keys(historyNext).length > 0 ? historyNext : undefined,
  });

  result.refreshed = true;
  result.completed = true;
  result.newValues = newValues;
  result.newSecretKeys = uniqueSorted([...newSecretKeysSet]);

  return result;
}

/**
 * Check if bundle refresh is needed and perform it.
 *
 * Returns true if refresh was performed or not needed,
 * false if user cancelled or an error occurred.
 */
export async function checkAndRefreshBundle(
  projectName: string,
  workspacePath: string
): Promise<boolean> {
  const changes = detectBundleChanges(projectName, workspacePath);
  if (!changes.hasBundle) {
    if (changes.parseError) {
      logger.warning(`Bundle parse error: ${changes.parseError}`);
      return false;
    }
    return true;
  }

  if (!changes.hasChanged) {
    const plan = await getBundleRefreshPlan(projectName, workspacePath);
    if (!hasRequiredRefreshSteps(plan)) {
      // Keep merged requirements fresh even when no prompts are needed.
      syncBundleWorkspaceState(projectName, workspacePath);
      return true;
    }

    logger.info('Bundle content is unchanged but required bundle configuration is incomplete');
    const result = await refreshBundle(projectName, workspacePath);
    if (result.error) {
      logger.warning(`Bundle refresh failed: ${result.error}`);
      return false;
    }

    return result.completed;
  }

  logger.info('Bundle configuration has changed for this workspace');

  const result = await refreshBundle(projectName, workspacePath);
  if (result.error) {
    logger.warning(`Bundle refresh failed: ${result.error}`);
    return false;
  }

  return result.completed;
}
