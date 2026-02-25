/** @jsxImportSource react */
/**
 * Flow - Web Modal Renderers
 *
 * React components for rendering modals/dialogs on web.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { UseFlowReturn, FlowState } from './Flow.js';

// ============================================================================
// Props
// ============================================================================

interface FlowWebProps {
  flow: UseFlowReturn;
}

// ============================================================================
// Main Component
// ============================================================================

export function FlowWeb({ flow }: FlowWebProps) {
  const { flow: state, isOpen, handleConfirm, handleCancel, moveUp, moveDown } = flow;

  const copyCurrentMessage = () => {
    const message = state.type === 'message' || state.type === 'confirm'
      ? state.message
      : null;
    if (!message || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return;
    }

    void navigator.clipboard.writeText(message);
  };

  // Debug: log when modal state changes
  useEffect(() => {
    if (isOpen) {
      console.log('Modal OPEN - type:', state.type);
    }
  }, [isOpen, state.type]);

  // Keyboard handling
  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        moveUp();
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        moveDown();
      } else if (state.type === 'confirm' && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        handleConfirm();
      } else if (state.type === 'confirm' && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        handleCancel();
      } else if ((state.type === 'message' || state.type === 'confirm') && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        copyCurrentMessage();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [copyCurrentMessage, isOpen, state.type, handleConfirm, handleCancel, moveUp, moveDown]);

  if (!isOpen) return null;

  const modalContent = (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 9999, position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[#0d1117]/80 backdrop-blur-sm"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        onClick={handleCancel}
      />
      {/* Modal */}
      <div className="relative" style={{ zIndex: 10000, position: 'relative' }}>
        {renderModal(state, flow, copyCurrentMessage)}
      </div>
    </div>
  );

  // Use portal to render at document body level
  return createPortal(modalContent, document.body);
}

// ============================================================================
// Modal Renderers
// ============================================================================

