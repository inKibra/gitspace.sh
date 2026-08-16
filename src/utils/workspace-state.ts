/**
 * Workspace state tracking utilities.
 *
 * State is persisted in workspace-local gitspace.lock (JSON).
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SpacesError } from '../types/errors.js';
import type {
  ConfirmStep,
  InputStep,
  OnboardingStep,
  SecretStep,
  SpacesBundle,
  ConfirmStepResult,
} from '../types/bundle.js';

const SETUP_MARKER_FILE = 'gitspace.lock';

export type WorkspaceLockPhaseStatus = 'never' | 'success' | 'failed';

export interface WorkspaceLockConfirmState {
  status: ConfirmStepResult['status'];
  fingerprint: string;
}

export interface WorkspaceLockSetupState {
  status: WorkspaceLockPhaseStatus;
  ranAt?: string;
  error?: string;
  inputsUsed: Record<string, string>;
  inputFingerprints: Record<string, string>;
  /**
   * Presence-only secret markers: configKey -> whether a value was present when
   * setup last ran. We deliberately do NOT store secret values or deterministic
   * hashes of them (privacy). A secret going from missing -> present (or vice
   * versa) invalidates setup; a value change alone does not.
   */
  secretPresence: Record<string, boolean>;
  confirmsUsed: Record<string, WorkspaceLockConfirmState>;
  usedOptionalSteps: Record<string, true>;
  /** Combined fingerprint of everything that gates setup (steps, values, secret
   *  presence, confirms, and the pre/setup script manifests). */
  setupFingerprint?: string;
}

export interface WorkspaceLockSelectState {
  status: WorkspaceLockPhaseStatus;
  ranAt?: string;
  error?: string;
  /** Fingerprint of what gates select (select manifest + the setup fingerprint/
   *  status it depended on), so changed setup or select scripts invalidate it. */
  selectFingerprint?: string;
}

export interface WorkspaceLockBundleState {
  bundleHash: string;
  stepFingerprints: Record<string, string>;
}

export interface WorkspaceLockState {
  version: 1;
  bundle?: WorkspaceLockBundleState;
  setup: WorkspaceLockSetupState;
  select: WorkspaceLockSelectState;
}

interface BuildSetupStateOptions {
  bundle?: SpacesBundle;
  bundleHash?: string;
  stepFingerprints?: Record<string, string>;
  bundleValues?: Record<string, string>;
  bundleSecrets?: Record<string, string>;
  confirmResults?: Record<string, ConfirmStepResult>;
  /** Fingerprint of the pre-phase script manifest (buildPhaseScriptManifest). */
  preManifest?: string;
  /** Fingerprint of the setup-phase script manifest. */
  setupManifest?: string;
}

export function getWorkspaceLockPath(workspacePath: string): string {
  return join(workspacePath, SETUP_MARKER_FILE);
}

