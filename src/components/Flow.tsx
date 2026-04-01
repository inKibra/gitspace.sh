/**
 * Flow - Shared Modal/Dialog System
 *
 * Manages modal state and multi-step flows for both TUI and Web.
 * Provides a unified way to handle confirmations, selections, and wizards.
 */

import { useState, useCallback, useMemo } from 'react';

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
  onCancel?: () => void | Promise<void>;
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
  onCancel?: () => void | Promise<void>;
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
  onCancel?: () => void | Promise<void>;
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
  onCancel?: () => void | Promise<void>;
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
  onCancel?: () => void | Promise<void>;
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
  handleConfirm: (selectedIndexOverride?: number) => Promise<void>;
  handleCancel: () => Promise<void>;
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

function getWizardStepInputValue(
  step: FlowWizardStep | undefined,
  collectedValues: Record<string, string>,
): string {
  if (!step) return '';
  const collectedValue = collectedValues[step.id];
  if (typeof collectedValue === 'string') return collectedValue;
  if (typeof step.defaultValue === 'string') return step.defaultValue;
  if (step.type === 'select') return step.options?.[0]?.value ?? '';
  return '';
}

function persistWizardStepValue(
  flow: FlowWizard,
  collectedValues: Record<string, string>,
): Record<string, string> {
  const currentStep = flow.steps[flow.currentStep];
  if (!currentStep) return collectedValues;
  if (currentStep.type !== 'input' && currentStep.type !== 'secret' && currentStep.type !== 'select') {
    return collectedValues;
  }
  return {
    ...collectedValues,
    [currentStep.id]: flow.inputValue,
  };
}



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
    const collectedValues: Record<string, string> = {};
    setFlow({
      type: 'wizard',
      ...opts,
      currentStep: 0,
      collectedValues,
      inputValue: getWizardStepInputValue(firstStep, collectedValues),
    });
  }, []);

  // Handle confirm action
  const handleConfirm = useCallback(async (selectedIndexOverride?: number) => {
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
          if (error) return;
        }
        await flow.onSubmit(flow.inputValue);
        closeIfUnchanged();
      } else if (flow.type === 'select') {
        const visibleOptions = getVisibleSelectOptions(flow);
        const resolvedIndex = selectedIndexOverride ?? flow.selectedIndex;
        const entry = visibleOptions.find(({ index }) => index === resolvedIndex)
          ?? visibleOptions[0];
        if (entry) {
          await flow.onSelect(entry.option.value, entry.index);
          closeIfUnchanged();
        }
      } else if (flow.type === 'wizard') {
        const currentStep = flow.steps[flow.currentStep];
        const newValues = persistWizardStepValue(flow, flow.collectedValues);

        if (currentStep && (currentStep.type === 'input' || currentStep.type === 'secret')) {
          if (currentStep.validation) {
            const error = currentStep.validation(flow.inputValue);
            if (error) return;
          }
        }

        if (flow.currentStep === flow.steps.length - 1) {
          await flow.onComplete(newValues);
          closeIfUnchanged();
        } else {
          const nextStep = flow.steps[flow.currentStep + 1];
          setFlow({
            ...flow,
            currentStep: flow.currentStep + 1,
            collectedValues: newValues,
            inputValue: getWizardStepInputValue(nextStep, newValues),
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
  const handleCancel = useCallback(async () => {
    try {
      if (flow.type === 'confirm' && flow.onCancel) {
        await flow.onCancel();
      } else if (flow.type === 'confirm-typed' && flow.onCancel) {
        await flow.onCancel();
      } else if (flow.type === 'input' && flow.onCancel) {
        await flow.onCancel();
      } else if (flow.type === 'select' && flow.onCancel) {
        await flow.onCancel();
      } else if (flow.type === 'wizard' && flow.onCancel) {
        await flow.onCancel();
      }
      close();
    } catch (error) {
      if (onError && error instanceof Error) {
        onError(error);
      }
    }
  }, [flow, close, onError]);

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
      const visibleOptions = getVisibleSelectOptions(flow);
      const hasVisibleIndex = visibleOptions.some((entry) => entry.index === index);
      const fallbackIndex = visibleOptions[0]?.index ?? 0;
      setFlow({
        ...flow,
        selectedIndex: hasVisibleIndex ? index : fallbackIndex,
      });
      return;
    }

    if (flow.type === 'wizard') {
      const step = flow.steps[flow.currentStep];
      if (step?.type !== 'select' || !step.options?.length) {
        return;
      }
      const option = step.options[index] ?? step.options[0];
      if (!option) return;
      setFlow({
        ...flow,
        inputValue: option.value,
      });
    }
  }, [flow]);

  const updateSelectQuery = useCallback((value: string) => {
    if (flow.type !== 'select' || !flow.searchable) {
      return;
    }

    const nextVisibleOptions = filterVisibleSelectOptions(
      flow.options.map((option, index) => ({ option, index })),
      value
    );
    const nextSelectedIndex = nextVisibleOptions.find(({ index }) => index === flow.selectedIndex)?.index
      ?? nextVisibleOptions[0]?.index
      ?? 0;

    setFlow({
      ...flow,
      searchQuery: value,
      selectedIndex: nextSelectedIndex,
    });
  }, [flow]);

  // Move selection up
  const moveUp = useCallback(() => {
    if (flow.type === 'select') {
      const visibleOptions = getVisibleSelectOptions(flow);
      if (visibleOptions.length === 0) {
        return;
      }

      const currentVisiblePosition = visibleOptions.findIndex(({ index }) => index === flow.selectedIndex);
      const nextVisiblePosition = currentVisiblePosition <= 0 ? 0 : currentVisiblePosition - 1;
      setFlow({ ...flow, selectedIndex: visibleOptions[nextVisiblePosition]?.index ?? flow.selectedIndex });
      return;
    }

    if (flow.type === 'wizard') {
      const step = flow.steps[flow.currentStep];
      if (step?.type !== 'select' || !step.options?.length) {
        return;
      }
      const currentIndex = Math.max(0, step.options.findIndex((option) => option.value === flow.inputValue));
      const nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
      setFlow({ ...flow, inputValue: step.options[nextIndex]?.value ?? flow.inputValue });
    }
  }, [flow]);

  // Move selection down
  const moveDown = useCallback(() => {
    if (flow.type === 'select') {
      const visibleOptions = getVisibleSelectOptions(flow);
      if (visibleOptions.length === 0) {
        return;
      }

      const currentVisiblePosition = visibleOptions.findIndex(({ index }) => index === flow.selectedIndex);
      const nextVisiblePosition = currentVisiblePosition < 0
        ? 0
        : Math.min(visibleOptions.length - 1, currentVisiblePosition + 1);
      setFlow({ ...flow, selectedIndex: visibleOptions[nextVisiblePosition]?.index ?? flow.selectedIndex });
      return;
    }

    if (flow.type === 'wizard') {
      const step = flow.steps[flow.currentStep];
      if (step?.type !== 'select' || !step.options?.length) {
        return;
      }
      const currentIndex = step.options.findIndex((option) => option.value === flow.inputValue);
      const nextIndex = currentIndex < 0
        ? 0
        : Math.min(step.options.length - 1, currentIndex + 1);
      setFlow({ ...flow, inputValue: step.options[nextIndex]?.value ?? flow.inputValue });
    }
  }, [flow]);

  // Wizard navigation
  const nextStep = useCallback(() => {
    if (flow.type === 'wizard' && flow.currentStep < flow.steps.length - 1) {
      const nextStepData = flow.steps[flow.currentStep + 1];
      const collectedValues = persistWizardStepValue(flow, flow.collectedValues);
      setFlow({
        ...flow,
        currentStep: flow.currentStep + 1,
        collectedValues,
        inputValue: getWizardStepInputValue(nextStepData, collectedValues),
      });
    }
  }, [flow]);

  const prevStep = useCallback(() => {
    if (flow.type === 'wizard' && flow.currentStep > 0) {
      const prevStepData = flow.steps[flow.currentStep - 1];
      const collectedValues = persistWizardStepValue(flow, flow.collectedValues);
      setFlow({
        ...flow,
        currentStep: flow.currentStep - 1,
        collectedValues,
        inputValue: getWizardStepInputValue(prevStepData, collectedValues),
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

  return useMemo(() => ({
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
  }), [
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
  ]);
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

  return filterVisibleSelectOptions(entries, query);
}

function filterVisibleSelectOptions(
  entries: Array<{ option: FlowSelect['options'][number]; index: number }>,
  query: string | undefined
): Array<{ option: FlowSelect['options'][number]; index: number }> {
  const normalizedQuery = query?.trim().toLowerCase() ?? '';

  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter(({ option }) => {
    const label = option.label.toLowerCase();
    const description = option.description?.toLowerCase() ?? '';
    return label.includes(normalizedQuery) || description.includes(normalizedQuery);
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
    { key: 'b', description: 'Edit bundle config' },
    { key: 'd', description: 'Delete selected' },
    { key: 'i', description: 'Open inbox' },
    { key: 'r', description: 'Refresh' },
    { key: '?', description: 'Show help' },
    { key: 'q', description: 'Quit' },
  ];
}
