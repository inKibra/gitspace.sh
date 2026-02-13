/**
 * Shared project lifecycle helpers for bundle state persistence.
 */

import {
  getProjectBaseDir,
  readProjectConfig,
  updateProjectConfig,
} from './config.js';
import {
  getConfirmStepFingerprint,
  hashBundle,
  syncBundleWorkspaceState,
} from './bundle-refresh.js';
import { setProjectSecret } from '../utils/secrets.js';
import type { ConfirmStepResult, SpacesBundle } from '../types/bundle.js';

const BASE_SCOPE = '__base__';

interface ApplyProjectBundleStateOptions {
  projectName: string;
  bundle: SpacesBundle;
  /** Non-secret onboarding values (input steps). */
  inputValues?: Record<string, string>;
  /** Secret onboarding values that should be written to keychain. */
  secretValues?: Record<string, string>;
  /** Secret keys already persisted outside this helper. */
  secretKeys?: string[];
  /** Confirm step results keyed by step id. */
  confirmResults?: Record<string, ConfirmStepResult>;
}

interface ProjectLifecycleDeps {
  getProjectBaseDir: typeof getProjectBaseDir;
  readProjectConfig: typeof readProjectConfig;
  updateProjectConfig: typeof updateProjectConfig;
  syncBundleWorkspaceState: typeof syncBundleWorkspaceState;
  hashBundle: typeof hashBundle;
  getConfirmStepFingerprint: typeof getConfirmStepFingerprint;
  setProjectSecret: typeof setProjectSecret;
}

const defaultDeps: ProjectLifecycleDeps = {
  getProjectBaseDir,
  readProjectConfig,
  updateProjectConfig,
  syncBundleWorkspaceState,
  hashBundle,
  getConfirmStepFingerprint,
  setProjectSecret,
};

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Persist bundle-derived project state in a shared, workspace-aware format.
 */
export async function applyProjectBundleState(
  options: ApplyProjectBundleStateOptions,
  deps: ProjectLifecycleDeps = defaultDeps
): Promise<void> {
  const {
    projectName,
    bundle,
    inputValues = {},
    secretValues = {},
    secretKeys = [],
    confirmResults = {},
  } = options;

  // Seed/refresh base workspace scope metadata and required key unions.
  const baseDir = deps.getProjectBaseDir(projectName);
  const syncResult = deps.syncBundleWorkspaceState(projectName, baseDir);

  if (!syncResult.hasBundle) {
    const onboardingSteps = bundle.onboarding || [];
    const requiredInputKeys = uniqueSorted(onboardingSteps
      .filter((step) => step.type === 'input')
      .map((step) => step.configKey));
    const requiredSecretKeys = uniqueSorted(onboardingSteps
      .filter((step) => step.type === 'secret')
      .map((step) => step.configKey));
    const confirmFingerprints = uniqueSorted(onboardingSteps
      .filter((step) => step.type === 'confirm')
      .map((step) => deps.getConfirmStepFingerprint(step)));

    const seedConfig = deps.readProjectConfig(projectName);
    const nextWorkspaceState = {
      ...(seedConfig.bundleWorkspaceState || {}),
      [BASE_SCOPE]: {
        scope: BASE_SCOPE,
        bundleHash: deps.hashBundle(bundle),
        requiredInputKeys,
        requiredSecretKeys,
        confirmFingerprints,
        updatedAt: new Date().toISOString(),
      },
    };

    const mergedSecretKeys = uniqueSorted([
      ...(seedConfig.bundleSecretKeys || []),
      ...requiredSecretKeys,
    ]);

    deps.updateProjectConfig(projectName, {
      bundleWorkspaceState: nextWorkspaceState,
      bundleSecretKeys: mergedSecretKeys.length > 0 ? mergedSecretKeys : undefined,
    });
  }

  // Persist new secret values to keychain.
  for (const [key, value] of Object.entries(secretValues)) {
      if (value) {
      await deps.setProjectSecret(projectName, key, value);
    }
  }

  const config = deps.readProjectConfig(projectName);
  const mergedValues = {
    ...(config.bundleValues || {}),
    ...inputValues,
  };

  const mergedSecretKeys = uniqueSorted([
    ...(config.bundleSecretKeys || []),
    ...secretKeys,
    ...Object.keys(secretValues),
  ]);

  const bundleHash = syncResult.bundleHash || deps.hashBundle(bundle);
  const scope = syncResult.scope || BASE_SCOPE;
  const history = { ...(config.bundleConfirmHistory || {}) };

  for (const step of bundle.onboarding || []) {
    if (step.type !== 'confirm') {
      continue;
    }

    const result = confirmResults[step.id];
    if (!result) {
      continue;
    }

    const fingerprint = deps.getConfirmStepFingerprint(step);
    history[fingerprint] = {
      fingerprint,
      stepId: step.id,
      checkCommand: step.checkCommand,
      status: result.status,
      scope,
      bundleHash,
      checkedAt: new Date().toISOString(),
    };
  }

  deps.updateProjectConfig(projectName, {
    bundleValues: Object.keys(mergedValues).length > 0 ? mergedValues : undefined,
    bundleSecretKeys: mergedSecretKeys.length > 0 ? mergedSecretKeys : undefined,
    bundleConfirmHistory: Object.keys(history).length > 0 ? history : undefined,
  });
}