function renderModal(state: FlowState, flow: UseFlowReturn, copyCurrentMessage: () => void) {
  switch (state.type) {
    case 'none':
      return null;

    case 'message':
      return (
        <Modal title={state.title}>
          <p className={`mb-4 whitespace-pre-wrap max-h-80 overflow-y-auto ${getVariantClass(state.variant)}`}>
            {state.message}
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={copyCurrentMessage}
              className="px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]"
            >
              Copy (C)
            </button>
            <button
              onClick={flow.handleConfirm}
              className="px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow"
            >
              OK
            </button>
          </div>
        </Modal>
      );

    case 'loading':
      return (
        <Modal title={state.title}>
          <div className="flex items-center gap-3">
            <div className="animate-spin w-5 h-5 border-2 border-[#22c55e] border-t-transparent rounded-full shadow-glow" />
            <span className="text-[#8b949e]">{state.message}</span>
          </div>
        </Modal>
      );

    case 'help':
      return (
        <Modal title="Keyboard Shortcuts" width="lg">
          <div className="space-y-3">
            {state.shortcuts.map((shortcut, idx) => (
              <div key={idx} className="flex py-1">
                <span className="w-20 sm:w-24 text-[#58a6ff] font-mono text-sm">{shortcut.key}</span>
                <span className="text-[#8b949e] text-sm">{shortcut.description}</span>
              </div>
            ))}
          </div>
          <div className="mt-6 text-right">
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]"
            >
              Close
            </button>
          </div>
        </Modal>
      );

    case 'confirm':
      return (
        <Modal title={state.title}>
          <p className={`mb-4 whitespace-pre-wrap max-h-80 overflow-y-auto ${getVariantClass(state.variant)}`}>
            {state.message}
          </p>
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 mt-6">
            <button
              onClick={copyCurrentMessage}
              className="px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]"
            >
              Copy (C)
            </button>
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]"
            >
              {state.cancelLabel || 'Cancel'}
            </button>
            <button
              onClick={flow.handleConfirm}
              className={`px-5 py-3 rounded-lg text-white min-h-[48px] font-medium ${
                state.variant === 'danger'
                  ? 'bg-[#f85149] hover:bg-[#ff7b72] active:bg-[#da3633] border border-[#f85149]'
                  : 'bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] shadow-glow'
              }`}
            >
              {state.confirmLabel || 'Confirm'}
            </button>
          </div>
        </Modal>
      );

    case 'confirm-typed':
      return (
        <Modal title={state.title}>
          <p className="mb-2 text-[#d29922]">{state.message}</p>
          {state.warning && (
            <p className="mb-4 text-[#f85149]">⚠️ {state.warning}</p>
          )}
          <p className="mb-2 text-[#8b949e]">
            Type "<span className="text-[#e6edf3] font-mono">{state.confirmText}</span>" to confirm:
          </p>
          <input
            type="text"
            value={state.inputValue}
            onChange={(e) => flow.handleInput(e.target.value)}
            className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all"
            autoFocus
          />
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 mt-6">
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]"
            >
              Cancel
            </button>
            <button
              onClick={flow.handleConfirm}
              disabled={state.inputValue !== state.confirmText}
              className="px-5 py-3 bg-[#f85149] hover:bg-[#ff7b72] active:bg-[#da3633] disabled:bg-[#21262d] disabled:border-[#30363d] disabled:text-[#6e7681] disabled:cursor-not-allowed text-white border border-[#f85149] rounded-lg min-h-[48px]"
            >
              Confirm
            </button>
          </div>
        </Modal>
      );

    case 'input':
      const validationError = state.validation?.(state.inputValue);
      return (
        <Modal title={state.title}>
          <label className="block mb-2 text-[#8b949e]">{state.label}</label>
          <input
            type="text"
            value={state.inputValue}
            onChange={(e) => flow.handleInput(e.target.value)}
            placeholder={state.placeholder}
            className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all"
            autoFocus
          />
          {validationError && (
            <p className="mt-2 text-[#f85149] text-sm">{validationError}</p>
          )}
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 mt-6">
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]"
            >
              Cancel
            </button>
            <button
              onClick={flow.handleConfirm}
              disabled={!!validationError && state.inputValue !== ''}
              className="px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] disabled:bg-[#21262d] disabled:border-[#30363d] disabled:text-[#6e7681] disabled:cursor-not-allowed disabled:shadow-none text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow"
            >
              Submit
            </button>
          </div>
        </Modal>
      );

    case 'select':
      return (
        <Modal title={state.title} width="lg">
          <div className="space-y-2 max-h-64 sm:max-h-80 overflow-y-auto -mx-2 px-2">
            {state.options.map((option, idx) => {
              const isSelected = idx === state.selectedIndex;
              return (
                <div
                  key={idx}
                  onClick={() => {
                    flow.handleSelect(idx);
                    flow.handleConfirm();
                  }}
                  className={`p-4 rounded-lg cursor-pointer min-h-[52px] border ${
                    isSelected
                      ? 'bg-[#21262d] border-[#58a6ff] border-l-4'
                      : 'border-[#30363d] hover:bg-[#161b22] active:bg-[#21262d]'
                  }`}
                >
                  <div className="text-[#e6edf3]">{option.label}</div>
                  {option.description && (
                    <div className="text-sm text-[#8b949e] mt-1">{option.description}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]"
            >
              Cancel
            </button>
          </div>
        </Modal>
      );

    case 'wizard':
      const step = state.steps[state.currentStep];
      if (!step) return null;

      return (
        <Modal title={state.title} width="xl">
          {/* Progress indicator */}
          <div className="flex gap-1 mb-4">
            {state.steps.map((_, idx) => (
              <div
                key={idx}
                className={`h-1.5 flex-1 rounded ${
                  idx < state.currentStep
                    ? 'bg-[#22c55e]'
                    : idx === state.currentStep
                    ? 'bg-[#58a6ff]'
                    : 'bg-[#30363d]'
                }`}
              />
            ))}
          </div>

          {/* Step content */}
          <div className="mb-6">
            <h3 className="text-lg font-medium text-[#22c55e] mb-2">{step.title}</h3>
            {step.description && (
              <p className="text-[#8b949e] mb-4">{step.description}</p>
            )}

            {step.type === 'info' && (
              <p className="text-[#e6edf3]">Tap Continue to proceed.</p>
            )}

            {(step.type === 'input' || step.type === 'secret') && (
              <input
                type={step.type === 'secret' ? 'password' : 'text'}
                value={state.inputValue}
                onChange={(e) => flow.handleInput(e.target.value)}
                placeholder={step.placeholder}
                className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all"
                autoFocus
              />
            )}

            {step.type === 'confirm' && (
              <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-lg">
                {step.checkStatus === 'checking' && (
                  <div className="flex items-center gap-2 text-[#d29922]">
                    <div className="animate-spin w-4 h-4 border-2 border-[#d29922] border-t-transparent rounded-full" />
                    Checking...
                  </div>
                )}
                {step.checkStatus === 'found' && (
                  <div className="text-[#3fb950]">✅ Found and ready</div>
                )}
                {step.checkStatus === 'missing' && (
                  <div>
                    <div className="text-[#f85149] mb-2">❌ Not found</div>
                    {step.installUrl && (
                      <a
                        href={step.installUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#58a6ff] hover:underline active:text-[#79c0ff]"
                      >
                        Install from {step.installUrl}
                      </a>
                    )}
                  </div>
                )}
              </div>
            )}

            {step.type === 'select' && step.options && (
              <div className="space-y-2">
                {step.options.map((option, idx) => (
                  <div
                    key={idx}
                    className="p-4 bg-[#161b22] border border-[#30363d] rounded-lg hover:bg-[#21262d] active:bg-[#161b22] cursor-pointer min-h-[48px]"
                  >
                    {option.label}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Navigation */}
          <div className="flex flex-col-reverse sm:flex-row justify-between gap-3">
            <button
              onClick={flow.prevStep}
              disabled={state.currentStep === 0}
              className="px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] disabled:bg-[#161b22] disabled:text-[#6e7681] disabled:border-transparent text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]"
            >
              ← Back
            </button>
            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <button
                onClick={flow.handleCancel}
                className="px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]"
              >
                Cancel
              </button>
              <button
                onClick={flow.handleConfirm}
                className="px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow"
              >
                {state.currentStep === state.steps.length - 1 ? 'Finish' : 'Continue →'}
              </button>
            </div>
          </div>
        </Modal>
      );

    default:
      return null;
  }
}

// ============================================================================
// Helper Components
// ============================================================================

interface ModalProps {
  title: string;
  children: React.ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
}

function Modal({ title, children, width = 'md' }: ModalProps) {
  const widthClass = {
    sm: 'sm:max-w-sm',
    md: 'sm:max-w-md',
    lg: 'sm:max-w-lg',
    xl: 'sm:max-w-xl',
  }[width];

  return (
    <div className={`bg-[#161b22] shadow-xl w-full mx-0 sm:mx-4 p-5 sm:p-6 border-0 sm:border border-[#30363d]
      fixed sm:relative inset-0 sm:inset-auto sm:rounded-lg
      flex flex-col sm:block max-h-screen sm:max-h-[90vh] overflow-y-auto
      ${widthClass}`}
    >
      <h2 className="text-xl font-semibold text-[#22c55e] mb-4 flex-shrink-0">{title}</h2>
      <div className="flex-1 min-h-0 text-[#e6edf3]">{children}</div>
    </div>
  );
}

// ============================================================================
// Utilities
// ============================================================================

function getVariantClass(variant?: 'info' | 'success' | 'warning' | 'error' | 'danger'): string {
  switch (variant) {
    case 'success': return 'text-[#3fb950]';
    case 'warning': return 'text-[#d29922]';
    case 'error':
    case 'danger': return 'text-[#f85149]';
    case 'info':
    default: return 'text-[#8b949e]';
  }
}
