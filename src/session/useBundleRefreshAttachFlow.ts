import { useCallback, useEffect, useRef, useState } from 'react';
import type { BundleRefreshPlan, BundleRefreshStep, BundleRefreshSubmission } from '../types/bundle-refresh.js';
import type { ConfirmStepResult } from '../types/bundle.js';
import type { FlowWizardStep, UseFlowReturn } from '../components/Flow.js';
import type { BackendScopedWorkspaceRef } from '../machine/multi/types.js';

export interface BundleRefreshCommandError {
  code?: string;
  message: string;
}

export interface BundleRefreshAttachParams {
  sessionId?: string;
  workspaceId?: string;
  sessionName?: string;
  cols?: number;
  rows?: number;
  scriptPolicy?: 'auto' | 'skip';
  /** When true, backend enforces read-only attach */
  viewOnly?: boolean;
  /** Custom command to run (skips workspace scripts when set) */
  command?: string;
  /** Arguments for the custom command */
  args?: string[];
  /** Environment variables for the custom command */
  env?: Record<string, string>;
}

interface PendingAttach {
  ref: BackendScopedWorkspaceRef;
  params: BundleRefreshAttachParams;
  attemptId: number;
  createdAt: number;
}

const SCRIPT_FAILURE_CODES = new Set([
  'PRE_SCRIPT_FAILED',
  'SETUP_SCRIPT_FAILED',
  'SELECT_SCRIPT_FAILED',
  'SCRIPT_CANCELLED',
]);

const PENDING_ATTACH_TTL_MS = 30_000;
const MAX_VALIDATION_PATTERN_LENGTH = 256;
const MAX_VALIDATION_INPUT_LENGTH = 512;

function isLikelySafeValidationPattern(pattern: string): boolean {
  if (pattern.length > MAX_VALIDATION_PATTERN_LENGTH) {
    return false;
  }

  // Disallow lookarounds and backreferences to reduce catastrophic backtracking risk.
  if (/\(\?<?[=!]/.test(pattern) || /\\[1-9]/.test(pattern)) {
    return false;
  }

  // Disallow nested quantified groups like /(a+)+/ style patterns.
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

export interface UseBundleRefreshAttachFlowOptions {
  flow: Pick<
    UseFlowReturn,
    'showLoading' | 'showMessage' | 'showConfirm' | 'showWizard' | 'close'
  >;
  commandError: BundleRefreshCommandError | null;
  attachSession: (params: BundleRefreshAttachParams) => Promise<void> | void;
  getBundleRefreshPlan?: (ref: BackendScopedWorkspaceRef) => Promise<BundleRefreshPlan>;
  applyBundleRefresh?: (
    ref: BackendScopedWorkspaceRef,
    submission: BundleRefreshSubmission
  ) => Promise<void>;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.length > 0) {
    return error;
  }

  return fallback;
}

function buildValidation(step: BundleRefreshStep): ((value: string) => string | null) | undefined {
  if (step.type !== 'input' && step.type !== 'secret') {
    return undefined;
  }

  const validationRegex = buildSafeValidationRegex(step.validationPattern);

  return (value: string): string | null => {
    const trimmed = value.trim();
    const allowEmptySecret = step.type === 'secret' && step.hasExistingSecret;
    const required = step.required !== false && !allowEmptySecret;

    if (required && trimmed.length === 0) {
      return 'This field is required';
    }

    if (trimmed.length > MAX_VALIDATION_INPUT_LENGTH) {
      return `Value must be ${MAX_VALIDATION_INPUT_LENGTH} characters or fewer`;
    }

    if (validationRegex && trimmed.length > 0 && !validationRegex.test(trimmed)) {
      return step.validationMessage || `Value must match pattern: ${step.validationPattern}`;
    }

    return null;
  };
}

function toWizardStep(step: BundleRefreshStep): FlowWizardStep {
  const secretHint =
    step.type === 'secret' && step.hasExistingSecret
      ? `${step.description}\n\nLeave blank to keep the existing secret.`
      : step.description;

  return {
    id: step.id,
    title: step.title,
    type: step.type,
    description: secretHint,
    defaultValue: step.defaultValue,
    validation: buildValidation(step),
    checkCommand: step.checkCommand,
    checkStatus: step.type === 'confirm' ? 'missing' : undefined,
    installUrl: step.installUrl,
  };
}

function createBaseSubmission(plan: BundleRefreshPlan): BundleRefreshSubmission {
  return {
    inputValues: {},
    secretValues: {},
    confirmResults: {
      ...plan.autoConfirmResults,
    },
  };
}

async function showRefreshPrompt(flow: UseBundleRefreshAttachFlowOptions['flow'], details: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    flow.showConfirm({
      title: 'Bundle Refresh Required',
      message: `${details}\n\nRefresh now and retry session attach?`,
      variant: 'warning',
      confirmLabel: 'Refresh now',
      cancelLabel: 'Cancel',
      onConfirm: () => {
        resolve(true);
      },
      onCancel: () => {
        resolve(false);
      },
    });
  });
}

