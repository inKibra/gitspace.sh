import type { ConfirmStepResult, OnboardingStepType } from './bundle.js';

export interface BundleConfigStep {
  id: string;
  type: OnboardingStepType;
  title: string;
  description: string;
  required?: boolean;
  configKey?: string;
  defaultValue?: string;
  validationPattern?: string;
  validationMessage?: string;
  checkCommand?: string;
  installUrl?: string;
  confirmPrompt?: string;
  value?: string;
  hasSecret?: boolean;
  confirmResult?: ConfirmStepResult;
  confirmCheckedAt?: string;
}

export interface BundleConfigState {
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  hasBundle: boolean;
  scope?: string;
  bundleSource?: 'workspace' | 'base';
  currentHash?: string;
  details: string;
  bundleName?: string;
  bundleVersion?: string;
  steps: BundleConfigStep[];
}

export interface BundleConfigSubmission {
  inputValues?: Record<string, string>;
  secretValues?: Record<string, string>;
  confirmResults?: Record<string, ConfirmStepResult>;
}
