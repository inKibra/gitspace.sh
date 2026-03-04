/**
 * Flow - Shared Modal/Dialog System
 *
 * Manages modal state and multi-step flows for both TUI and Web.
 * Provides a unified way to handle confirmations, selections, and wizards.
 */

import { useState, useCallback } from 'react';

// ============================================================================
// Types - Base Modal Types
// ============================================================================

/** No modal open */
export interface FlowNone {
  type: 'none';
}

/** Simple message modal */
export interface FlowMessage {
  type: 'message';
  title: string;
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
}

/** Loading indicator modal */
export interface FlowLoading {
  type: 'loading';
  title: string;
  message: string;
}

/** Help/keyboard shortcuts modal */
export interface FlowHelp {
  type: 'help';
  shortcuts: Array<{ key: string; description: string }>;
}

/** Yes/No confirmation modal */
export interface FlowConfirm {
  type: 'confirm';
  title: string;
  message: string;
  variant?: 'danger' | 'warning' | 'info';
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
}

/** Type-to-confirm modal (for dangerous actions) */
export interface FlowConfirmTyped {
  type: 'confirm-typed';
  title: string;
  message: string;
  confirmText: string; // Text user must type to confirm
  warning?: string;
  inputValue: string;
  onConfirm: () => void | Promise<void>;
  onCancel?: () => void;
}

/** Text input modal */
export interface FlowInput {
  type: 'input';
  title: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  inputValue: string;
  validation?: (value: string) => string | null; // Returns error message or null
  onSubmit: (value: string) => void | Promise<void>;
  onCancel?: () => void;
}

/** Select from list modal */
export interface FlowSelect<T = unknown> {
  type: 'select';
  title: string;
  options: Array<{ label: string; description?: string; value: T }>;
  selectedIndex: number;
  searchable?: boolean;
  searchQuery?: string;
  onSelect: (value: T, index: number) => void | Promise<void>;
  onCancel?: () => void;
}

/** Multi-step wizard flow */
export interface FlowWizardStep {
  id: string;
  title: string;
  type: 'info' | 'input' | 'secret' | 'confirm' | 'select';
  description?: string;
  // For input/secret steps
  placeholder?: string;
  defaultValue?: string;
  validation?: (value: string) => string | null;
  // For confirm steps
  checkCommand?: string; // Command to check if requirement is met
  checkStatus?: 'checking' | 'found' | 'missing';
  installUrl?: string;
  // For select steps
  options?: Array<{ label: string; value: string }>;
}

export interface FlowWizard {
  type: 'wizard';
  title: string;
  steps: FlowWizardStep[];
  currentStep: number;
  collectedValues: Record<string, string>;
  inputValue: string;
  onComplete: (values: Record<string, string>) => void | Promise<void>;
  onCancel?: () => void;
}

// ============================================================================
// Combined Flow State Type
// ============================================================================

export type FlowState =
  | FlowNone
  | FlowMessage
  | FlowLoading
  | FlowHelp
  | FlowConfirm
  | FlowConfirmTyped
  | FlowInput
  | FlowSelect
  | FlowWizard;

// ============================================================================
// Flow Hook Props and Return
// ============================================================================

export interface UseFlowProps {
  onError?: (error: Error) => void;
}

export interface UseFlowReturn {
  // Current state
  flow: FlowState;
  isOpen: boolean;

  // Open modals
  showMessage: (opts: Omit<FlowMessage, 'type'>) => void;
  showLoading: (opts: Omit<FlowLoading, 'type'>) => void;
  showHelp: (shortcuts: FlowHelp['shortcuts']) => void;
  showConfirm: (opts: Omit<FlowConfirm, 'type'>) => void;
  showConfirmTyped: (opts: Omit<FlowConfirmTyped, 'type' | 'inputValue'>) => void;
  showInput: (opts: Omit<FlowInput, 'type' | 'inputValue'>) => void;
  showSelect: <T>(opts: Omit<FlowSelect<T>, 'type' | 'selectedIndex'>) => void;
  showWizard: (opts: Omit<FlowWizard, 'type' | 'currentStep' | 'collectedValues' | 'inputValue'>) => void;

  // Close/dismiss
  close: () => void;

  // Interaction handlers (for keyboard/click)
  handleConfirm: () => Promise<void>;
  handleCancel: () => void;
  handleInput: (value: string) => void;
  handleSelect: (index: number) => void;
  updateSelectQuery: (value: string) => void;
  moveUp: () => void;
  moveDown: () => void;
  nextStep: () => void;
  prevStep: () => void;

