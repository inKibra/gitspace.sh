/**
 * TUI App State Management
 *
 * Unified state management for the TUI that works with both local and remote modes.
 * Uses shared components and providers.
 */

import { useState, useCallback, useEffect, useReducer } from 'react';
import type { MachineInfo } from '../../shared/components/index.js';
import type { MachineProvider } from '../../shared/providers/index.js';
import type { Project, Workspace, WorkspaceSession, InboxItem } from '../../shared/types.js';

// ============================================================================
// Types
// ============================================================================

/** App view modes */
export type AppView =
  | 'machines'     // Machine list (when in remote mode or has multiple machines)
  | 'projects'     // Project list (local mode default)
  | 'workspaces'   // Workspace browser for selected project
  | 'terminal';    // Attached to session

/** Panel focus */
export type PanelFocus = 'projects' | 'workspaces';

/** App state */
export interface AppState {
  // View state
  view: AppView;
  panelFocus: PanelFocus;

  // Machine state (remote mode)
  selectedMachine: MachineInfo | null;
  machineProvider: MachineProvider | null;

  // Project state
  projects: Project[];
  selectedProjectIndex: number;
  currentProject: string | null;

  // Workspace state
  workspaces: Workspace[];
  sessions: Map<string, WorkspaceSession[]>;
  selectedWorkspaceIndex: number;
  expandedWorkspaces: Set<string>;

  // Inbox
  inbox: InboxItem[];
  unreadCount: number;

  // UI state
  isLoading: boolean;
  error: string | null;
}

/** State actions */
export type AppAction =
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_VIEW'; view: AppView }
  | { type: 'SET_PANEL_FOCUS'; focus: PanelFocus }
  | { type: 'SET_MACHINE'; machine: MachineInfo | null; provider: MachineProvider | null }
  | { type: 'SET_PROJECTS'; projects: Project[] }
  | { type: 'SELECT_PROJECT'; index: number }
  | { type: 'SET_CURRENT_PROJECT'; project: string | null }
  | { type: 'SET_WORKSPACES'; workspaces: Workspace[] }
  | { type: 'SET_SESSIONS'; workspaceId: string; sessions: WorkspaceSession[] }
  | { type: 'SELECT_WORKSPACE'; index: number }
  | { type: 'TOGGLE_WORKSPACE'; workspaceId: string }
  | { type: 'SET_INBOX'; inbox: InboxItem[]; unreadCount: number }
  | { type: 'SWITCH_PANEL' }
  | { type: 'MOVE_UP' }
  | { type: 'MOVE_DOWN' };

// ============================================================================
// Reducer
// ============================================================================

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, isLoading: action.loading };

    case 'SET_ERROR':
      return { ...state, error: action.error };

    case 'SET_VIEW':
      return { ...state, view: action.view };

    case 'SET_PANEL_FOCUS':
      return { ...state, panelFocus: action.focus };

    case 'SET_MACHINE':
      return {
        ...state,
        selectedMachine: action.machine,
        machineProvider: action.provider,
        // Reset project/workspace state when switching machines
        projects: [],
        workspaces: [],
        sessions: new Map(),
        selectedProjectIndex: 0,
        selectedWorkspaceIndex: 0,
        expandedWorkspaces: new Set(),
      };

    case 'SET_PROJECTS':
      return { ...state, projects: action.projects };

    case 'SELECT_PROJECT': {
      const index = Math.max(0, Math.min(action.index, state.projects.length - 1));
      return { ...state, selectedProjectIndex: index };
    }

    case 'SET_CURRENT_PROJECT':
      return { ...state, currentProject: action.project };

    case 'SET_WORKSPACES':
      return { ...state, workspaces: action.workspaces, selectedWorkspaceIndex: 0 };

    case 'SET_SESSIONS': {
      const newSessions = new Map(state.sessions);
      newSessions.set(action.workspaceId, action.sessions);
      return { ...state, sessions: newSessions };
    }

    case 'SELECT_WORKSPACE': {
      const maxIndex = getMaxWorkspaceIndex(state);
      const index = Math.max(0, Math.min(action.index, maxIndex));
      return { ...state, selectedWorkspaceIndex: index };
    }

    case 'TOGGLE_WORKSPACE': {
      const newExpanded = new Set(state.expandedWorkspaces);
      if (newExpanded.has(action.workspaceId)) {
        newExpanded.delete(action.workspaceId);
      } else {
        newExpanded.add(action.workspaceId);
      }
      return { ...state, expandedWorkspaces: newExpanded };
    }

    case 'SET_INBOX':
      return { ...state, inbox: action.inbox, unreadCount: action.unreadCount };

    case 'SWITCH_PANEL':
      return {
        ...state,
        panelFocus: state.panelFocus === 'projects' ? 'workspaces' : 'projects',
      };

    case 'MOVE_UP':
      if (state.panelFocus === 'projects') {
        const index = Math.max(0, state.selectedProjectIndex - 1);
        return { ...state, selectedProjectIndex: index };
      } else {
        const index = Math.max(0, state.selectedWorkspaceIndex - 1);
        return { ...state, selectedWorkspaceIndex: index };
      }

    case 'MOVE_DOWN':
      if (state.panelFocus === 'projects') {
        const index = Math.min(state.projects.length - 1, state.selectedProjectIndex + 1);
        return { ...state, selectedProjectIndex: index };
      } else {
        const maxIndex = getMaxWorkspaceIndex(state);
        const index = Math.min(maxIndex, state.selectedWorkspaceIndex + 1);
        return { ...state, selectedWorkspaceIndex: index };
      }

    default:
      return state;
  }
}

