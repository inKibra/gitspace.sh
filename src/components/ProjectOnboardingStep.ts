import type { OnboardingStep } from '../types/bundle.js';

export interface ProjectOnboardingFlowState {
  bundleName: string;
  steps: OnboardingStep[];
  currentStep: number;
  inputValue: string;
  confirmStatus?: 'checking' | 'found' | 'missing' | null;
}

export interface ProjectOnboardingColors {
  title: string;
  selected: string;
  text: string;
  textDim: string;
  loading: string;
  error: string;
  border: string;
}

export function getCurrentOnboardingStep(flow: ProjectOnboardingFlowState): OnboardingStep | null {
  return flow.steps[flow.currentStep] ?? null;
}