  // Wizard helpers
  updateCheckStatus: (status: 'checking' | 'found' | 'missing') => void;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useFlow(props: UseFlowProps = {}): UseFlowReturn {
  const { onError } = props;

  const [flow, setFlow] = useState<FlowState>({ type: 'none' });

  const isOpen = flow.type !== 'none';

  // Close modal
  const close = useCallback(() => {
    setFlow({ type: 'none' });
  }, []);

  // Show message
  const showMessage = useCallback((opts: Omit<FlowMessage, 'type'>) => {
    setFlow({ type: 'message', ...opts });
  }, []);

  // Show loading
  const showLoading = useCallback((opts: Omit<FlowLoading, 'type'>) => {
    setFlow({ type: 'loading', ...opts });
  }, []);

  // Show help
  const showHelp = useCallback((shortcuts: FlowHelp['shortcuts']) => {
    setFlow({ type: 'help', shortcuts });
  }, []);

  // Show confirm
  const showConfirm = useCallback((opts: Omit<FlowConfirm, 'type'>) => {
    setFlow({ type: 'confirm', ...opts });
  }, []);

  // Show typed confirm
  const showConfirmTyped = useCallback((opts: Omit<FlowConfirmTyped, 'type' | 'inputValue'>) => {
    setFlow({ type: 'confirm-typed', ...opts, inputValue: '' });
  }, []);

  // Show input
  const showInput = useCallback((opts: Omit<FlowInput, 'type' | 'inputValue'>) => {
    setFlow({ type: 'input', ...opts, inputValue: opts.defaultValue || '' });
  }, []);

  // Show select
  const showSelect = useCallback(<T,>(opts: Omit<FlowSelect<T>, 'type' | 'selectedIndex'>) => {
    setFlow({ type: 'select', ...opts, selectedIndex: 0, searchQuery: '' } as FlowSelect);
  }, []);

  // Show wizard
  const showWizard = useCallback((opts: Omit<FlowWizard, 'type' | 'currentStep' | 'collectedValues' | 'inputValue'>) => {
    const firstStep = opts.steps[0];
    setFlow({
      type: 'wizard',
      ...opts,
      currentStep: 0,
      collectedValues: {},
      inputValue: firstStep?.defaultValue || '',
    });
  }, []);

  // Handle confirm action
  const handleConfirm = useCallback(async () => {
    const flowAtConfirm = flow;
    const closeIfUnchanged = () => {
      setFlow((current) => (current === flowAtConfirm ? { type: 'none' } : current));
    };

    try {
      if (flow.type === 'confirm') {
        await flow.onConfirm();
        closeIfUnchanged();
      } else if (flow.type === 'confirm-typed') {
        if (flow.inputValue === flow.confirmText) {
          await flow.onConfirm();
          closeIfUnchanged();
        }
      } else if (flow.type === 'input') {
        if (flow.validation) {
          const error = flow.validation(flow.inputValue);
          if (error) return; // Don't close if validation fails
        }
        await flow.onSubmit(flow.inputValue);
        closeIfUnchanged();
      } else if (flow.type === 'select') {
        const visibleOptions = getVisibleSelectOptions(flow);
        const entry = visibleOptions[flow.selectedIndex];
        if (entry) {
          await flow.onSelect(entry.option.value, entry.index);
          closeIfUnchanged();
        }
      } else if (flow.type === 'wizard') {
        // Advance wizard or complete
        const currentStep = flow.steps[flow.currentStep];
        const newValues = { ...flow.collectedValues };

        if (currentStep && (currentStep.type === 'input' || currentStep.type === 'secret')) {
          if (currentStep.validation) {
            const error = currentStep.validation(flow.inputValue);
            if (error) return;
          }
          newValues[currentStep.id] = flow.inputValue;
        }

        if (flow.currentStep === flow.steps.length - 1) {
          // Last step - complete
          await flow.onComplete(newValues);
          closeIfUnchanged();
        } else {
          // Move to next step
          const nextStep = flow.steps[flow.currentStep + 1];
          setFlow({
            ...flow,
            currentStep: flow.currentStep + 1,
            collectedValues: newValues,
            inputValue: nextStep?.defaultValue || '',
          });
        }
      } else if (flow.type === 'message' || flow.type === 'help') {
        closeIfUnchanged();
      }
    } catch (error) {
      if (onError && error instanceof Error) {
        onError(error);
      }
    }
  }, [flow, onError]);

  // Handle cancel action
  const handleCancel = useCallback(() => {
    if (flow.type === 'confirm' && flow.onCancel) {
      flow.onCancel();
    } else if (flow.type === 'confirm-typed' && flow.onCancel) {
      flow.onCancel();
    } else if (flow.type === 'input' && flow.onCancel) {
      flow.onCancel();
    } else if (flow.type === 'select' && flow.onCancel) {
      flow.onCancel();
    } else if (flow.type === 'wizard' && flow.onCancel) {
      flow.onCancel();
    }
    close();
  }, [flow, close]);

  // Handle input change
  const handleInput = useCallback((value: string) => {
    if (flow.type === 'input') {
      setFlow({ ...flow, inputValue: value });
    } else if (flow.type === 'confirm-typed') {
      setFlow({ ...flow, inputValue: value });
    } else if (flow.type === 'wizard') {
      setFlow({ ...flow, inputValue: value });
    }
  }, [flow]);

  // Handle selection change
  const handleSelect = useCallback((index: number) => {
    if (flow.type === 'select') {
      const visibleCount = getVisibleSelectOptions(flow).length;
      const clampedIndex = visibleCount === 0
        ? 0
        : Math.max(0, Math.min(index, visibleCount - 1));
      setFlow({ ...flow, selectedIndex: clampedIndex });
    }
  }, [flow]);

  const updateSelectQuery = useCallback((value: string) => {
    if (flow.type !== 'select' || !flow.searchable) {
      return;
    }

    setFlow({
      ...flow,
      searchQuery: value,
      selectedIndex: 0,
    });
  }, [flow]);

  // Move selection up
  const moveUp = useCallback(() => {
    if (flow.type === 'select') {
      const visibleCount = getVisibleSelectOptions(flow).length;
      if (visibleCount === 0) {
        return;
      }
      setFlow({ ...flow, selectedIndex: Math.max(0, flow.selectedIndex - 1) });
    }
  }, [flow]);

  // Move selection down
  const moveDown = useCallback(() => {
    if (flow.type === 'select') {
      const visibleCount = getVisibleSelectOptions(flow).length;
      if (visibleCount === 0) {
        return;
      }
      setFlow({ ...flow, selectedIndex: Math.min(visibleCount - 1, flow.selectedIndex + 1) });
    }
  }, [flow]);

  // Wizard navigation
  const nextStep = useCallback(() => {
    if (flow.type === 'wizard' && flow.currentStep < flow.steps.length - 1) {
      const nextStepData = flow.steps[flow.currentStep + 1];
      setFlow({
        ...flow,
        currentStep: flow.currentStep + 1,
        inputValue: nextStepData?.defaultValue || '',
      });
    }
  }, [flow]);

  const prevStep = useCallback(() => {
    if (flow.type === 'wizard' && flow.currentStep > 0) {
      const prevStepData = flow.steps[flow.currentStep - 1];
      setFlow({
        ...flow,
        currentStep: flow.currentStep - 1,
        inputValue: prevStepData?.defaultValue || '',
      });
    }
  }, [flow]);

  // Update wizard check status
  const updateCheckStatus = useCallback((status: 'checking' | 'found' | 'missing') => {
    if (flow.type === 'wizard') {
      const updatedSteps = [...flow.steps];
      const currentStep = updatedSteps[flow.currentStep];
      if (currentStep && currentStep.type === 'confirm') {
        updatedSteps[flow.currentStep] = { ...currentStep, checkStatus: status };
        setFlow({ ...flow, steps: updatedSteps });
      }
    }
  }, [flow]);

  return {
    flow,
    isOpen,
    showMessage,
    showLoading,
    showHelp,
    showConfirm,
    showConfirmTyped,
    showInput,
    showSelect,
    showWizard,
    close,
    handleConfirm,
    handleCancel,
    handleInput,
    handleSelect,
    updateSelectQuery,
    moveUp,
    moveDown,
    nextStep,
    prevStep,
    updateCheckStatus,
  };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for FlowInput state
 */
export function isFlowInput(flow: FlowState): flow is FlowInput {
  return flow.type === 'input';
}

/**
 * Type guard for FlowConfirmTyped state
 */
export function isFlowConfirmTyped(flow: FlowState): flow is FlowConfirmTyped {
  return flow.type === 'confirm-typed';
}

/**
 * Type guard for FlowWizard state
 */
export function isFlowWizard(flow: FlowState): flow is FlowWizard {
  return flow.type === 'wizard';
}

/**
 * Type guard for any flow state with inputValue
 */
export function hasInputValue(flow: FlowState): flow is FlowInput | FlowConfirmTyped | FlowWizard {
  return flow.type === 'input' || flow.type === 'confirm-typed' || flow.type === 'wizard';
}

export function getVisibleSelectOptions(
  flow: FlowSelect
): Array<{ option: FlowSelect['options'][number]; index: number }> {
  const entries = flow.options.map((option, index) => ({ option, index }));
  const query = flow.searchable ? flow.searchQuery?.trim().toLowerCase() : '';

  if (!query) {
    return entries;
  }

  return entries.filter(({ option }) => {
    const label = option.label.toLowerCase();
    const description = option.description?.toLowerCase() ?? '';
    return label.includes(query) || description.includes(query);
  });
}

// ============================================================================
// Utilities
// ============================================================================

/** Get keyboard shortcuts for common actions */
export function getDefaultShortcuts(): FlowHelp['shortcuts'] {
  return [
    { key: 'Enter', description: 'Select / Confirm' },
    { key: 'Esc', description: 'Cancel / Back' },
    { key: '↑/↓ or j/k', description: 'Navigate list' },
    { key: 'Tab', description: 'Switch panel' },
    { key: 'n', description: 'New project/workspace' },
    { key: 'd', description: 'Delete selected' },
    { key: 'i', description: 'Open inbox' },
    { key: 'r', description: 'Refresh' },
    { key: '?', description: 'Show help' },
    { key: 'q', description: 'Quit' },
  ];
}
