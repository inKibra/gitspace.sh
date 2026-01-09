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
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, state.type, handleConfirm, handleCancel, moveUp, moveDown]);

  if (!isOpen) return null;

  const modalContent = (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 9999, position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        onClick={handleCancel}
      />
      {/* Modal */}
      <div className="relative" style={{ zIndex: 10000, position: 'relative' }}>
        {renderModal(state, flow)}
      </div>
    </div>
  );

  // Use portal to render at document body level
  return createPortal(modalContent, document.body);
}

// ============================================================================
// Modal Renderers
// ============================================================================

function renderModal(state: FlowState, flow: UseFlowReturn) {
  switch (state.type) {
    case 'none':
      return null;

    case 'message':
      return (
        <Modal title={state.title}>
          <p className={`mb-4 ${getVariantClass(state.variant)}`}>
            {state.message}
          </p>
          <div className="flex justify-end">
            <button
              onClick={flow.handleConfirm}
              className="px-5 py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-lg min-h-[48px]"
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
            <div className="animate-spin w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full" />
            <span className="text-gray-300">{state.message}</span>
          </div>
        </Modal>
      );

    case 'help':
      return (
        <Modal title="Keyboard Shortcuts" width="lg">
          <div className="space-y-3">
            {state.shortcuts.map((shortcut, idx) => (
              <div key={idx} className="flex py-1">
                <span className="w-20 sm:w-24 text-blue-400 font-mono text-sm">{shortcut.key}</span>
                <span className="text-gray-300 text-sm">{shortcut.description}</span>
              </div>
            ))}
          </div>
          <div className="mt-6 text-right">
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white rounded-lg min-h-[48px]"
            >
              Close
            </button>
          </div>
        </Modal>
      );

    case 'confirm':
      return (
        <Modal title={state.title}>
          <p className={`mb-4 ${getVariantClass(state.variant)}`}>
            {state.message}
          </p>
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 mt-6">
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white rounded-lg min-h-[48px]"
            >
              {state.cancelLabel || 'Cancel'}
            </button>
            <button
              onClick={flow.handleConfirm}
              className={`px-5 py-3 rounded-lg text-white min-h-[48px] ${
                state.variant === 'danger'
                  ? 'bg-red-600 hover:bg-red-700 active:bg-red-800'
                  : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800'
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
          <p className="mb-2 text-yellow-400">{state.message}</p>
          {state.warning && (
            <p className="mb-4 text-red-400">⚠️ {state.warning}</p>
          )}
          <p className="mb-2 text-gray-400">
            Type "<span className="text-white font-mono">{state.confirmText}</span>" to confirm:
          </p>
          <input
            type="text"
            value={state.inputValue}
            onChange={(e) => flow.handleInput(e.target.value)}
            className="w-full p-3 text-base bg-gray-700 border border-gray-600 rounded-lg text-white focus:border-blue-500 focus:outline-none"
            autoFocus
          />
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 mt-6">
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white rounded-lg min-h-[48px]"
            >
              Cancel
            </button>
            <button
              onClick={flow.handleConfirm}
              disabled={state.inputValue !== state.confirmText}
              className="px-5 py-3 bg-red-600 hover:bg-red-700 active:bg-red-800 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg min-h-[48px]"
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
          <label className="block mb-2 text-gray-300">{state.label}</label>
          <input
            type="text"
            value={state.inputValue}
            onChange={(e) => flow.handleInput(e.target.value)}
            placeholder={state.placeholder}
            className="w-full p-3 text-base bg-gray-700 border border-gray-600 rounded-lg text-white focus:border-blue-500 focus:outline-none"
            autoFocus
          />
          {validationError && (
            <p className="mt-2 text-red-400 text-sm">{validationError}</p>
          )}
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-3 mt-6">
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white rounded-lg min-h-[48px]"
            >
              Cancel
            </button>
            <button
              onClick={flow.handleConfirm}
              disabled={!!validationError && state.inputValue !== ''}
              className="px-5 py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg min-h-[48px]"
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
                  className={`p-4 rounded-lg cursor-pointer min-h-[52px] ${
                    isSelected
                      ? 'bg-gray-700 border-l-4 border-l-blue-500'
                      : 'hover:bg-gray-800 active:bg-gray-700'
                  }`}
                >
                  <div className="text-white">{option.label}</div>
                  {option.description && (
                    <div className="text-sm text-gray-400 mt-1">{option.description}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={flow.handleCancel}
              className="px-5 py-3 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white rounded-lg min-h-[48px]"
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
                    ? 'bg-green-500'
                    : idx === state.currentStep
                    ? 'bg-blue-500'
                    : 'bg-gray-700'
                }`}
              />
            ))}
          </div>

          {/* Step content */}
          <div className="mb-6">
            <h3 className="text-lg font-medium text-green-400 mb-2">{step.title}</h3>
            {step.description && (
              <p className="text-gray-400 mb-4">{step.description}</p>
            )}

            {step.type === 'info' && (
              <p className="text-gray-300">Tap Continue to proceed.</p>
            )}

            {(step.type === 'input' || step.type === 'secret') && (
              <input
                type={step.type === 'secret' ? 'password' : 'text'}
                value={state.inputValue}
                onChange={(e) => flow.handleInput(e.target.value)}
                placeholder={step.placeholder}
                className="w-full p-3 text-base bg-gray-700 border border-gray-600 rounded-lg text-white focus:border-blue-500 focus:outline-none"
                autoFocus
              />
            )}

            {step.type === 'confirm' && (
              <div className="p-4 bg-gray-800 rounded-lg">
                {step.checkStatus === 'checking' && (
                  <div className="flex items-center gap-2 text-yellow-400">
                    <div className="animate-spin w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full" />
                    Checking...
                  </div>
                )}
                {step.checkStatus === 'found' && (
                  <div className="text-green-400">✅ Found and ready</div>
                )}
                {step.checkStatus === 'missing' && (
                  <div>
                    <div className="text-red-400 mb-2">❌ Not found</div>
                    {step.installUrl && (
                      <a
                        href={step.installUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline active:text-blue-300"
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
                    className="p-4 bg-gray-800 rounded-lg hover:bg-gray-700 active:bg-gray-600 cursor-pointer min-h-[48px]"
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
              className="px-5 py-3 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 disabled:bg-gray-800 disabled:text-gray-500 text-white rounded-lg min-h-[48px]"
            >
              ← Back
            </button>
            <div className="flex flex-col-reverse sm:flex-row gap-3">
              <button
                onClick={flow.handleCancel}
                className="px-5 py-3 bg-gray-700 hover:bg-gray-600 active:bg-gray-500 text-white rounded-lg min-h-[48px]"
              >
                Cancel
              </button>
              <button
                onClick={flow.handleConfirm}
                className="px-5 py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-lg min-h-[48px]"
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
    <div className={`bg-gray-900 shadow-xl w-full mx-0 sm:mx-4 p-5 sm:p-6 border-0 sm:border border-gray-700
      fixed sm:relative inset-0 sm:inset-auto sm:rounded-lg
      flex flex-col sm:block max-h-screen sm:max-h-[90vh] overflow-y-auto
      ${widthClass}`}
    >
      <h2 className="text-xl font-semibold text-green-400 mb-4 flex-shrink-0">{title}</h2>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

// ============================================================================
// Utilities
// ============================================================================

function getVariantClass(variant?: 'info' | 'success' | 'warning' | 'error' | 'danger'): string {
  switch (variant) {
    case 'success': return 'text-green-400';
    case 'warning': return 'text-yellow-400';
    case 'error':
    case 'danger': return 'text-red-400';
    case 'info':
    default: return 'text-gray-300';
  }
}
