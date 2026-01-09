/**
 * TUI state management
 * Handles application state for the terminal user interface
 */

import {
  getAllProjectNames,
  readProjectConfig,
  getCurrentProject,
  setCurrentProject,
  getProjectWorkspacesDir,
} from '../core/config.js';
import { getWorktreeInfo } from '../core/git.js';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { WorktreeInfo } from '../types/workspace.js';
import {
  listSessions,
  getInbox,
  type Session,
  type InboxItem,
} from '../lib/tmux-lite/cli.js';

export interface ProjectState {
  name: string;
  repository: string;
  workspaceCount: number;
  isCurrent: boolean;
}

export interface WorkspaceSession {
  id: string;
  name: string;
  attached: boolean;
  createdAt: number;
  processTitle?: string;
}

export interface WorkspaceState extends WorktreeInfo {
  isStale: boolean;
  sessions: WorkspaceSession[];
}

// Tree item for flat list rendering
export type TreeItem =
  | { type: 'workspace'; workspace: WorkspaceState }
  | { type: 'session'; workspace: WorkspaceState; session: WorkspaceSession }
  | { type: 'new-session'; workspace: WorkspaceState };

export interface AppState {
  projects: ProjectState[];
  workspaces: WorkspaceState[];
  selectedProjectIndex: number;
  selectedTreeIndex: number;  // Index into flattened tree
  expandedWorkspaces: Set<string>;  // Set of expanded workspace names
  activePanel: 'projects' | 'workspaces';
  currentProject: string | null;
  isLoading: boolean;
  error: string | null;
  inbox: InboxItem[];
  unreadCount: number;
}

// Build flat tree from workspaces and expanded state
export function buildTree(workspaces: WorkspaceState[], expanded: Set<string>): TreeItem[] {
  const items: TreeItem[] = [];
  for (const ws of workspaces) {
    items.push({ type: 'workspace', workspace: ws });
    if (expanded.has(ws.name)) {
      // Add sessions
      for (const session of ws.sessions) {
        items.push({ type: 'session', workspace: ws, session });
      }
      // Add "new session" option
      items.push({ type: 'new-session', workspace: ws });
    }
  }
  return items;
}

const STALE_DAYS = 30;

/**
 * Create initial app state
 */
export function createInitialState(): AppState {
  return {
    projects: [],
    workspaces: [],
    selectedProjectIndex: 0,
    selectedTreeIndex: 0,
    expandedWorkspaces: new Set(),
    activePanel: 'projects',
    currentProject: null,
    isLoading: true,
    error: null,
    inbox: [],
    unreadCount: 0,
  };
}

/**
 * Load projects from config
 */
export function loadProjects(): ProjectState[] {
  const projectNames = getAllProjectNames();
  const currentProject = getCurrentProject();

  return projectNames.map((name) => {
    const config = readProjectConfig(name);
    const workspacesDir = getProjectWorkspacesDir(name);
    let workspaceCount = 0;

    if (existsSync(workspacesDir)) {
      workspaceCount = readdirSync(workspacesDir).filter((entry) => {
        const path = join(workspacesDir, entry);
        return existsSync(path) && readdirSync(path).length > 0;
      }).length;
    }

    return {
      name,
      repository: config.repository,
      workspaceCount,
      isCurrent: name === currentProject,
    };
  });
}

/**
 * Load workspaces for a project with session info
 */