async function showNoChangeRetryPrompt(
  flow: UseBundleRefreshAttachFlowOptions['flow'],
  details: string
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    flow.showConfirm({
      title: 'Refresh State Changed',
      message:
        `Backend requested bundle refresh, but no pending refresh steps were found.\n\n${details}\n\nRetry session attach anyway?`,
      variant: 'warning',
      confirmLabel: 'Retry attach',
      cancelLabel: 'Cancel',
      onConfirm: () => {
        resolve(true);
      },
      onCancel: () => {
        resolve(false);
      },
    });
  });
}

async function runRefreshWizard(
  flow: UseBundleRefreshAttachFlowOptions['flow'],
  plan: BundleRefreshPlan
): Promise<Record<string, string> | null> {
  return new Promise<Record<string, string> | null>((resolve) => {
    flow.showWizard({
      title: `Bundle Refresh - ${plan.workspaceName}`,
      steps: plan.steps.map(toWizardStep),
      onComplete: async (values) => {
        resolve(values);
      },
      onCancel: () => {
        resolve(null);
      },
    });
  });
}

function applyWizardValues(
  plan: BundleRefreshPlan,
  values: Record<string, string>,
  base: BundleRefreshSubmission
): BundleRefreshSubmission {
  const next: BundleRefreshSubmission = {
    inputValues: { ...base.inputValues },
    secretValues: { ...base.secretValues },
    confirmResults: { ...base.confirmResults },
  };

  for (const step of plan.steps) {
    if (step.type === 'input' && step.configKey) {
      const value = (values[step.id] ?? '').trim();
      next.inputValues[step.configKey] = value;
      continue;
    }

    if (step.type === 'secret' && step.configKey) {
      const value = (values[step.id] ?? '').trim();
      if (value.length > 0) {
        next.secretValues[step.configKey] = value;
      }
      continue;
    }

    if (step.type === 'confirm') {
      const result: ConfirmStepResult = {
        status: 'passed',
        checkCommand: step.checkCommand,
      };
      next.confirmResults[step.id] = result;
    }
  }

  return next;
}

export interface UseBundleRefreshAttachFlowResult {
  attachSessionWithBundleRefresh: (
    ref: BackendScopedWorkspaceRef,
    params: BundleRefreshAttachParams
  ) => Promise<boolean>;
  /**
   * When non-null, the last workspace attach failed in a recoverable way
   * (script failure, bundle refresh cancelled, etc.).
   * Retry with `scriptPolicy: 'skip'` to bypass scripts entirely.
   */
  recoverableParams: BundleRefreshAttachParams | null;
}

