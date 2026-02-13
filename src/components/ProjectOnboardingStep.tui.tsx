import {
  getCurrentOnboardingStep,
  type ProjectOnboardingColors,
  type ProjectOnboardingFlowState,
} from './ProjectOnboardingStep.js';

interface ProjectOnboardingStepTUIProps {
  flow: ProjectOnboardingFlowState;
  colors: ProjectOnboardingColors;
}

export function ProjectOnboardingStepTUI({ flow, colors }: ProjectOnboardingStepTUIProps) {
  const step = getCurrentOnboardingStep(flow);
  if (!step) {
    return null;
  }

  return (
    <>
      <text fg={colors.title} height={1}>
        {flow.bundleName} Setup ({flow.currentStep + 1}/{flow.steps.length})
      </text>
      <text fg={colors.selected} height={1} marginTop={1}>{step.title}</text>
      {step.description && (
        <text fg={colors.textDim} height={1} marginTop={1}>{step.description}</text>
      )}

      {step.type === 'info' && (
        <text fg={colors.text} height={1} marginTop={1}>Press Enter to continue</text>
      )}

      {step.type === 'confirm' && (
        <box flexDirection="column" marginTop={1}>
          {flow.confirmStatus === 'checking' && (
            <text fg={colors.loading} height={1}>⏳ Checking...</text>
          )}
          {flow.confirmStatus === 'found' && (
            <text fg={colors.title} height={1}>✅ Found</text>
          )}
          {flow.confirmStatus === 'missing' && (
            <>
              <text fg={colors.error} height={1}>❌ Not found</text>
              {step.installUrl && (
                <text fg={colors.selected} height={1} marginTop={1}>
                  Install: {step.installUrl}
                </text>
              )}
            </>
          )}
          {flow.confirmStatus !== 'checking' && (
            <text fg={colors.text} height={1} marginTop={1}>Press Enter to continue</text>
          )}
        </box>
      )}

      {step.type === 'input' && (
        <box flexDirection="column" marginTop={1}>
          <box
            borderStyle="rounded"
            borderColor={colors.border}
            padding={0}
            width="100%"
          >
            <text fg={colors.text} height={1}>{flow.inputValue || ' '}_</text>
          </box>
        </box>
      )}

      {step.type === 'secret' && (
        <box flexDirection="column" marginTop={1}>
          <box
            borderStyle="rounded"
            borderColor={colors.border}
            padding={0}
            width="100%"
          >
            <text fg={colors.text} height={1}>{'•'.repeat(flow.inputValue.length) || ' '}_</text>
          </box>
          <text fg={colors.textDim} height={1} marginTop={1}>Value will be stored securely in OS keychain</text>
        </box>
      )}

      <text fg={colors.textDim} height={1} marginTop={1}>
        [Enter] {flow.currentStep === flow.steps.length - 1 ? 'Finish' : 'Next'}  [Esc] Cancel
      </text>
    </>
  );
}
