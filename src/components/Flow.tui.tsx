/**
 * Flow - TUI Modal Renderers
 *
 * OpenTUI components for rendering modals/dialogs.
 */

import { useMemo, useRef } from 'react';
import { useKeyboard } from '@opentui/react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { toast } from '@opentui-ui/toast';
import { copyToClipboard } from '../utils/clipboard.js';
import {
  getVisibleSelectOptions,
  type UseFlowReturn,
  type FlowState,
} from './Flow.js';

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
      {
        const lineCount = getLineCount(state.message);
        const modalHeight = Math.min(getModalMaxHeight(), Math.max(8, lineCount + 7));
      return (
        <Modal title={state.title} width={60} height={modalHeight}>
          <ScrollableMessageBody
            active={true}
            message={state.message}
            color={getVariantColor(state.variant)}
            hint="[Enter] Close  [c] Copy  [↑/↓] Scroll"
          />
        </Modal>
      );
      }

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
      {
        const lineCount = getLineCount(state.message);
        const modalHeight = Math.min(getModalMaxHeight(), Math.max(10, lineCount + 9));
      return (
        <Modal title={state.title} width={60} height={modalHeight}>
          <ScrollableMessageBody
            active={true}
            message={state.message}
            color={getVariantColor(state.variant)}
            hint="[y] Confirm  [n] Cancel  [c] Copy  [↑/↓] Scroll"
          />
          <box flexDirection="row" gap={2} marginTop={1}>
            <text fg={COLORS.success}>[y] {state.confirmLabel || 'Yes'}</text>
            <text fg={COLORS.error}>[n] {state.cancelLabel || 'No'}</text>
          </box>
        </Modal>
      );
      }

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
      {
        const maxWidth = getModalMaxWidth();
        const preferredWidth = state.searchable ? 96 : 72;
        const desiredMinWidth = state.searchable ? 56 : 48;
        const safeMinWidth = Math.min(desiredMinWidth, maxWidth);
        const modalWidth = Math.max(safeMinWidth, Math.min(maxWidth, preferredWidth));
        const filteredOptions = getVisibleSelectOptions(state);
        const selectedIndex = filteredOptions.length === 0
          ? 0
          : Math.max(0, Math.min(state.selectedIndex, filteredOptions.length - 1));
        const maxHeight = getModalMaxHeight();
        const chromeHeight = state.searchable ? 11 : 8;
        const maxVisibleOptions = Math.max(1, Math.floor((maxHeight - chromeHeight) / 3));
        const visibleCount = Math.max(1, Math.min(filteredOptions.length || 1, maxVisibleOptions));
        const modalHeight = Math.min(maxHeight, chromeHeight + (visibleCount * 3));
        const windowStart = getOptionWindowStart(selectedIndex, visibleCount, filteredOptions.length);
        const visibleOptions = filteredOptions.slice(windowStart, windowStart + visibleCount);
        const maxContentWidth = Math.max(1, modalWidth - 6);
        const maxLabelWidth = Math.max(1, Math.min(maxContentWidth, modalWidth - 8));
        const maxDescriptionWidth = Math.max(1, Math.min(maxContentWidth, modalWidth - 10));
        const searchLineWidth = maxContentWidth;
        const searchQuery = state.searchQuery ?? '';
        const searchDisplay = fitInputText(searchQuery, searchLineWidth);

        return (
          <Modal title={state.title} width={modalWidth} height={modalHeight}>
            {state.searchable && (
              <>
                <text fg={COLORS.textDim} marginBottom={1}>Search</text>
                <box
                  border
                  borderStyle="single"
                  borderColor={COLORS.inputBorder}
                  paddingLeft={1}
                  paddingRight={1}
                  marginBottom={1}
                >
                  <text fg={COLORS.text}>{searchDisplay || ' '}</text>
                </box>
              </>
            )}

            <box flexDirection="column" flexGrow={1} overflow="hidden">
              {filteredOptions.length === 0 ? (
                <>
                  <text fg={COLORS.warning}>
                    {truncateLine(`No matches for "${searchQuery}"`, maxContentWidth) || 'No matches'}
                  </text>
                  <text fg={COLORS.textDim} marginTop={1}>
                    {truncateLine('Try a different search query.', maxContentWidth) || 'Try another query.'}
                  </text>
                </>
              ) : (
                visibleOptions.map((entry, offset) => {
                  const visibleIndex = windowStart + offset;
                  const isSelected = visibleIndex === selectedIndex;
                  const baseLabelPrefix = isSelected ? '▶ ' : '  ';
                  const labelPrefix = baseLabelPrefix.slice(0, Math.max(0, maxLabelWidth));
                  const label = truncateLine(
                    entry.option.label,
                    Math.max(0, maxLabelWidth - labelPrefix.length)
                  );
                  const descriptionIndent = '    '.slice(0, Math.max(0, maxDescriptionWidth));
                  const description = entry.option.description
                    ? truncateLine(
                        entry.option.description,
                        Math.max(0, maxDescriptionWidth - descriptionIndent.length)
                      )
                    : null;

                  return (
                    <box key={entry.index} flexDirection="column">
                      <text fg={isSelected ? COLORS.selected : COLORS.text} height={1}>
                        {labelPrefix}{label}
                      </text>
                      <text fg={COLORS.textDim} height={1}>
                        {description ? `${descriptionIndent}${description}` : ' '}
                      </text>
                      <text fg={COLORS.textDim} height={1}> </text>
                    </box>
                  );
                })
              )}
            </box>

            <text fg={COLORS.textDim} height={1} marginTop={1}>
              {state.searchable
                ? '[Type] Search  [Backspace] Delete  [↑/↓] Navigate  [Enter] Select  [Esc] Cancel'
                : '[↑/↓ or j/k] Navigate  [Enter] Select  [Esc] Cancel'}
            </text>
          </Modal>
        );
      }

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