export function useBundleRefreshAttachFlow(
  options: UseBundleRefreshAttachFlowOptions
): UseBundleRefreshAttachFlowResult {
  const optionsRef = useRef(options);
  const pendingAttachRef = useRef<PendingAttach | null>(null);
  const pendingAttachTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptCounterRef = useRef(0);
  const [recoverableParams, setRecoverableParams] = useState<BundleRefreshAttachParams | null>(null);
  const lastHandledAttemptRef = useRef(0);
  const refreshInProgressRef = useRef(false);

  const clearPendingAttach = useCallback((attemptId?: number) => {
    if (attemptId !== undefined && pendingAttachRef.current?.attemptId !== attemptId) {
      return;
    }

    if (pendingAttachTimeoutRef.current) {
      clearTimeout(pendingAttachTimeoutRef.current);
      pendingAttachTimeoutRef.current = null;
    }

    pendingAttachRef.current = null;
  }, []);

  const schedulePendingAttachExpiry = useCallback((pending: PendingAttach) => {
    if (pendingAttachTimeoutRef.current) {
      clearTimeout(pendingAttachTimeoutRef.current);
    }

    pendingAttachTimeoutRef.current = setTimeout(() => {
      if (pendingAttachRef.current?.attemptId === pending.attemptId) {
        lastHandledAttemptRef.current = pending.attemptId;
        pendingAttachRef.current = null;
      }
      pendingAttachTimeoutRef.current = null;
    }, PENDING_ATTACH_TTL_MS);
  }, []);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const executeBundleRefresh = useCallback(
    async (pending: PendingAttach): Promise<boolean> => {
      const currentOptions = optionsRef.current;

      if (!currentOptions.getBundleRefreshPlan || !currentOptions.applyBundleRefresh) {
        currentOptions.flow.showMessage({
          title: 'Bundle Refresh Unsupported',
          message: 'This backend does not support bundle refresh onboarding yet.',
          variant: 'error',
        });
        setRecoverableParams(pending.params);
        return false;
      }

      if (refreshInProgressRef.current) {
        return false;
      }

      refreshInProgressRef.current = true;

      try {
        currentOptions.flow.showLoading({
          title: 'Bundle Refresh',
          message: 'Loading refresh requirements...',
        });

        const plan = await currentOptions.getBundleRefreshPlan(pending.ref);

        if (!plan.hasBundle) {
          currentOptions.flow.showMessage({
            title: 'Bundle Refresh Failed',
            message: 'No bundle configuration was found for this workspace.',
            variant: 'error',
          });
          return false;
        }

        if (!plan.hasChanged && plan.steps.length === 0) {
          const retryAttach = await showNoChangeRetryPrompt(currentOptions.flow, plan.details);
          if (!retryAttach) {
            currentOptions.flow.showMessage({
              title: 'Session Attach Cancelled',
              message: 'Bundle refresh was required by backend, and retry was cancelled.',
              variant: 'warning',
            });
            setRecoverableParams(pending.params);
            return false;
          }

          // Ensure lifecycle script output is visible in ScriptTerminal during retry.
          currentOptions.flow.close();
          await Promise.resolve(currentOptions.attachSession(pending.params));
          currentOptions.flow.close();
          return true;
        }

        const confirmed = await showRefreshPrompt(currentOptions.flow, plan.details);
        if (!confirmed) {
          currentOptions.flow.showMessage({
            title: 'Session Attach Cancelled',
            message: 'Bundle refresh is required before creating this session.',
            variant: 'warning',
          });
          setRecoverableParams(pending.params);
          return false;
        }

        let submission = createBaseSubmission(plan);

        if (plan.steps.length > 0) {
          const values = await runRefreshWizard(currentOptions.flow, plan);
          if (!values) {
            currentOptions.flow.showMessage({
              title: 'Session Attach Cancelled',
              message: 'Bundle refresh was cancelled.',
              variant: 'warning',
            });
            setRecoverableParams(pending.params);
            return false;
          }

          submission = applyWizardValues(plan, values, submission);
        }

        currentOptions.flow.showLoading({
          title: 'Bundle Refresh',
          message: 'Applying refreshed configuration...',
        });

        await currentOptions.applyBundleRefresh(pending.ref, submission);

        // Ensure lifecycle script output is visible in ScriptTerminal during retry.
        currentOptions.flow.close();

        await Promise.resolve(currentOptions.attachSession(pending.params));
        currentOptions.flow.close();
        return true;
      } catch (error) {
        const currentOptions = optionsRef.current;
        currentOptions.flow.close();
        currentOptions.flow.showMessage({
          title: 'Bundle Refresh Failed',
          message: toErrorMessage(error, 'Failed to refresh bundle configuration.'),
          variant: 'error',
        });
        setRecoverableParams(pending.params);
        return false;
      } finally {
        lastHandledAttemptRef.current = pending.attemptId;
        refreshInProgressRef.current = false;
        clearPendingAttach(pending.attemptId);
      }
    },
    [clearPendingAttach]
  );

  const executeScriptFailureNotice = useCallback(
    async (pending: PendingAttach, message: string): Promise<boolean> => {
      const currentOptions = optionsRef.current;
      currentOptions.flow.showMessage({
        title: 'Workspace Script Failed',
        message: `${message}\n\nClose this dialog to inspect script output, or attach anyway to skip scripts.`,
        variant: 'error',
      });
      setRecoverableParams(pending.params);
      lastHandledAttemptRef.current = pending.attemptId;
      clearPendingAttach(pending.attemptId);
      return false;
    },
    [clearPendingAttach]
  );

  const attachSessionWithBundleRefresh = useCallback(
    async (
      ref: BackendScopedWorkspaceRef,
      params: BundleRefreshAttachParams
    ): Promise<boolean> => {
      // Clear any previous recovery state for this new attempt.
      setRecoverableParams(null);
      const currentOptions = optionsRef.current;

      const attemptId = ++attemptCounterRef.current;
      const pending: PendingAttach = {
        ref,
        params: { ...params, workspaceId: params.workspaceId ?? ref.workspaceId },
        attemptId,
        createdAt: Date.now(),
      };
      pendingAttachRef.current = pending;
      schedulePendingAttachExpiry(pending);

      try {
        await Promise.resolve(currentOptions.attachSession(params));
        return true;
      } catch (error) {
        const code = getErrorCode(error);
        if (code === 'BUNDLE_REFRESH_REQUIRED') {
          lastHandledAttemptRef.current = pending.attemptId;
          return executeBundleRefresh(pending);
        }

        if (code && SCRIPT_FAILURE_CODES.has(code)) {
          lastHandledAttemptRef.current = pending.attemptId;
          return executeScriptFailureNotice(
            pending,
            toErrorMessage(error, 'Workspace scripts failed while preparing the session.')
          );
        }

        lastHandledAttemptRef.current = pending.attemptId;
        clearPendingAttach(pending.attemptId);
        throw error;
      }
    },
    [clearPendingAttach, executeBundleRefresh, executeScriptFailureNotice, schedulePendingAttachExpiry]
  );

  useEffect(() => {
    const commandError = options.commandError;
    if (!commandError || !commandError.code) {
      return;
    }

    const pending = pendingAttachRef.current;
    if (!pending) {
      return;
    }

    if (pending.attemptId <= lastHandledAttemptRef.current) {
      return;
    }

    if (Date.now() - pending.createdAt > PENDING_ATTACH_TTL_MS) {
      lastHandledAttemptRef.current = pending.attemptId;
      clearPendingAttach(pending.attemptId);
      return;
    }

    if (commandError.code === 'BUNDLE_REFRESH_REQUIRED') {
      void executeBundleRefresh(pending);
      return;
    }

    if (SCRIPT_FAILURE_CODES.has(commandError.code)) {
      void executeScriptFailureNotice(pending, commandError.message);
      return;
    }

    lastHandledAttemptRef.current = pending.attemptId;
    clearPendingAttach(pending.attemptId);
  }, [clearPendingAttach, executeBundleRefresh, executeScriptFailureNotice, options.commandError]);

  useEffect(() => {
    return () => {
      if (pendingAttachTimeoutRef.current) {
        clearTimeout(pendingAttachTimeoutRef.current);
        pendingAttachTimeoutRef.current = null;
      }
    };
  }, []);

  return {
    attachSessionWithBundleRefresh,
    recoverableParams,
  };
}