export async function loadWorkspaces(projectName: string): Promise<WorkspaceState[]> {
  const workspacesDir = getProjectWorkspacesDir(projectName);

  if (!existsSync(workspacesDir)) {
    return [];
  }

  const workspaceNames = readdirSync(workspacesDir).filter((entry) => {
    const path = join(workspacesDir, entry);
    return existsSync(path) && readdirSync(path).length > 0;
  });

  // Get all tmux-lite sessions
  let allSessions: Session[] = [];
  try {
    allSessions = await listSessions();
  } catch {
    // Server might not be running, that's fine
  }

  const workspaces: WorkspaceState[] = [];
  const now = new Date();

  for (const name of workspaceNames) {
    const workspacePath = join(workspacesDir, name);
    const info = await getWorktreeInfo(workspacePath);

    if (info) {
      const daysSinceCommit = Math.floor(
        (now.getTime() - info.lastCommitDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      // Find sessions for this workspace by matching cwd.
      // Note: Session cwd is set once at creation time and does NOT change
      // as users navigate within the shell. This is intentional - we want to
      // show sessions that were *created for* this workspace, not sessions
      // that happen to currently be in this directory.
      const workspaceSessions = allSessions
        .filter(s => s.cwd === workspacePath)
        .map(s => ({
          id: s.id,
          name: s.name,
          attached: s.attached,
          createdAt: s.createdAt,
          processTitle: s.processTitle,
        }));

      workspaces.push({
        ...info,
        isStale: daysSinceCommit > STALE_DAYS,
        sessions: workspaceSessions,
      });
    }
  }

  return workspaces;
}

/**
 * Load inbox items
 */
export async function loadInbox(): Promise<{ items: InboxItem[]; unreadCount: number }> {
  try {
    const items = await getInbox();
    const unreadCount = items.filter(i => !i.read).length;
    return { items, unreadCount };
  } catch {
    // Server might not be running
    return { items: [], unreadCount: 0 };
  }
}

/**
 * State update actions
 */
export type StateAction =
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_PROJECTS'; projects: ProjectState[] }
  | { type: 'SET_WORKSPACES'; workspaces: WorkspaceState[] }
  | { type: 'SELECT_PROJECT'; index: number }
  | { type: 'SELECT_TREE_ITEM'; index: number }
  | { type: 'TOGGLE_WORKSPACE'; workspaceName: string }
  | { type: 'SET_ACTIVE_PANEL'; panel: 'projects' | 'workspaces' }
  | { type: 'SET_CURRENT_PROJECT'; project: string | null }
  | { type: 'SET_INBOX'; inbox: InboxItem[]; unreadCount: number }
  | { type: 'MOVE_UP' }
  | { type: 'MOVE_DOWN' }
  | { type: 'SWITCH_PANEL' };

/**
 * State reducer
 */
export function stateReducer(state: AppState, action: StateAction): AppState {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, isLoading: action.loading };

    case 'SET_ERROR':
      return { ...state, error: action.error };

    case 'SET_PROJECTS':
      return { ...state, projects: action.projects };

    case 'SET_WORKSPACES':
      return { ...state, workspaces: action.workspaces, selectedTreeIndex: 0 };

    case 'SELECT_PROJECT': {
      const index = Math.max(0, Math.min(action.index, state.projects.length - 1));
      return { ...state, selectedProjectIndex: index };
    }

    case 'SELECT_TREE_ITEM': {
      const tree = buildTree(state.workspaces, state.expandedWorkspaces);
      const index = Math.max(0, Math.min(action.index, tree.length - 1));
      return { ...state, selectedTreeIndex: index };
    }

    case 'TOGGLE_WORKSPACE': {
      const newExpanded = new Set(state.expandedWorkspaces);
      if (newExpanded.has(action.workspaceName)) {
        newExpanded.delete(action.workspaceName);
      } else {
        newExpanded.add(action.workspaceName);
      }
      return { ...state, expandedWorkspaces: newExpanded };
    }

    case 'SET_ACTIVE_PANEL':
      return { ...state, activePanel: action.panel };

    case 'SET_CURRENT_PROJECT':
      return { ...state, currentProject: action.project };

    case 'SET_INBOX':
      return { ...state, inbox: action.inbox, unreadCount: action.unreadCount };

    case 'MOVE_UP':
      if (state.activePanel === 'projects') {
        const index = Math.max(0, state.selectedProjectIndex - 1);
        return { ...state, selectedProjectIndex: index };
      } else {
        const tree = buildTree(state.workspaces, state.expandedWorkspaces);
        const index = Math.max(0, state.selectedTreeIndex - 1);
        return { ...state, selectedTreeIndex: index };
      }

    case 'MOVE_DOWN':
      if (state.activePanel === 'projects') {
        const index = Math.min(state.projects.length - 1, state.selectedProjectIndex + 1);
        return { ...state, selectedProjectIndex: index };
      } else {
        const tree = buildTree(state.workspaces, state.expandedWorkspaces);
        const index = Math.min(tree.length - 1, state.selectedTreeIndex + 1);
        return { ...state, selectedTreeIndex: index };
      }

    case 'SWITCH_PANEL':
      return {
        ...state,
        activePanel: state.activePanel === 'projects' ? 'workspaces' : 'projects',
      };

    default:
      return state;
  }
}