function getMaxWorkspaceIndex(state: AppState): number {
  // Count total items in tree (workspaces + sessions + new-session options)
  let count = 0;
  for (const ws of state.workspaces) {
    count++; // workspace itself
    if (state.expandedWorkspaces.has(ws.name)) {
      const sessions = state.sessions.get(ws.name) || [];
      count += sessions.length; // sessions
      count++; // new-session option
    }
  }
  return Math.max(0, count - 1);
}

// ============================================================================
// Initial State
// ============================================================================

function createInitialState(isRemoteMode: boolean): AppState {
  return {
    view: isRemoteMode ? 'machines' : 'projects',
    panelFocus: 'projects',
    selectedMachine: null,
    machineProvider: null,
    projects: [],
    selectedProjectIndex: 0,
    currentProject: null,
    workspaces: [],
    sessions: new Map(),
    selectedWorkspaceIndex: 0,
    expandedWorkspaces: new Set(),
    inbox: [],
    unreadCount: 0,
    isLoading: true,
    error: null,
  };
}

// ============================================================================
// Hook
// ============================================================================

export interface UseAppStateOptions {
  isRemoteMode: boolean;
}

export function useAppState(options: UseAppStateOptions) {
  const { isRemoteMode } = options;

  const [state, dispatch] = useReducer(appReducer, isRemoteMode, createInitialState);

  // Convenience methods
  const setLoading = useCallback((loading: boolean) => {
    dispatch({ type: 'SET_LOADING', loading });
  }, []);

  const setError = useCallback((error: string | null) => {
    dispatch({ type: 'SET_ERROR', error });
  }, []);

  const setView = useCallback((view: AppView) => {
    dispatch({ type: 'SET_VIEW', view });
  }, []);

  const setPanelFocus = useCallback((focus: PanelFocus) => {
    dispatch({ type: 'SET_PANEL_FOCUS', focus });
  }, []);

  const setMachine = useCallback((machine: MachineInfo | null, provider: MachineProvider | null) => {
    dispatch({ type: 'SET_MACHINE', machine, provider });
  }, []);

  const setProjects = useCallback((projects: Project[]) => {
    dispatch({ type: 'SET_PROJECTS', projects });
  }, []);

  const selectProject = useCallback((index: number) => {
    dispatch({ type: 'SELECT_PROJECT', index });
  }, []);

  const setCurrentProject = useCallback((project: string | null) => {
    dispatch({ type: 'SET_CURRENT_PROJECT', project });
  }, []);

  const setWorkspaces = useCallback((workspaces: Workspace[]) => {
    dispatch({ type: 'SET_WORKSPACES', workspaces });
  }, []);

  const setSessions = useCallback((workspaceId: string, sessions: WorkspaceSession[]) => {
    dispatch({ type: 'SET_SESSIONS', workspaceId, sessions });
  }, []);

  const selectWorkspace = useCallback((index: number) => {
    dispatch({ type: 'SELECT_WORKSPACE', index });
  }, []);

  const toggleWorkspace = useCallback((workspaceId: string) => {
    dispatch({ type: 'TOGGLE_WORKSPACE', workspaceId });
  }, []);

  const setInbox = useCallback((inbox: InboxItem[], unreadCount: number) => {
    dispatch({ type: 'SET_INBOX', inbox, unreadCount });
  }, []);

  const switchPanel = useCallback(() => {
    dispatch({ type: 'SWITCH_PANEL' });
  }, []);

  const moveUp = useCallback(() => {
    dispatch({ type: 'MOVE_UP' });
  }, []);

  const moveDown = useCallback(() => {
    dispatch({ type: 'MOVE_DOWN' });
  }, []);

  return {
    state,
    dispatch,
    // Actions
    setLoading,
    setError,
    setView,
    setPanelFocus,
    setMachine,
    setProjects,
    selectProject,
    setCurrentProject,
    setWorkspaces,
    setSessions,
    selectWorkspace,
    toggleWorkspace,
    setInbox,
    switchPanel,
    moveUp,
    moveDown,
  };
}
