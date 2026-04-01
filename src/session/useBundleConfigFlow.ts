import { useCallback } from 'react';
import type { UseFlowReturn, FlowWizardStep } from '../components/Flow.js';
import type { ConfirmStepResult } from '../types/bundle.js';
import type { BundleConfigState, BundleConfigStep, BundleConfigSubmission } from '../types/bundle-config.js';
import type { BackendScopedWorkspaceRef } from '../machine/multi/types.js';

const MAX_VALIDATION_PATTERN_LENGTH = 256;
const MAX_VALIDATION_INPUT_LENGTH = 512;
const UNSET_SECRET_TOKEN = '-';

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.length > 0) {
    return error;
  }

  return fallback;
}

function isLikelySafeValidationPattern(pattern: string): boolean {
  if (pattern.length > MAX_VALIDATION_PATTERN_LENGTH) {
    return false;
  }

  if (/\(\?<?[=!]/.test(pattern) || /\\[1-9]/.test(pattern)) {
    return false;
  }

  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    return false;
  }

  return true;
}

function buildSafeValidationRegex(pattern?: string): RegExp | null {
  if (!pattern || !isLikelySafeValidationPattern(pattern)) {
    return null;
  }

  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function buildValidation(step: BundleConfigStep): ((value: string) => string | null) | undefined {
  if (step.type !== 'input' && step.type !== 'secret') {
    return undefined;
  }

  const validationRegex = buildSafeValidationRegex(step.validationPattern);

  return (value: string): string | null => {
    const trimmed = value.trim();
    const required = step.required !== false;
    const allowsUnset = step.type === 'secret' && step.hasSecret;

    if (required && trimmed.length === 0 && !allowsUnset) {
      return 'This field is required';
    }

    if (trimmed.length > MAX_VALIDATION_INPUT_LENGTH) {
      return `Value must be ${MAX_VALIDATION_INPUT_LENGTH} characters or fewer`;
    }

    if (validationRegex && trimmed.length > 0 && trimmed !== UNSET_SECRET_TOKEN && !validationRegex.test(trimmed)) {
      return step.validationMessage || `Value must match pattern: ${step.validationPattern}`;
    }

    return null;
  };
}

function toWizardStep(step: BundleConfigStep): FlowWizardStep {
  if (step.type === 'confirm') {
    const status = step.confirmResult?.status ?? 'pending';
    const checkedAt = step.confirmCheckedAt ? `\nLast checked: ${step.confirmCheckedAt}` : '';
    return {
      id: step.id,
      type: 'confirm',
      title: step.title,
      description: `${step.description}\nCurrent status: ${status}${checkedAt}\n\nPress Enter to keep this status.`,
      checkCommand: step.checkCommand,
      checkStatus: status === 'passed' ? 'found' : 'missing',
      installUrl: step.installUrl,
    };
  }

  if (step.type === 'secret') {
    const suffix = step.hasSecret
      ? '\n\nSecret is currently set. Leave blank to keep it, or enter - to unset it.'
      : '';
    return {
      id: step.id,
      type: 'secret',
      title: step.title,
      description: `${step.description}${suffix}`,
      validation: buildValidation(step),
      defaultValue: '',
    };
  }

  if (step.type === 'select') {
    return {
      id: step.id,
      type: 'select',
      title: step.title,
      description: step.description,
      defaultValue: step.value ?? step.defaultValue ?? '',
      options: step.options?.map((option) => ({ label: option.label, value: option.value })) ?? [],
    };
  }

  if (step.type === 'input') {
    return {
      id: step.id,
      type: 'input',
      title: step.title,
      description: step.description,
      validation: buildValidation(step),
      defaultValue: step.value ?? step.defaultValue ?? '',
    };
  }

  return {
    id: step.id,
    type: 'info',
    title: step.title,
    description: step.description,
  };
}

function runWizard(
  flow: Pick<UseFlowReturn, 'showWizard'>,
  state: BundleConfigState
): Promise<Record<string, string> | null> {
  return new Promise<Record<string, string> | null>((resolve) => {
    flow.showWizard({
      title: `Bundle Config - ${state.workspaceName}`,
      steps: state.steps.map(toWizardStep),
      onComplete: async (values) => {
        resolve(values);
      },
      onCancel: () => {
        resolve(null);
      },
    });
  });
}

function buildSubmission(
  state: BundleConfigState,
  values: Record<string, string>
): BundleConfigSubmission {
  const inputValues: Record<string, string> = {};
  const secretValues: Record<string, string> = {};
  const confirmResults: Record<string, ConfirmStepResult> = {};

  for (const step of state.steps) {
    if ((step.type === 'input' || step.type === 'select') && step.configKey) {
      const value = (values[step.id] ?? step.defaultValue ?? '').trim();
      inputValues[step.configKey] = value;
      continue;
    }

    if (step.type === 'secret' && step.configKey) {
      const value = (values[step.id] ?? '').trim();
      if (value.length === 0) {
        continue;
      }
      if (value === UNSET_SECRET_TOKEN) {
        secretValues[step.configKey] = '';
        continue;
      }
      secretValues[step.configKey] = value;
      continue;
    }

    if (step.type === 'confirm') {
      if (step.confirmResult) {
        confirmResults[step.id] = {
          status: step.confirmResult.status,
          checkCommand: step.checkCommand,
        };
      }
    }
  }

  return {
    inputValues,
    secretValues,
    confirmResults,
  };
}

export interface UseBundleConfigFlowOptions {
  flow: Pick<UseFlowReturn, 'showLoading' | 'showMessage' | 'showWizard' | 'close'>;
  getBundleConfigState: (ref: BackendScopedWorkspaceRef) => Promise<BundleConfigState>;
  applyBundleConfigUpdate: (
    ref: BackendScopedWorkspaceRef,
    submission: BundleConfigSubmission
  ) => Promise<void>;
  onApplied?: () => Promise<void> | void;
}

export interface UseBundleConfigFlowResult {
  openBundleConfig: (ref: BackendScopedWorkspaceRef) => Promise<boolean>;
}

export function useBundleConfigFlow(
  options: UseBundleConfigFlowOptions
): UseBundleConfigFlowResult {
  const {
    flow,
    getBundleConfigState,
    applyBundleConfigUpdate,
    onApplied,
  } = options;

  const openBundleConfig = useCallback(async (
    ref: BackendScopedWorkspaceRef
  ): Promise<boolean> => {
    try {
      flow.showLoading({
        title: 'Bundle Config',
        message: 'Loading current bundle configuration...',
      });

      const state = await getBundleConfigState(ref);

      if (!state.hasBundle) {
        flow.showMessage({
          title: 'No Bundle',
          message: 'No bundle is configured for this workspace.',
          variant: 'info',
        });
        return false;
      }

      if (state.steps.length === 0) {
        flow.showMessage({
          title: 'Bundle Config',
          message: 'This bundle has no editable onboarding steps.',
          variant: 'info',
        });
        return false;
      }

      const values = await runWizard(flow, state);
      if (!values) {
        flow.showMessage({
          title: 'Bundle Config Cancelled',
          message: 'No changes were applied.',
          variant: 'warning',
        });
        return false;
      }

      flow.showLoading({
        title: 'Bundle Config',
        message: 'Applying bundle configuration updates...',
      });

      await applyBundleConfigUpdate(ref, buildSubmission(state, values));

      await onApplied?.();
      flow.showMessage({
        title: 'Bundle Config Updated',
        message: `Saved bundle configuration for ${state.workspaceName}.`,
        variant: 'success',
      });
      return true;
    } catch (error) {
      flow.showMessage({
        title: 'Bundle Config Failed',
        message: toErrorMessage(error, 'Failed to update bundle configuration.'),
        variant: 'error',
      });
      return false;
    }
  }, [applyBundleConfigUpdate, flow, getBundleConfigState, onApplied]);

  return { openBundleConfig };
}
