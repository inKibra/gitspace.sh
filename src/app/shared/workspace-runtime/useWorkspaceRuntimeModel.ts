import { useMemo } from 'react';
import type { MultiMachineState } from '../../../machine/multi/types.js';
import { deriveWorkspaceRuntimeModel } from './derive.js';

export function useWorkspaceRuntimeModel(state: MultiMachineState) {
  return useMemo(() => deriveWorkspaceRuntimeModel(state), [state]);
}
