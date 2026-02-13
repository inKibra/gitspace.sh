/**
 * Flow - TUI Modal Renderers
 *
 * OpenTUI components for rendering modals/dialogs.
 */

import type { UseFlowReturn, FlowState } from './Flow.js';

// ============================================================================
// Colors
// ============================================================================

const COLORS = {
  border: '#555555',
  borderFocused: '#00AAFF',
  text: '#FFFFFF',
  textDim: '#888888',
  selected: '#00AAFF',
  title: '#00FF88',
  warning: '#FFAA00',
  error: '#FF5555',
  success: '#00FF88',
  info: '#00AAFF',
  input: '#333333',
  inputBorder: '#555555',
};

// ============================================================================
// Props
// ============================================================================

interface FlowTUIProps {
  flow: UseFlowReturn;
}

// ============================================================================
// Main Component
// ============================================================================

export function FlowTUI({ flow }: FlowTUIProps) {
  const { flow: state, isOpen } = flow;

  if (!isOpen) return null;

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
    >
      {/* Backdrop - just a dark background */}
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        backgroundColor="#1a1a1a"
      />
      {/* Modal */}
      {renderModal(state, flow)}
    </box>
  );
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
        <Modal title={state.title} width={50}>
          <text fg={getVariantColor(state.variant)} marginBottom={1}>
            {state.message}
          </text>
          <text fg={COLORS.textDim} height={1}>
            Press Enter to close
          </text>
        </Modal>
      );

    case 'loading':
      return (
        <Modal title={state.title} width={40}>
          <text fg={COLORS.warning} marginBottom={1}>
            ⏳ {state.message}
          </text>
        </Modal>
      );

    case 'help':
      return (
        <Modal title="Keyboard Shortcuts" width={50} height={state.shortcuts.length + 6}>
          <box flexDirection="column" flexGrow={1}>
            {state.shortcuts.map((shortcut, idx) => (
              <text key={idx} fg={COLORS.text} height={1}>
                <text fg={COLORS.selected}>{shortcut.key.padEnd(12)}</text>
                {shortcut.description}
              </text>
            ))}
          </box>
          <text fg={COLORS.textDim} height={1} marginTop={1}>
            Press Esc to close
          </text>
        </Modal>
      );

    case 'confirm':
      return (
        <Modal title={state.title} width={50}>
          <text fg={getVariantColor(state.variant)} marginBottom={1}>
            {state.message}
          </text>
          <box flexDirection="row" gap={2} marginTop={1}>
            <text fg={COLORS.success}>[y] {state.confirmLabel || 'Yes'}</text>
            <text fg={COLORS.error}>[n] {state.cancelLabel || 'No'}</text>
          </box>
        </Modal>
      );

    case 'confirm-typed':
      return (
        <Modal title={state.title} width={60}>
          <text fg={COLORS.warning} marginBottom={1}>
            {state.message}
          </text>
          {state.warning && (
            <text fg={COLORS.error} marginBottom={1}>
              ⚠️ {state.warning}
            </text>
          )}
          <text fg={COLORS.textDim} marginBottom={1}>
            Type "{state.confirmText}" to confirm:
          </text>
          <box
            border
            borderStyle="single"
            borderColor={state.inputValue === state.confirmText ? COLORS.success : COLORS.inputBorder}
            padding={1}
          >
            <text fg={COLORS.text}>{state.inputValue || ' '}</text>
          </box>
          <text fg={COLORS.textDim} height={1} marginTop={1}>
            [Enter] Confirm  [Esc] Cancel
          </text>
        </Modal>
      );

    case 'input':
      return (
        <Modal title={state.title} width={60}>
          <text fg={COLORS.text} marginBottom={1}>
            {state.label}
          </text>
          <box
            border
            borderStyle="single"
            borderColor={COLORS.borderFocused}
            padding={1}
          >
            <text fg={state.inputValue ? COLORS.text : COLORS.textDim}>
              {state.inputValue || state.placeholder || ' '}
            </text>
          </box>
          {state.validation && state.inputValue && (() => {
            const error = state.validation(state.inputValue);
            return error ? (
              <text fg={COLORS.error} marginTop={1}>{error}</text>
            ) : null;
          })()}
          <text fg={COLORS.textDim} height={1} marginTop={1}>
            [Enter] Submit  [Esc] Cancel
          </text>
        </Modal>
      );

    case 'select':
      return (
        <Modal title={state.title} width={60} height={state.options.length + 8}>
          <box flexDirection="column" flexGrow={1} overflow="scroll">
            {state.options.map((option, idx) => {
              const isSelected = idx === state.selectedIndex;
              return (
                <box key={idx} flexDirection="column" marginBottom={1}>
                  <text fg={isSelected ? COLORS.selected : COLORS.text} height={1}>
                    {isSelected ? '▶ ' : '  '}{option.label}
                  </text>
                  {option.description && (
                    <text fg={COLORS.textDim} height={1} paddingLeft={4}>
                      {option.description}
                    </text>
                  )}
                </box>
              );
            })}
          </box>
          <text fg={COLORS.textDim} height={1} marginTop={1}>
            [↑↓] Navigate  [Enter] Select  [Esc] Cancel
          </text>
        </Modal>
      );

    case 'wizard':
      const step = state.steps[state.currentStep];
      if (!step) return null;

      return (
        <Modal
          title={`${state.title} (${state.currentStep + 1}/${state.steps.length})`}
          width={70}
        >
          <text fg={COLORS.title} marginBottom={1}>
            {step.title}
          </text>
          {step.description && (
            <text fg={COLORS.textDim} marginBottom={1}>
              {step.description}
            </text>
          )}

          {/* Render step content based on type */}
          {step.type === 'info' && (
            <text fg={COLORS.text}>Press Enter to continue</text>
          )}

          {(step.type === 'input' || step.type === 'secret') && (
            <box
              border
              borderStyle="single"
              borderColor={COLORS.borderFocused}
              padding={1}
              marginTop={1}
            >
              <text fg={state.inputValue ? COLORS.text : COLORS.textDim}>
                {step.type === 'secret'
                  ? '•'.repeat(state.inputValue.length) || step.placeholder || ' '
                  : state.inputValue || step.placeholder || ' '
                }
              </text>
            </box>
          )}

          {step.type === 'confirm' && (
            <box flexDirection="column" marginTop={1}>
              {step.checkStatus === 'checking' && (
                <text fg={COLORS.warning}>⏳ Checking...</text>
              )}
              {step.checkStatus === 'found' && (
                <text fg={COLORS.success}>✅ Found</text>
              )}
              {step.checkStatus === 'missing' && (
                <box flexDirection="column">
                  <text fg={COLORS.error}>❌ Not found</text>
                  {step.installUrl && (
                    <text fg={COLORS.info} marginTop={1}>
                      Install: {step.installUrl}
                    </text>
                  )}
                </box>
              )}
            </box>
          )}

          {step.type === 'select' && step.options && (
            <box flexDirection="column" marginTop={1}>
              {step.options.map((option, idx) => (
                <text key={idx} fg={COLORS.text} height={1}>
                  • {option.label}
                </text>
              ))}
            </box>
          )}

          <text fg={COLORS.textDim} height={1} marginTop={2}>
            {state.currentStep > 0 ? '[←] Back  ' : ''}
            [Enter] {state.currentStep === state.steps.length - 1 ? 'Finish' : 'Next'}
            {'  [Esc] Cancel'}
          </text>
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
  width?: number;
  height?: number;
}

function Modal({ title, children, width = 50, height }: ModalProps) {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="double"
      borderColor={COLORS.borderFocused}
      backgroundColor="#1a1a1a"
      width={width}
      height={height}
      padding={1}
      zIndex={100}
    >
      <text fg={COLORS.title} height={1} marginBottom={1}>
        {' '}{title}{' '}
      </text>
      <box flexDirection="column" flexGrow={1}>
        {children}
      </box>
    </box>
  );
}

// ============================================================================
// Utilities
// ============================================================================

function getVariantColor(variant?: 'info' | 'success' | 'warning' | 'error' | 'danger'): string {
  switch (variant) {
    case 'success': return COLORS.success;
    case 'warning': return COLORS.warning;
    case 'error':
    case 'danger': return COLORS.error;
    case 'info':
    default: return COLORS.text;
  }
}
