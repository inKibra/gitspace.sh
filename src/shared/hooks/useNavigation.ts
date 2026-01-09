/**
 * Navigation State Hook
 *
 * Manages navigation between screens (machines, projects, workspaces, sessions).
 * Platform-agnostic - works with both TUI and Web.
 */

import type { NavigationLocation, PanelFocus } from '../types.js';

/**
 * Navigation state
 */
export interface NavigationState {
  /** Current location in the app */
  location: NavigationLocation;
  /** Which panel has focus */
  focus: PanelFocus;
  /** History stack for back navigation */
  history: NavigationLocation[];
  /** Selected indices for each panel */
  selectedIndices: {
    machines: number;
    projects: number;
    workspaces: number;
  };
  /** Expanded items (e.g., workspaces showing sessions) */
  expanded: Set<string>;
}

/**
 * Navigation actions
 */
export type NavigationAction =
  | { type: 'NAVIGATE'; location: NavigationLocation }
  | { type: 'GO_BACK' }
  | { type: 'SET_FOCUS'; focus: PanelFocus }
  | { type: 'SWITCH_FOCUS' }
  | { type: 'SELECT_INDEX'; panel: 'machines' | 'projects' | 'workspaces'; index: number }
  | { type: 'MOVE_UP' }
  | { type: 'MOVE_DOWN' }
  | { type: 'TOGGLE_EXPANDED'; id: string }
  | { type: 'RESET' };

/**
 * Create initial navigation state
 */
export function createInitialNavigationState(
  startWithMachines: boolean = false
): NavigationState {
  return {
    location: startWithMachines
      ? { screen: 'machines' }
      : { screen: 'projects', machineId: 'local' },
    focus: startWithMachines ? 'machines' : 'projects',
    history: [],
    selectedIndices: {
      machines: 0,
      projects: 0,
      workspaces: 0,
    },
    expanded: new Set(),
  };
}

/**
 * Navigation reducer
 */
export function navigationReducer(
  state: NavigationState,
  action: NavigationAction,
  counts: { machines: number; projects: number; workspaces: number }
): NavigationState {
  switch (action.type) {
    case 'NAVIGATE': {
      // Push current location to history before navigating
      const newHistory = [...state.history, state.location];

      // Determine focus based on screen
      let focus: PanelFocus = state.focus;
      if (action.location.screen === 'machines') {
        focus = 'machines';
      } else if (action.location.screen === 'projects') {
        focus = 'projects';
      } else if (action.location.screen === 'workspaces' || action.location.screen === 'session') {
        focus = 'workspaces';
      }

      return {
        ...state,
        location: action.location,
        history: newHistory,
        focus,
      };
    }

    case 'GO_BACK': {
      if (state.history.length === 0) {
        return state;
      }
      const newHistory = [...state.history];
      const previousLocation = newHistory.pop()!;

      return {
        ...state,
        location: previousLocation,
        history: newHistory,
      };
    }

    case 'SET_FOCUS': {
      return {
        ...state,
        focus: action.focus,
      };
    }

    case 'SWITCH_FOCUS': {
      // Cycle through available panels based on current screen
      const { screen } = state.location;
      let nextFocus: PanelFocus;

      if (screen === 'machines') {
        // Only machines panel available
        nextFocus = 'machines';
      } else if (screen === 'projects') {
        // Toggle between machines and projects
        nextFocus = state.focus === 'machines' ? 'projects' : 'machines';
      } else {
        // Toggle between projects and workspaces
        nextFocus = state.focus === 'projects' ? 'workspaces' : 'projects';
      }

      return {
        ...state,
        focus: nextFocus,
      };
    }

    case 'SELECT_INDEX': {
      const maxIndex = counts[action.panel] - 1;
      const index = Math.max(0, Math.min(action.index, maxIndex));

      return {
        ...state,
        selectedIndices: {
          ...state.selectedIndices,
          [action.panel]: index,
        },
      };
    }

    case 'MOVE_UP': {
      const panel = state.focus === 'inbox' ? 'workspaces' : state.focus;
      const currentIndex = state.selectedIndices[panel as keyof typeof state.selectedIndices] ?? 0;
      const newIndex = Math.max(0, currentIndex - 1);

      return {
        ...state,
        selectedIndices: {
          ...state.selectedIndices,
          [panel]: newIndex,
        },
      };
    }

    case 'MOVE_DOWN': {
      const panel = state.focus === 'inbox' ? 'workspaces' : state.focus;
      const maxIndex = counts[panel as keyof typeof counts] - 1;
      const currentIndex = state.selectedIndices[panel as keyof typeof state.selectedIndices] ?? 0;
      const newIndex = Math.min(maxIndex, currentIndex + 1);

      return {
        ...state,
        selectedIndices: {
          ...state.selectedIndices,
          [panel]: newIndex,
        },
      };
    }

    case 'TOGGLE_EXPANDED': {
      const newExpanded = new Set(state.expanded);
      if (newExpanded.has(action.id)) {
        newExpanded.delete(action.id);
      } else {
        newExpanded.add(action.id);
      }
      return {
        ...state,
        expanded: newExpanded,
      };
    }

    case 'RESET': {
      return createInitialNavigationState(state.location.screen === 'machines');
    }

    default:
      return state;
  }
}

/**
 * Helper to get current machine ID from location
 */
export function getCurrentMachineId(state: NavigationState): string | null {
  const { location } = state;
  if (location.screen === 'machines') return null;
  return location.machineId;
}

/**
 * Helper to get current project name from location
 */
export function getCurrentProjectName(state: NavigationState): string | null {
  const { location } = state;
  if (location.screen === 'machines' || location.screen === 'projects') return null;
  return location.projectName;
}

/**
 * Helper to check if we can go back
 */
export function canGoBack(state: NavigationState): boolean {
  return state.history.length > 0;
}
