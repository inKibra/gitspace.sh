import type { ConfirmStepResult } from './bundle.js';

export type BundleRefreshStepType = 'input' | 'secret' | 'confirm' | 'info';

export interface BundleRefreshStep {
  id: string;
  type: BundleRefreshStepType;
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
  hasExistingSecret?: boolean;
}

export interface BundleRefreshPlan {
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  hasBundle: boolean;
  hasChanged: boolean;
  scope?: string;
  bundleSource?: 'workspace' | 'base';
  baselineSource?: 'scope' | 'base' | 'inferred' | 'none';
  details: string;
  currentHash?: string;
  previousHash?: string;
  steps: BundleRefreshStep[];
  autoConfirmResults: Record<string, ConfirmStepResult>;
}

export interface BundleRefreshSubmission {
  inputValues: Record<string, string>;
  secretValues: Record<string, string>;
  confirmResults: Record<string, ConfirmStepResult>;
}
