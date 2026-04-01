/**
 * Onboarding step execution engine
 * Runs interactive onboarding steps from bundle manifests
 */

import { logger } from './logger.js';
import { promptInput, promptConfirm, promptPassword, selectOne } from './prompts.js';
import { checkCommandExists } from './deps.js';
import type {
  OnboardingStep,
  OnboardingResult,
  ConfirmStepResult,
  ConfirmStep,
  SecretStep,
  InputStep,
  SelectStep,
} from '../types/bundle.js';

/**
 * Marker value returned when user chooses to keep an existing secret
 */
export const KEEP_EXISTING_SECRET = '__KEEP_EXISTING_SECRET__';

/**
 * Marker value returned when an optional confirm step is skipped.
 */
const SKIP_OPTIONAL_CONFIRM = '__SKIP_OPTIONAL_CONFIRM__';

/**
 * Options for running onboarding
 */
export interface OnboardingOptions {
  /** Previous values from a prior onboarding run (for refresh) */
  previousValues?: Record<string, string>;
  /** Previous secret keys that exist in keychain */
  previousSecretKeys?: string[];
  /** Title to show (default: "Project Onboarding") */
  title?: string;
  /** Whether this is a refresh (shows different messaging) */
  isRefresh?: boolean;
}

/**
 * Execute all onboarding steps
 */
export async function runOnboarding(
  steps: OnboardingStep[],
  options: OnboardingOptions = {}
): Promise<OnboardingResult> {
  const result: OnboardingResult = {
    inputValues: {},
    secretValues: {},
    confirmResults: {},
    completed: false,
  };

  const title = options.title || 'Project Onboarding';
  const refreshNote = options.isRefresh ? ' (refreshing - press Enter to keep existing values)' : '';
  logger.bold(`\n=== ${title}${refreshNote} ===\n`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNumber = i + 1;
    const totalSteps = steps.length;

    logger.log(`\n[${stepNumber}/${totalSteps}] ${step.title}`);
    logger.dim(step.description);
    logger.log('');

    const stepResult = await executeStep(step, options);

    if (stepResult === null) {
      // User cancelled
      result.cancelledAt = step.id;
      logger.warning('\nOnboarding cancelled');
      return result;
    }

    // Store values and metadata by step type
    if (step.type === 'secret') {
      result.secretValues[step.configKey] = stepResult as string;
    } else if (step.type === 'input' || step.type === 'select') {
      result.inputValues[step.configKey] = stepResult as string;
    } else if (step.type === 'confirm') {
      const confirmResult: ConfirmStepResult = {
        status: stepResult === SKIP_OPTIONAL_CONFIRM ? 'skipped' : 'passed',
        checkCommand: step.checkCommand,
      };
      result.confirmResults[step.id] = confirmResult;
    }
  }

  result.completed = true;
  logger.success('\nOnboarding complete!');
  return result;
}

/**
 * Execute a single onboarding step
 * Returns collected value or null if cancelled
 */
async function executeStep(
  step: OnboardingStep,
  options: OnboardingOptions,
): Promise<string | null> {
  switch (step.type) {
    case 'info':
      return executeInfoStep();
    case 'confirm':
      return executeConfirmStep(step);
    case 'secret':
      return executeSecretStep(step, options);
    case 'input':
      return executeInputStep(step, options);
    case 'select':
      return executeSelectStep(step, options);
    default:
      logger.warning('Unknown step type, skipping');
      return '';
  }
}

/**
 * Execute info step - just wait for acknowledgment
 */
async function executeInfoStep(): Promise<string | null> {
  const confirmed = await promptConfirm('Press Enter to continue...', true);
  return confirmed ? '' : null;
}

/**
 * Execute confirm step - optionally check command
 */