export function createEmptyWorkspaceLockState(): WorkspaceLockState {
  return {
    version: 1,
    setup: {
      status: 'never',
      inputsUsed: {},
      inputFingerprints: {},
      secretPresence: {},
      confirmsUsed: {},
      usedOptionalSteps: {},
    },
    select: {
      status: 'never',
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSetupState(value: unknown): WorkspaceLockSetupState {
  const defaults = createEmptyWorkspaceLockState().setup;
  if (!isRecord(value)) {
    return defaults;
  }

  const status = value.status;
  const normalizedStatus: WorkspaceLockPhaseStatus =
    status === 'success' || status === 'failed' || status === 'never'
      ? status
      : 'never';

  return {
    status: normalizedStatus,
    ranAt: typeof value.ranAt === 'string' ? value.ranAt : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
    inputsUsed: isRecord(value.inputsUsed)
      ? Object.fromEntries(Object.entries(value.inputsUsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : {},
    inputFingerprints: isRecord(value.inputFingerprints)
      ? Object.fromEntries(Object.entries(value.inputFingerprints).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : {},
    secretPresence: isRecord(value.secretPresence)
      ? Object.fromEntries(Object.entries(value.secretPresence).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>
      : {},
    confirmsUsed: isRecord(value.confirmsUsed)
      ? Object.fromEntries(
          Object.entries(value.confirmsUsed)
            .filter(([, v]) => isRecord(v) && typeof v.fingerprint === 'string' && (v.status === 'passed' || v.status === 'skipped'))
            .map(([k, v]) => {
              const item = v as { status: ConfirmStepResult['status']; fingerprint: string };
              return [k, { status: item.status, fingerprint: item.fingerprint }];
            })
        )
      : {},
    usedOptionalSteps: isRecord(value.usedOptionalSteps)
      ? Object.fromEntries(Object.keys(value.usedOptionalSteps).map((key) => [key, true])) as Record<string, true>
      : {},
    setupFingerprint: typeof value.setupFingerprint === 'string' ? value.setupFingerprint : undefined,
  };
}

function normalizeSelectState(value: unknown): WorkspaceLockSelectState {
  const defaults = createEmptyWorkspaceLockState().select;
  if (!isRecord(value)) {
    return defaults;
  }

  const status = value.status;
  const normalizedStatus: WorkspaceLockPhaseStatus =
    status === 'success' || status === 'failed' || status === 'never'
      ? status
      : 'never';

  return {
    status: normalizedStatus,
    ranAt: typeof value.ranAt === 'string' ? value.ranAt : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
    selectFingerprint: typeof value.selectFingerprint === 'string' ? value.selectFingerprint : undefined,
  };
}

function normalizeBundleState(value: unknown): WorkspaceLockBundleState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.bundleHash !== 'string') {
    return undefined;
  }

  const stepFingerprints = isRecord(value.stepFingerprints)
    ? Object.fromEntries(Object.entries(value.stepFingerprints).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    : {};

  return {
    bundleHash: value.bundleHash,
    stepFingerprints,
  };
}

export function readWorkspaceLockState(workspacePath: string): WorkspaceLockState | null {
  const markerPath = getWorkspaceLockPath(workspacePath);
  if (!existsSync(markerPath)) {
    return null;
  }

  try {
    const raw = readFileSync(markerPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      return null;
    }

    return {
      version: 1,
      bundle: normalizeBundleState(parsed.bundle),
      setup: normalizeSetupState(parsed.setup),
      select: normalizeSelectState(parsed.select),
    };
  } catch {
    return null;
  }
}

export function writeWorkspaceLockState(workspacePath: string, state: WorkspaceLockState): void {
  const markerPath = getWorkspaceLockPath(workspacePath);

  try {
    writeFileSync(markerPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (error) {
    throw new SpacesError(
      `Failed to write workspace lock: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SYSTEM_ERROR',
      2
    );
  }
}

export function hasSetupBeenRun(workspacePath: string): boolean {
  const state = readWorkspaceLockState(workspacePath);
  return state?.setup.status === 'success';
}

export function markSetupComplete(workspacePath: string): void {
  const state = readWorkspaceLockState(workspacePath) || createEmptyWorkspaceLockState();
  state.setup.status = 'success';
  state.setup.ranAt = new Date().toISOString();
  state.setup.error = undefined;
  writeWorkspaceLockState(workspacePath, state);
}

export function clearSetupMarker(workspacePath: string): void {
  const markerPath = getWorkspaceLockPath(workspacePath);

  try {
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
    }
  } catch {
    // Ignore errors - this is just for testing
  }
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

export function fingerprintValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function getBundleStepKey(step: OnboardingStep): string {
  if (step.type === 'input' || step.type === 'secret' || step.type === 'select') {
    return `${step.type}:${step.configKey}`;
  }

  return `${step.type}:${step.id}`;
}

function fingerprintInputStep(step: InputStep): string {
  return createHash('sha256')
    .update(JSON.stringify(deepSortForHash({
      type: step.type,
      id: step.id,
      title: step.title,
      description: step.description,
      required: step.required !== false,
      configKey: step.configKey,
      defaultValue: step.defaultValue ?? null,
      validationPattern: step.validationPattern ?? null,
      validationMessage: step.validationMessage ?? null,
    })))
    .digest('hex')
    .slice(0, 16);
}

function fingerprintSelectStep(step: Extract<OnboardingStep, { type: 'select' }>): string {
  return createHash('sha256')
    .update(JSON.stringify(deepSortForHash({
      type: step.type,
      id: step.id,
      title: step.title,
      description: step.description,
      required: step.required !== false,
      configKey: step.configKey,
      defaultValue: step.defaultValue ?? null,
      options: step.options,
    })))
    .digest('hex')
    .slice(0, 16);
}

function fingerprintSecretStep(step: SecretStep): string {
  return createHash('sha256')
    .update(JSON.stringify(deepSortForHash({
      type: step.type,
      id: step.id,
      title: step.title,
      description: step.description,
      required: step.required !== false,
      configKey: step.configKey,
      validationPattern: step.validationPattern ?? null,
      validationMessage: step.validationMessage ?? null,
    })))
    .digest('hex')
    .slice(0, 16);
}

function fingerprintConfirmStep(step: ConfirmStep): string {
  return createHash('sha256')
    .update(JSON.stringify(deepSortForHash({
      type: step.type,
      id: step.id,
      title: step.title,
      description: step.description,
      required: step.required !== false,
      checkCommand: step.checkCommand ?? null,
      installUrl: step.installUrl ?? null,
      confirmPrompt: step.confirmPrompt ?? null,
    })))
    .digest('hex')
    .slice(0, 16);
}

function fingerprintStep(step: OnboardingStep): string {
  if (step.type === 'input') {
    return fingerprintInputStep(step);
  }
  if (step.type === 'select') {
    return fingerprintSelectStep(step);
  }
  if (step.type === 'secret') {
    return fingerprintSecretStep(step);
  }
  if (step.type === 'confirm') {
    return fingerprintConfirmStep(step);
  }

  return createHash('sha256')
    .update(JSON.stringify(deepSortForHash({
      type: step.type,
      id: step.id,
      title: step.title,
      description: step.description,
      required: step.required !== false,
    })))
    .digest('hex')
    .slice(0, 16);
}

export function buildBundleStepFingerprints(bundle: SpacesBundle): Record<string, string> {
  const steps = bundle.onboarding || [];
  const fingerprints: Record<string, string> = {};

  for (const step of steps) {
    fingerprints[getBundleStepKey(step)] = fingerprintStep(step);
  }

  return fingerprints;
}

/** The derived, hashable inputs that gate the setup phase. */
interface SetupFingerprintParts {
  inputsUsed: Record<string, string>;
  inputFingerprints: Record<string, string>;
  secretPresence: Record<string, boolean>;
  confirmsUsed: Record<string, WorkspaceLockConfirmState>;
  usedOptionalSteps: Record<string, true>;
}

/** Derive the per-step setup parts (input/secret/confirm state) from a bundle. */
function deriveSetupParts(options: BuildSetupStateOptions): SetupFingerprintParts {
  const {
    bundle,
    stepFingerprints,
    bundleValues = {},
    bundleSecrets = {},
    confirmResults = {},
  } = options;

  const steps = bundle?.onboarding || [];
  const usedOptionalSteps: Record<string, true> = {};
  const inputFingerprints: Record<string, string> = {};
  const secretPresence: Record<string, boolean> = {};
  const confirmsUsed: Record<string, WorkspaceLockConfirmState> = {};
  const inputsUsed: Record<string, string> = {};

  for (const step of steps) {
    const key = getBundleStepKey(step);
    const isOptional = step.required === false;

    if (step.type === 'input') {
      const value = bundleValues[step.configKey] ?? '';
      if (value.length > 0) {
        inputsUsed[step.configKey] = value;
      }
      inputFingerprints[step.configKey] = fingerprintValue(value);
      if (isOptional && value.length > 0) {
        usedOptionalSteps[key] = true;
      }
      continue;
    }

    if (step.type === 'secret') {
      const value = bundleSecrets[step.configKey] ?? '';
      // Presence only — never a hash of the value.
      secretPresence[step.configKey] = value.length > 0;
      if (isOptional && value.length > 0) {
        usedOptionalSteps[key] = true;
      }
      continue;
    }

    if (step.type === 'confirm') {
      const result = confirmResults[step.id];
      if (result) {
        confirmsUsed[key] = {
          status: result.status,
          fingerprint: stepFingerprints?.[key] ?? fingerprintStep(step),
        };
        if (isOptional) {
          usedOptionalSteps[key] = true;
        }
      }
    }
  }

  return { inputsUsed, inputFingerprints, secretPresence, confirmsUsed, usedOptionalSteps };
}

/**
 * Compute the combined setup fingerprint for the given bundle/values/secrets/
 * confirms plus the pre/setup script manifests. Used both to persist (build) and
 * to decide whether setup must re-run (compare). No secret values or value
 * hashes participate — only presence.
 */
export function computeSetupFingerprint(options: BuildSetupStateOptions): string {
  const parts = deriveSetupParts(options);
  return createHash('sha256')
    .update(JSON.stringify(deepSortForHash({
      bundleHash: options.bundleHash ?? null,
      stepFingerprints: options.stepFingerprints ?? {},
      inputsUsed: parts.inputsUsed,
      inputFingerprints: parts.inputFingerprints,
      secretPresence: parts.secretPresence,
      confirmsUsed: parts.confirmsUsed,
      usedOptionalSteps: parts.usedOptionalSteps,
      preManifest: options.preManifest ?? null,
      setupManifest: options.setupManifest ?? null,
    })))
    .digest('hex')
    .slice(0, 16);
}

export function buildSetupState(options: BuildSetupStateOptions): WorkspaceLockSetupState {
  const parts = deriveSetupParts(options);
  return {
    status: 'success',
    ranAt: new Date().toISOString(),
    inputsUsed: parts.inputsUsed,
    inputFingerprints: parts.inputFingerprints,
    secretPresence: parts.secretPresence,
    confirmsUsed: parts.confirmsUsed,
    usedOptionalSteps: parts.usedOptionalSteps,
    setupFingerprint: computeSetupFingerprint(options),
  };
}

/**
 * Compute the select fingerprint: the select script manifest plus the setup
 * fingerprint/status it depends on, so a changed setup (or changed select
 * scripts) invalidates a previously-successful select.
 */
export function computeSelectFingerprint(options: {
  selectManifest?: string;
  setupFingerprint?: string;
  setupStatus?: WorkspaceLockPhaseStatus;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(deepSortForHash({
      selectManifest: options.selectManifest ?? null,
      setupFingerprint: options.setupFingerprint ?? null,
      setupStatus: options.setupStatus ?? null,
    })))
    .digest('hex')
    .slice(0, 16);
}