interface ScrollableMessageBodyProps {
  active: boolean;
  message: string;
  color: string;
  hint: string;
}

function ScrollableMessageBody({ active, message, color, hint }: ScrollableMessageBodyProps) {
  const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
  const lines = useMemo(() => {
    const parts = message.split(/\r?\n/);
    return parts.length > 0 ? parts : [''];
  }, [message]);

  useKeyboard(async (key) => {
    if (!active) {
      return;
    }

    const scrollBox = scrollBoxRef.current;
    if (!scrollBox) {
      return;
    }

    if (key.name === 'up' || key.raw === 'k') {
      scrollBox.scrollBy(-1);
      return;
    }

    if (key.name === 'down' || key.raw === 'j') {
      scrollBox.scrollBy(1);
      return;
    }

    if (key.name === 'pageup') {
      scrollBox.scrollBy(-1, 'viewport');
      return;
    }

    if (key.name === 'pagedown') {
      scrollBox.scrollBy(1, 'viewport');
      return;
    }

    if (key.name === 'c' || key.raw === 'c') {
      try {
        await copyToClipboard(message);
        toast.success('Copied to clipboard');
      } catch {
        toast.error('Failed to copy to clipboard');
      }
    }
  });

  return (
    <>
      <scrollbox
        ref={(el: ScrollBoxRenderable | null) => {
          scrollBoxRef.current = el;
        }}
        flexGrow={1}
        overflow="scroll"
      >
        <box flexDirection="column" paddingRight={1}>
          {lines.map((line, idx) => (
            <text key={idx} fg={color}>
              {line.length > 0 ? line : ' '}
            </text>
          ))}
        </box>
      </scrollbox>
      <text fg={COLORS.textDim} height={1} marginTop={1}>
        {hint}
      </text>
    </>
  );
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

function getLineCount(text: string): number {
  if (!text) {
    return 1;
  }

  return text.split(/\r?\n/).length;
}

function getModalMaxHeight(): number {
  let rows = process.stdout.rows || 0;
  if (rows <= 0) {
    const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
    if (Array.isArray(size) && size.length >= 2) {
      rows = size[1];
    }
  }

  const terminalRows = rows > 0 ? rows : 24;
  return Math.max(8, terminalRows - 4);
}

function getModalMaxWidth(): number {
  let columns = process.stdout.columns || 0;
  if (columns <= 0) {
    const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
    if (Array.isArray(size) && size.length >= 1) {
      columns = size[0];
    }
  }

  const terminalColumns = columns > 0 ? columns : 80;
  return Math.max(1, terminalColumns - 4);
}

function getOptionWindowStart(
  selectedIndex: number,
  visibleCount: number,
  totalCount: number
): number {
  if (totalCount <= visibleCount) {
    return 0;
  }

  const maxStart = Math.max(0, totalCount - visibleCount);
  const centeredStart = selectedIndex - Math.floor(visibleCount / 2);
  return Math.max(0, Math.min(centeredStart, maxStart));
}

function truncateLine(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (maxLength <= 0) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  if (maxLength <= 3) {
    return normalized.slice(0, maxLength);
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function fitInputText(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    return '';
  }

  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 3) {
    return text.slice(-maxLength);
  }

  return `...${text.slice(-(maxLength - 3))}`;
}
