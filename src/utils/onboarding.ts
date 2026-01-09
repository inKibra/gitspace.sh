/**
 * Onboarding step execution engine
 * Runs interactive onboarding steps from bundle manifests
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';
import { promptInput, promptConfirm, promptPassword } from './prompts.js';
import type {
  OnboardingStep,
  OnboardingResult,
  InfoStep,
  ConfirmStep,
  SecretStep,
  InputStep,
} from '../types/bundle.js';

const execFileAsync = promisify(execFile);

/**
 * Execute all onboarding steps
 */
export async function runOnboarding(
  steps: OnboardingStep[]
): Promise<OnboardingResult> {
  const result: OnboardingResult = {
    configValues: {},
    completed: false,
  };

  logger.bold('\n=== Project Onboarding ===\n');

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNumber = i + 1;
    const totalSteps = steps.length;

    logger.log(`\n[${stepNumber}/${totalSteps}] ${step.title}`);
    logger.dim(step.description);
    logger.log('');

    const stepResult = await executeStep(step);

    if (stepResult === null) {
      // User cancelled
      result.cancelledAt = step.id;
      logger.warning('\nOnboarding cancelled');
      return result;
    }

    // Store values for secret/input steps
    if (step.type === 'secret' || step.type === 'input') {
      const configKey = (step as SecretStep | InputStep).configKey;
      result.configValues[configKey] = stepResult;
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
async function executeStep(step: OnboardingStep): Promise<string | null> {
  switch (step.type) {
    case 'info':
      return executeInfoStep(step);
    case 'confirm':
      return executeConfirmStep(step);
    case 'secret':
      return executeSecretStep(step);
    case 'input':
      return executeInputStep(step);
    default:
      logger.warning('Unknown step type, skipping');
      return '';
  }
}

/**
 * Execute info step - just wait for acknowledgment
 */
async function executeInfoStep(step: InfoStep): Promise<string | null> {
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
        return null;
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
  return confirmed ? '' : null;
}

/**
 * Execute secret step - collect masked input
 */
async function executeSecretStep(step: SecretStep): Promise<string | null> {
  const validator = step.validationPattern
    ? createValidator(step.validationPattern, step.validationMessage)
    : undefined;

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
async function executeInputStep(step: InputStep): Promise<string | null> {
  const validator = step.validationPattern
    ? createValidator(step.validationPattern, step.validationMessage)
    : undefined;

  const value = await promptInput(`Enter ${step.title}:`, {
    default: step.defaultValue,
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
 * Check if a command exists in PATH
 */
async function checkCommandExists(command: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) {
    return false;
  }

  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a validator function from regex pattern
 */
function createValidator(
  pattern: string,
  message?: string
): (value: string) => boolean | string {
  const regex = new RegExp(pattern);
  return (value: string) => {
    if (regex.test(value)) {
      return true;
    }
    return message || `Value must match pattern: ${pattern}`;
  };
}
