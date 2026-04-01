/** @jsxImportSource react */
/**
 * Flow - Web Modal Renderers
 *
 * React components for rendering modals/dialogs on web.
 */

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getVisibleSelectOptions, type UseFlowReturn, type FlowState } from './Flow.js';

interface FlowWebProps {
  flow: UseFlowReturn;
}

const BTN_PRIMARY = 'gs-button-primary';
const BTN_SECONDARY = 'gs-button-secondary';
const BTN_DANGER = 'gs-button-danger';
const FIELD = 'gs-field';

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

  useEffect(() => {
    if (!isOpen) return;

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTypingField = (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target?.isContentEditable
      );

      if (isTypingField && e.key !== 'Escape' && e.key !== 'Enter') {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleConfirm();
      } else if (!isTypingField && (e.key === 'ArrowUp' || e.key === 'k')) {
        e.preventDefault();
        moveUp();
      } else if (!isTypingField && (e.key === 'ArrowDown' || e.key === 'j')) {
        e.preventDefault();
        moveDown();
      } else if (!isTypingField && state.type === 'confirm' && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        handleConfirm();
      } else if (!isTypingField && state.type === 'confirm' && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        handleCancel();
      } else if (!isTypingField && (state.type === 'message' || state.type === 'confirm') && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        copyCurrentMessage();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [copyCurrentMessage, isOpen, state.type, handleConfirm, handleCancel, moveUp, moveDown]);

  if (!isOpen) return null;

  return createPortal(
    <div className="gs-overlay-root" role="dialog" aria-modal="true">
      <div className="absolute inset-0 gs-overlay-backdrop" onClick={handleCancel} />
      <div className="relative">
        {renderModal(state, flow, copyCurrentMessage)}
      </div>
    </div>,
    document.body,
  );
}

function renderModal(state: FlowState, flow: UseFlowReturn, copyCurrentMessage: () => void) {
  switch (state.type) {
    case 'none':
      return null;

    case 'message':
      return (
        <Modal title={state.title} kicker={getVariantLabel(state.variant) ?? 'Notice'}>
          <div className="gs-panel-block">
            <p className={`whitespace-pre-wrap max-h-80 overflow-y-auto ${getVariantClass(state.variant)}`}>
              {state.message}
            </p>
            <ActionRow>
              <button onClick={copyCurrentMessage} className={BTN_SECONDARY}>Copy</button>
              <button onClick={flow.handleConfirm} className={BTN_PRIMARY}>OK</button>
            </ActionRow>
          </div>
        </Modal>
      );

    case 'loading':
      return (
        <Modal title={state.title} kicker="Working">
          <div className="gs-panel-block">
            <div className="gs-loading-indicator">{state.message}</div>
            <p className="gs-auth-note">Please keep this window open until the operation finishes.</p>
          </div>
        </Modal>
      );

    case 'help':
      return (
        <Modal title="Keyboard Shortcuts" kicker="Reference" width="lg">
          <div className="gs-panel-block">
            <div className="gs-select-list">
              {state.shortcuts.map((shortcut, idx) => (
                <div key={idx} className="flex items-start justify-between gap-4 bg-[var(--gs-bg-surface)] px-4 py-3 text-sm">
                  <span className="gs-info-text">{shortcut.key}</span>
                  <span className="text-[var(--gs-text-muted)] text-right">{shortcut.description}</span>
                </div>
              ))}
            </div>
            <ActionRow>
              <button onClick={flow.handleCancel} className={BTN_SECONDARY}>Close</button>
            </ActionRow>
          </div>
        </Modal>
      );

    case 'confirm':
      return (
        <Modal title={state.title} kicker={getVariantLabel(state.variant) ?? 'Confirm'}>
          <div className="gs-panel-block">
            <p className={`whitespace-pre-wrap max-h-80 overflow-y-auto ${getVariantClass(state.variant)}`}>
              {state.message}
            </p>
            <ActionRow>
              <button onClick={copyCurrentMessage} className={BTN_SECONDARY}>Copy</button>
              <button onClick={flow.handleCancel} className={BTN_SECONDARY}>{state.cancelLabel || 'Cancel'}</button>
              <button onClick={flow.handleConfirm} className={state.variant === 'danger' ? BTN_DANGER : BTN_PRIMARY}>
                {state.confirmLabel || 'Confirm'}
              </button>
            </ActionRow>
          </div>
        </Modal>
      );

    case 'confirm-typed':
      return (
        <Modal title={state.title} kicker="Destructive action">
          <div className="gs-panel-block">
            <p className="gs-warning-text whitespace-pre-wrap">{state.message}</p>
            {state.warning && <p className="gs-danger-text">{state.warning}</p>}
            <div className="gs-empty-panel">
              Type <span className="gs-inline-code">{state.confirmText}</span> to confirm.
            </div>
            <input
              type="text"
              value={state.inputValue}
              onChange={(e) => flow.handleInput(e.target.value)}
              className={FIELD}
              autoFocus
            />
            <ActionRow>
              <button onClick={flow.handleCancel} className={BTN_SECONDARY}>Cancel</button>
              <button
                onClick={flow.handleConfirm}
                disabled={state.inputValue !== state.confirmText}
                className={BTN_DANGER}
              >
                Confirm
              </button>
            </ActionRow>
          </div>
        </Modal>
      );

    case 'input': {
      const validationError = state.validation?.(state.inputValue);
      return (
        <Modal title={state.title} kicker="Input">
          <div className="gs-panel-block">
            <label className="gs-panel-label">{state.label}</label>
            <input
              type="text"
              value={state.inputValue}
              onChange={(e) => flow.handleInput(e.target.value)}
              placeholder={state.placeholder}
              className={FIELD}
              autoFocus
            />
            {validationError && <p className="gs-danger-text text-sm">{validationError}</p>}
            <ActionRow>
              <button onClick={flow.handleCancel} className={BTN_SECONDARY}>Cancel</button>
              <button
                onClick={flow.handleConfirm}
                disabled={!!validationError && state.inputValue !== ''}
                className={BTN_PRIMARY}
              >
                Submit
              </button>
            </ActionRow>
          </div>
        </Modal>
      );
    }

    case 'select': {
      const visibleOptions = getVisibleSelectOptions(state);
      return (
        <Modal title={state.title} kicker="Select" width="lg">
          <div className="gs-panel-block">
            {state.searchable && (
              <input
                type="text"
                value={state.searchQuery ?? ''}
                onChange={(e) => flow.updateSelectQuery(e.target.value)}
                placeholder="Filter options..."
                className={FIELD}
                autoFocus
              />
            )}
            {visibleOptions.length === 0 ? (
              <div className="gs-empty-panel">No matches for "{state.searchQuery ?? ''}".</div>
            ) : (
              <div className="gs-select-list max-h-64 sm:max-h-80 overflow-y-auto">
                {visibleOptions.map(({ option, index }) => {
                  const isSelected = index === state.selectedIndex;
                  return (
                    <button
                      key={index}
                      type="button"
                      onClick={() => {
                        flow.handleSelect(index);
                        flow.handleConfirm();
                      }}
                      className={`gs-select-item ${isSelected ? 'gs-select-item--active' : ''}`}
                    >
                      <div>{option.label}</div>
                      {option.description && (
                        <div className="mt-1 text-sm text-[var(--gs-text-dim)]">{option.description}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <ActionRow>
              <button onClick={flow.handleCancel} className={BTN_SECONDARY}>Cancel</button>
            </ActionRow>
          </div>
        </Modal>
      );
    }

    case 'wizard': {
      const step = state.steps[state.currentStep];
      if (!step) return null;

      return (
        <Modal title={state.title} kicker={`Step ${state.currentStep + 1} / ${state.steps.length}`} width="xl">
          <div className="gs-panel-block">
            <div className="gs-shell-meta-row">
              {state.steps.map((wizardStep, idx) => (
                <span
                  key={wizardStep.id}
                  className={idx === state.currentStep ? 'text-[var(--gs-text)]' : idx < state.currentStep ? 'gs-success-text' : 'text-[var(--gs-text-dim)]'}
                >
                  {wizardStep.title}
                </span>
              ))}
            </div>

            <div className="gs-panel-block">
              <h3 className="text-[var(--gs-text)]">{step.title}</h3>
              {step.description && <p className="text-[var(--gs-text-muted)]">{step.description}</p>}

              {step.type === 'info' && <p className="text-[var(--gs-text-muted)]">Continue when you're ready.</p>}

              {(step.type === 'input' || step.type === 'secret') && (
                <input
                  type={step.type === 'secret' ? 'password' : 'text'}
                  value={state.inputValue}
                  onChange={(e) => flow.handleInput(e.target.value)}
                  placeholder={step.placeholder}
                  className={FIELD}
                  autoFocus
                />
              )}

              {step.type === 'confirm' && (
                <div className="gs-empty-panel">
                  {step.checkStatus === 'checking' && (
                    <div className="gs-loading-indicator">Checking requirement…</div>
                  )}
                  {step.checkStatus === 'found' && <div className="gs-success-text">Found and ready.</div>}
                  {step.checkStatus === 'missing' && (
                    <div className="gs-panel-block">
                      <div className="gs-danger-text">Requirement not found.</div>
                      {step.installUrl && (
                        <a
                          href={step.installUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="gs-info-text hover:underline"
                        >
                          Open install instructions
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}

              {step.type === 'select' && step.options && (
                <div className="gs-select-list">
                  {step.options.map((option, idx) => {
                    const isSelected = state.inputValue === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => flow.handleSelect(idx)}
                        aria-pressed={isSelected}
                        className={`gs-select-item text-left ${isSelected ? 'gs-select-item--active' : ''}`}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
              <button
                onClick={flow.prevStep}
                disabled={state.currentStep === 0}
                className={BTN_SECONDARY}
              >
                ← Back
              </button>
              <div className="flex flex-col-reverse gap-3 sm:flex-row">
                <button onClick={flow.handleCancel} className={BTN_SECONDARY}>Cancel</button>
                <button onClick={flow.handleConfirm} className={BTN_PRIMARY}>
                  {state.currentStep === state.steps.length - 1 ? 'Finish' : 'Continue →'}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      );
    }

    default:
      return null;
  }
}

interface ModalProps {
  title: string;
  children: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
  kicker?: string;
}

function Modal({ title, children, width = 'md', kicker }: ModalProps) {
  const widthClass = width === 'sm'
    ? 'gs-shell-card--compact'
    : width === 'md'
      ? 'gs-shell-card--compact'
      : width === 'lg'
        ? ''
        : 'gs-shell-card--wide';

  return (
    <div className={`gs-shell-card ${widthClass}`}>
      <div className="gs-shell-header">
        <div className="gs-shell-title-stack">
          <div className="gs-shell-kicker">{kicker ?? 'Panel'}</div>
          <h2 className="gs-shell-title">{title}</h2>
        </div>
      </div>
      <div className="gs-shell-body">{children}</div>
    </div>
  );
}

function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{children}</div>;
}

function getVariantClass(variant?: 'info' | 'success' | 'warning' | 'error' | 'danger'): string {
  switch (variant) {
    case 'success': return 'gs-success-text';
    case 'warning': return 'gs-warning-text';
    case 'error':
    case 'danger': return 'gs-danger-text';
    case 'info': return 'gs-info-text';
    default: return 'text-[var(--gs-text-muted)]';
  }
}

function getVariantLabel(variant?: 'info' | 'success' | 'warning' | 'error' | 'danger'): string | null {
  switch (variant) {
    case 'success': return 'Success';
    case 'warning': return 'Warning';
    case 'error':
    case 'danger': return 'Danger';
    case 'info': return 'Info';
    default: return null;
  }
}