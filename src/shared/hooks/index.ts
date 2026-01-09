/**
 * Hook exports
 */

export type {
  NavigationState,
  NavigationAction,
} from './useNavigation.js';

export {
  createInitialNavigationState,
  navigationReducer,
  getCurrentMachineId,
  getCurrentProjectName,
  canGoBack,
} from './useNavigation.js';
