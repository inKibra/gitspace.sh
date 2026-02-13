import { getCurrentOnboardingStep, type ProjectOnboardingFlowState } from './ProjectOnboardingStep.js';

interface ProjectOnboardingStepWebProps {
  flow: ProjectOnboardingFlowState;
}

export function ProjectOnboardingStepWeb({ flow }: ProjectOnboardingStepWebProps) {
  const step = getCurrentOnboardingStep(flow);
  if (!step) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[#3fb950] font-medium">
        {flow.bundleName} Setup ({flow.currentStep + 1}/{flow.steps.length})
      </h3>
      <p className="text-[#e6edf3] font-medium">{step.title}</p>
      {step.description && <p className="text-[#8b949e] text-sm">{step.description}</p>}

      {step.type === 'confirm' && flow.confirmStatus === 'missing' && step.installUrl && (
        <p className="text-[#58a6ff] text-sm">Install: {step.installUrl}</p>
      )}

      {step.type === 'input' && (
        <div className="rounded border border-[#30363d] px-3 py-2 text-[#e6edf3]">
          {flow.inputValue || ' '}
        </div>
      )}

      {step.type === 'secret' && (
        <>
          <div className="rounded border border-[#30363d] px-3 py-2 text-[#e6edf3]">
            {'•'.repeat(flow.inputValue.length) || ' '}
          </div>
          <p className="text-[#8b949e] text-xs">Value will be stored securely in OS keychain</p>
        </>
      )}
    </div>
  );
}
