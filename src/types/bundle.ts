/**
 * Type definitions for Spaces bundle configuration
 */

/**
 * Onboarding step types
 */
export type OnboardingStepType = 'info' | 'confirm' | 'secret' | 'input';

/**
 * Base interface for all onboarding steps
 */
interface BaseOnboardingStep {
  /** Unique identifier for the step */
  id: string;
  /** Step type */
  type: OnboardingStepType;
  /** Display title for the step */
  title: string;
  /** Description/instructions for the user */
  description: string;
  /** Whether this step is required (default: true) */
  required?: boolean;
}

/**
 * Info step - Display information, user just acknowledges
 */
export interface InfoStep extends BaseOnboardingStep {
  type: 'info';
}

/**
 * Confirm step - Verify something is installed or done
 */
export interface ConfirmStep extends BaseOnboardingStep {
  type: 'confirm';
  /** Command to check if installed (optional) */
  checkCommand?: string;
  /** URL for installation instructions (optional) */
  installUrl?: string;
  /** Confirmation prompt text (default: "Continue?") */
  confirmPrompt?: string;
}

/**
 * Secret step - Collect sensitive value (masked input)
 */
export interface SecretStep extends BaseOnboardingStep {
  type: 'secret';
  /** Key to store the value under in project config */
  configKey: string;
  /** Validation regex pattern (optional) */
  validationPattern?: string;
  /** Validation error message (optional) */
  validationMessage?: string;
}

/**
 * Input step - Collect non-secret value
 */
export interface InputStep extends BaseOnboardingStep {
  type: 'input';
  /** Key to store the value under in project config */
  configKey: string;
  /** Default value (optional) */
  defaultValue?: string;
  /** Validation regex pattern (optional) */
  validationPattern?: string;
  /** Validation error message (optional) */
  validationMessage?: string;
}

export type OnboardingStep = InfoStep | ConfirmStep | SecretStep | InputStep;

/**
 * Bundle manifest schema (bundle.json)
 */
export interface SpacesBundle {
  /** Bundle schema version */
  version: '1.0';
  /** Bundle name (for display) */
  name: string;
  /** Bundle description (optional) */
  description?: string;
  /** Onboarding steps to run before project setup */
  onboarding?: OnboardingStep[];
}

/**
 * Result of running onboarding steps
 */
export interface OnboardingResult {
  /** Values to store in project config */
  configValues: Record<string, string>;
  /** Whether onboarding completed successfully */
  completed: boolean;
  /** Step ID where user cancelled (if applicable) */
  cancelledAt?: string;
}

/**
 * Loaded bundle with source information
 */
export interface LoadedBundle {
  /** The bundle manifest */
  bundle: SpacesBundle;
  /** Path to the bundle directory (for script copying) */
  bundleDir: string;
  /** Source description for logging */
  source: string;
}