async function executeConfirmStep(step: ConfirmStep): Promise<string | null> {
  // Check if command exists (if specified)
  if (step.checkCommand) {
    const exists = await checkCommandExists(step.checkCommand);

    if (exists) {
      logger.success(`✓ ${step.checkCommand} is installed`);
      return '';
    }

    logger.warning(`✗ ${step.checkCommand} not found in PATH`);

    if (step.installUrl) {
      logger.log(`\nInstall instructions: ${step.installUrl}`);
    }

    // Ask user to confirm they've installed it
    const prompt = step.confirmPrompt || `Have you installed ${step.checkCommand}?`;

    while (true) {
      const confirmed = await promptConfirm(prompt, false);

      if (!confirmed) {
        // User said no or cancelled
        if (step.required !== false) {
          logger.warning('This step is required. Please install and try again.');
          continue;
        }
        // Optional step - skip it
        logger.dim('Skipping optional step');
        return SKIP_OPTIONAL_CONFIRM;
      }

      // Re-check if they say yes
      const nowExists = await checkCommandExists(step.checkCommand);
      if (nowExists) {
        logger.success(`✓ ${step.checkCommand} is now available`);
        return '';
      }

      logger.warning(`${step.checkCommand} still not found. Please ensure it's in your PATH.`);
    }
  }

  // No command check, just confirm
  const prompt = step.confirmPrompt || 'Continue?';
  const confirmed = await promptConfirm(prompt, true);
  if (!confirmed && step.required === false) {
    // Optional step - skip it instead of cancelling
    logger.dim('Skipping optional step');
    return SKIP_OPTIONAL_CONFIRM;
  }
  return confirmed ? '' : null;
}

/**
 * Execute secret step - collect masked input
 */
async function executeSecretStep(step: SecretStep, options: OnboardingOptions): Promise<string | null> {
  const validator = step.validationPattern
    ? createValidator(step.validationPattern, step.validationMessage)
    : undefined;

  // Check if we have an existing secret for this key
  const hasExistingSecret = options.previousSecretKeys?.includes(step.configKey);

  if (hasExistingSecret && options.isRefresh) {
    logger.dim('  (existing secret found)');
    const keepExisting = await promptConfirm('Keep existing secret? (Enter to keep, n to change)', true);
    if (keepExisting) {
      // Return special marker that means "keep existing"
      return KEEP_EXISTING_SECRET;
    }
  }

  while (true) {
    const value = await promptPassword(`Enter ${step.title}:`);

    if (value === null) {
      return null; // Cancelled
    }

    if (!value && step.required !== false) {
      logger.warning('This field is required');
      continue;
    }

    if (validator && value) {
      const validationResult = validator(value);
      if (validationResult !== true) {
        logger.warning(typeof validationResult === 'string' ? validationResult : 'Invalid input');
        continue;
      }
    }

    return value;
  }
}

/**
 * Execute input step - collect plain text input
 */
async function executeInputStep(step: InputStep, options: OnboardingOptions): Promise<string | null> {
  const validator = step.validationPattern
    ? createValidator(step.validationPattern, step.validationMessage)
    : undefined;

  // Use previous value as default if available (for refresh), otherwise use step's default
  const previousValue = options.previousValues?.[step.configKey];
  const defaultValue = previousValue ?? step.defaultValue;

  if (previousValue && options.isRefresh) {
    logger.dim(`  (current value: ${previousValue})`);
  }

  const value = await promptInput(`Enter ${step.title}:`, {
    default: defaultValue,
    validate: (input) => {
      if (!input && step.required !== false) {
        return 'This field is required';
      }
      if (validator && input) {
        return validator(input);
      }
      return true;
    },
  });

  return value;
}

/**
 * Execute select step - choose one option
 */
async function executeSelectStep(step: SelectStep, options: OnboardingOptions): Promise<string | null> {
  const previousValue = options.previousValues?.[step.configKey];
  const defaultValue = previousValue ?? step.defaultValue;

  if (previousValue && options.isRefresh) {
    logger.dim(`  (current value: ${previousValue})`);
  }

  const orderedOptions = defaultValue
    ? [
        ...step.options.filter((option) => option.value === defaultValue),
        ...step.options.filter((option) => option.value !== defaultValue),
      ]
    : step.options;

  return selectOne(orderedOptions, `Choose ${step.title}:`);
}

/**
 * Create a validator function from regex pattern
 * Returns undefined if the pattern is invalid
 */
function createValidator(
  pattern: string,
  message?: string
): ((value: string) => boolean | string) | undefined {
  try {
    const regex = new RegExp(pattern);
    return (value: string) => {
      if (regex.test(value)) {
        return true;
      }
      return message || `Value must match pattern: ${pattern}`;
    };
  } catch (error) {
    logger.warning(`Invalid validation pattern '${pattern}', skipping validation`);
    return undefined;
  }
}
