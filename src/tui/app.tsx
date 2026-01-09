/**
 * TUI Application v2 - Using Shared Components
 *
 * Clean implementation using shared hooks and components:
 * - useFlow for modal system
 * - useMachineList for machine selection
 * - useSpacesBrowser for workspace browsing
 * - useProjectList for project selection
 */

import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard } from '@opentui/react';
import { useState, useEffect, useCallback, useReducer } from 'react';

// Terminal component
import { Terminal, useTerminalSession } from './components/Terminal.js';
import type { Session } from '../lib/tmux-lite/protocol.js';
import { listSessions, createSession, ensureServer, killSession } from '../lib/tmux-lite/cli.js';
import { getSessionSocketPath } from '../lib/tmux-lite/protocol.js';

// Shared components and hooks
import {
  useFlow,
  useMachineList,
  useSpacesBrowser,
  useProjectList,
  getDefaultShortcuts,
  isFlowInput,
  isFlowConfirmTyped,
  type MachineInfo,
  type ProjectInfo,
} from '../shared/components/index.js';
import { FlowTUI } from '../shared/components/Flow.tui.js';
import { MachineListTUI } from '../shared/components/MachineList.tui.js';
import { SpacesBrowserTUI } from '../shared/components/SpacesBrowser.tui.js';
import { ProjectListTUI } from '../shared/components/ProjectList.tui.js';
import { InboxTUI } from '../shared/components/Inbox.tui.js';
import { useInbox } from '../shared/components/Inbox.js';
import { clearInbox, markInboxRead } from '../lib/tmux-lite/cli.js';

// Local state and config
import {
  loadProjects,
  loadWorkspaces,
  loadInbox,
  buildTree,
  type ProjectState,
  type WorkspaceState,
} from './state.js';
import { useDaemonStatus, formatUptime, formatRelayStatus } from './hooks/useDaemonStatus.js';
import {
  setCurrentProject,
  readProjectConfig,
  getProjectBaseDir,
  getProjectWorkspacesDir,
  createProject,
  projectExists,
  updateProjectConfig,
} from '../core/config.js';
import { removeWorkspace, removeProject } from '../commands/remove.js';

// Git and workspace creation
import { listRemoteBranches, createWorktree, checkRemoteBranch, getDefaultBranch } from '../core/git.js';
import { fetchUnstartedIssues } from '../core/linear.js';
import { generateMarkdown } from '../utils/markdown.js';
import { sanitizeForFileSystem, generateWorkspaceName, isValidWorkspaceName, extractRepoName } from '../utils/sanitize.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { LinearIssue } from '../types/workspace.js';

// Project creation
import { listAllRepos, cloneRepository } from '../core/github.js';
import { detectBundleInRepo, loadBundleFromPath, copyBundleScripts } from '../core/bundle.js';
import { setProjectSecret } from '../utils/secrets.js';
import type { OnboardingStep } from '../types/bundle.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// TUI hooks
import { useRemoteMachines, type RelayConfig } from './hooks/useRemoteMachines.js';

// Types
import type { InboxItem } from '../lib/tmux-lite/cli.js';

// ============================================================================
// Workspace Flow Types (Custom State Machine)
// ============================================================================

/** Available workspace creation sources */
type WorkspaceSource = 'branch' | 'linear' | 'manual';

/** Workspace flow states - explicit state machine */
type WorkspaceFlowState =
  | { type: 'closed' }
  | { type: 'source-select'; selectedIndex: number; options: Array<{ label: string; description: string; value: WorkspaceSource }> }
  | { type: 'loading'; title: string; message: string }
  | { type: 'branch-select'; branches: string[]; selectedIndex: number }
  | { type: 'linear-select'; issues: LinearIssue[]; selectedIndex: number }
  | { type: 'manual-input'; inputValue: string; error: string | null }
  | { type: 'creating'; workspaceName: string };

/** Project flow states - explicit state machine for project creation */
type ProjectFlowState =
  | { type: 'closed' }
  | { type: 'loading-repos' }
  | { type: 'repo-select'; repos: string[]; selectedIndex: number }
  | { type: 'cloning'; repo: string }
  | { type: 'onboarding';
      repo: string;
      projectName: string;
      baseBranch: string;
      bundleDir: string;
      bundleName: string;
      steps: OnboardingStep[];
      currentStep: number;
      collectedValues: Record<string, string>;
      collectedSecretKeys: string[];
      inputValue: string;
      confirmStatus?: 'checking' | 'found' | 'missing' | null;
    }
  | { type: 'creating'; projectName: string };

// ============================================================================
// Constants
// ============================================================================

const COLORS = {
  border: '#555555',
  borderFocused: '#00AAFF',
  text: '#FFFFFF',
  textDim: '#888888',
  selected: '#00AAFF',
  title: '#00FF88',
  statusBar: '#333333',
  loading: '#FFAA00',
  error: '#FF4444',
  // ASCII art gradient
  gradient1: '#00FFFF',
  gradient2: '#00DDFF',
  gradient3: '#00BBFF',
  gradient4: '#0099FF',
  gradient5: '#0077FF',
  gradient6: '#0055FF',
  asciiBox: '#444466',
  subtitle: '#888899',
};

// ASCII art header
const ASCII_LINES = [
  { text: '╔══════════════════════════════════════════════════════════════╗', color: COLORS.asciiBox },
  { text: '║                                                              ║', color: COLORS.asciiBox },
  { text: '║   ███████╗██████╗  █████╗  ██████╗███████╗███████╗           ║', color: COLORS.gradient1 },
  { text: '║   ██╔════╝██╔══██╗██╔══██╗██╔════╝██╔════╝██╔════╝           ║', color: COLORS.gradient2 },
  { text: '║   ███████╗██████╔╝███████║██║     █████╗  ███████╗           ║', color: COLORS.gradient3 },
  { text: '║   ╚════██║██╔═══╝ ██╔══██║██║     ██╔══╝  ╚════██║           ║', color: COLORS.gradient4 },
  { text: '║   ███████║██║     ██║  ██║╚██████╗███████╗███████║           ║', color: COLORS.gradient5 },
  { text: '║   ╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝╚══════╝╚══════╝           ║', color: COLORS.gradient6 },
  { text: '║                                                              ║', color: COLORS.asciiBox },
  { text: '║                    worktree manager                          ║', color: COLORS.subtitle },
  { text: '║                                                              ║', color: COLORS.asciiBox },
  { text: '╚══════════════════════════════════════════════════════════════╝', color: COLORS.asciiBox },
];

// ============================================================================
// App State
// ============================================================================

type AppView = 'machines' | 'projects' | 'workspaces' | 'terminal' | 'inbox';
type PanelFocus = 'projects' | 'workspaces';

interface AppState {
  view: AppView;
  panelFocus: PanelFocus;
  selectedMachine: MachineInfo | null;
  projects: ProjectState[];
  workspaces: WorkspaceState[];
  currentProject: string | null;
  inbox: InboxItem[];
  unreadCount: number;
  isLoading: boolean;
  error: string | null;
  attachedSession: Session | null;
}

type AppAction =
  | { type: 'SET_VIEW'; view: AppView }
  | { type: 'SET_PANEL_FOCUS'; focus: PanelFocus }
  | { type: 'SET_MACHINE'; machine: MachineInfo | null }
  | { type: 'SET_PROJECTS'; projects: ProjectState[] }
  | { type: 'SET_WORKSPACES'; workspaces: WorkspaceState[] }
  | { type: 'SET_CURRENT_PROJECT'; project: string | null }
  | { type: 'SET_INBOX'; inbox: InboxItem[]; unreadCount: number }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SWITCH_PANEL' }
  | { type: 'SET_ATTACHED_SESSION'; session: Session | null };

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, view: action.view };
    case 'SET_PANEL_FOCUS':
      return { ...state, panelFocus: action.focus };
    case 'SET_MACHINE':
      return { ...state, selectedMachine: action.machine };
    case 'SET_PROJECTS':
      return { ...state, projects: action.projects };
    case 'SET_WORKSPACES':
      return { ...state, workspaces: action.workspaces };
    case 'SET_CURRENT_PROJECT':
      return { ...state, currentProject: action.project };
    case 'SET_INBOX':
      return { ...state, inbox: action.inbox, unreadCount: action.unreadCount };
    case 'SET_LOADING':
      return { ...state, isLoading: action.loading };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'SWITCH_PANEL':
      return { ...state, panelFocus: state.panelFocus === 'projects' ? 'workspaces' : 'projects' };
    case 'SET_ATTACHED_SESSION':
      return { ...state, attachedSession: action.session };
    default:
      return state;
  }
}

// ============================================================================
// Props
// ============================================================================

export interface AppProps {
  relayConfig?: RelayConfig;
  onQuit?: () => void;
}

// ============================================================================
// Main App Component
// ============================================================================

function App({ relayConfig, onQuit }: AppProps) {
  const isRemoteMode = !!relayConfig;

  // Force re-render counter for resize
  const [, forceUpdate] = useState(0);

  // Handle terminal resize
  useEffect(() => {
    const handleResize = () => {
      // Force React to re-render by updating state
      forceUpdate(n => n + 1);
    };

    process.on('SIGWINCH', handleResize);
    return () => {
      process.removeListener('SIGWINCH', handleResize);
    };
  }, []);

  // App state
  const [state, dispatch] = useReducer(appReducer, {
    view: isRemoteMode ? 'machines' : 'projects',
    panelFocus: 'projects',
    selectedMachine: null,
    projects: [],
    workspaces: [],
    currentProject: null,
    inbox: [],
    unreadCount: 0,
    isLoading: true,
    error: null,
    attachedSession: null,
  });

  // Shared Flow hook (for non-workspace flows)
  const flow = useFlow({
    onError: (error) => dispatch({ type: 'SET_ERROR', error: error.message }),
  });

  // Workspace creation flow (custom state machine)
  const [workspaceFlow, setWorkspaceFlow] = useState<WorkspaceFlowState>({ type: 'closed' });

  // Project creation flow (custom state machine)
  const [projectFlow, setProjectFlow] = useState<ProjectFlowState>({ type: 'closed' });

  // Remote machines hook
  const remoteMachines = useRemoteMachines({
    relayConfig,
    onError: (error) => dispatch({ type: 'SET_ERROR', error: error.message }),
  });

  // Daemon status hook (tmux-lite and serve)
  const { status: daemonStatus } = useDaemonStatus({ pollInterval: 5000 });

  // ========== Data Loading ==========

  // Load projects
  const refreshProjects = useCallback(async () => {
    const projects = loadProjects();
    dispatch({ type: 'SET_PROJECTS', projects });

    // Set current project if not set
    const current = projects.find(p => p.isCurrent);
    if (current) {
      dispatch({ type: 'SET_CURRENT_PROJECT', project: current.name });
    }
  }, []);

  // Load workspaces for current project
  const refreshWorkspaces = useCallback(async () => {
    if (!state.currentProject) return;
    const workspaces = await loadWorkspaces(state.currentProject);
    dispatch({ type: 'SET_WORKSPACES', workspaces });
  }, [state.currentProject]);

  // Load inbox
  const refreshInbox = useCallback(async () => {
    const { items, unreadCount } = await loadInbox();
    dispatch({ type: 'SET_INBOX', inbox: items, unreadCount });
  }, []);

  // Initial load
  useEffect(() => {
    const load = async () => {
      dispatch({ type: 'SET_LOADING', loading: true });
      try {
        await refreshProjects();
        // Load inbox in background (don't block initial render)
        refreshInbox().catch(() => {});
      } catch (err) {
        dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to load' });
      } finally {
        dispatch({ type: 'SET_LOADING', loading: false });
      }
    };
    load();
  }, []);

  // Load workspaces when project changes
  useEffect(() => {
    if (state.currentProject) {
      refreshWorkspaces();
    }
  }, [state.currentProject]);

  // ========== Action Handlers ==========

  // Select a project
  const handleSelectProject = useCallback((project: ProjectInfo) => {
    setCurrentProject(project.name);
    dispatch({ type: 'SET_CURRENT_PROJECT', project: project.name });
    dispatch({ type: 'SET_PANEL_FOCUS', focus: 'workspaces' });
  }, []);

  // Create new project - show confirmation
  const handleCreateProject = useCallback(() => {
    flow.showMessage({
      title: 'New Project',
      message: 'Use "gssh add project" from command line to add a new project.',
      variant: 'info',
    });
  }, [flow]);

  // Delete project - show typed confirmation
  const handleDeleteProject = useCallback((project: ProjectInfo) => {
    flow.showConfirmTyped({
      title: 'Delete Project',
      message: `Are you sure you want to delete project "${project.name}"?`,
      confirmText: project.name,
      warning: 'This will delete all workspaces in this project!',
      onConfirm: async () => {
        flow.showLoading({ title: 'Deleting', message: 'Removing project...' });
        await removeProject(project.name, { force: false });
        flow.close();
        await refreshProjects();
      },
    });
  }, [flow, refreshProjects]);

  // Attach to session using embedded terminal
  const handleAttachSession = useCallback(async (params: { sessionId?: string; workspaceId?: string }) => {
    await ensureServer();

    if (params.sessionId) {
      // Get fresh session list from server to verify session still exists
      const liveSessions = await listSessions();
      const liveSession = liveSessions.find(s => s.id === params.sessionId);

      if (!liveSession) {
        // Session no longer exists on server - refresh workspaces to update UI
        await refreshWorkspaces();
        dispatch({ type: 'SET_ERROR', error: 'Session no longer exists. The session list has been refreshed.' });
        return;
      }

      // Use the live session info from the server (not stale state)
      const sessionInfo: Session = liveSession;

      if (sessionInfo.attached) {
        // Show steal confirmation
        flow.showConfirm({
          title: 'Session In Use',
          message: `This session is currently attached. Steal it?`,
          variant: 'warning',
          confirmLabel: 'Steal',
          onConfirm: async () => {
            // Attach using embedded terminal (will kick the other client)
            dispatch({ type: 'SET_ATTACHED_SESSION', session: sessionInfo });
            dispatch({ type: 'SET_VIEW', view: 'terminal' });
          },
        });
        return;
      }

      // Attach using embedded terminal
      dispatch({ type: 'SET_ATTACHED_SESSION', session: sessionInfo });
      dispatch({ type: 'SET_VIEW', view: 'terminal' });
    } else if (params.workspaceId) {
      // Create new session
      const workspace = state.workspaces.find(w => w.name === params.workspaceId);
      if (workspace) {
        flow.showInput({
          title: 'New Session',
          label: 'Session name (optional):',
          placeholder: 'Leave empty for auto-generated name',
          onSubmit: async (name) => {
            const sessionName = name || `${state.currentProject}:${workspace.name}:${Date.now()}`;
            try {
              const session = await createSession(sessionName, workspace.path);
              // Attach to newly created session
              dispatch({ type: 'SET_ATTACHED_SESSION', session });
              dispatch({ type: 'SET_VIEW', view: 'terminal' });
            } catch (err) {
              dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to create session' });
            }
          },
        });
      }
    }
  }, [state.workspaces, state.currentProject, flow, refreshWorkspaces]);

  // Handle terminal detach
  const handleTerminalDetach = useCallback(async () => {
    dispatch({ type: 'SET_ATTACHED_SESSION', session: null });
    dispatch({ type: 'SET_VIEW', view: 'projects' });
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  // Handle terminal exit
  const handleTerminalExit = useCallback(async (code: number) => {
    dispatch({ type: 'SET_ATTACHED_SESSION', session: null });
    dispatch({ type: 'SET_VIEW', view: 'projects' });
    await refreshWorkspaces();
    // Optionally show exit notification
    if (code !== 0) {
      flow.showMessage({
        title: 'Session Exited',
        message: `Process exited with code ${code}`,
        variant: 'info',
      });
    }
  }, [refreshWorkspaces, flow]);

  // Handle terminal kicked
  const handleTerminalKicked = useCallback(async () => {
    dispatch({ type: 'SET_ATTACHED_SESSION', session: null });
    dispatch({ type: 'SET_VIEW', view: 'projects' });
    await refreshWorkspaces();
    flow.showMessage({
      title: 'Session Taken Over',
      message: 'Another client took over this session',
      variant: 'warning',
    });
  }, [refreshWorkspaces, flow]);

  // Handle terminal error
  const handleTerminalError = useCallback(async (error: string) => {
    dispatch({ type: 'SET_ATTACHED_SESSION', session: null });
    dispatch({ type: 'SET_VIEW', view: 'projects' });
    dispatch({ type: 'SET_ERROR', error });
    await refreshWorkspaces();
  }, [refreshWorkspaces]);

  // Delete workspace
  const handleDeleteWorkspace = useCallback((workspace: WorkspaceState) => {
    flow.showConfirmTyped({
      title: 'Delete Workspace',
      message: `Are you sure you want to delete workspace "${workspace.name}"?`,
      confirmText: workspace.name,
      warning: workspace.sessions.length > 0 ? `This will kill ${workspace.sessions.length} active session(s)!` : undefined,
      onConfirm: async () => {
        if (!state.currentProject) return;
        flow.showLoading({ title: 'Deleting', message: 'Removing workspace...' });
        await removeWorkspace(workspace.name, { force: false });
        flow.close();
        await refreshWorkspaces();
      },
    });
  }, [flow, state.currentProject, refreshWorkspaces]);

  // Delete session
  const handleDeleteSession = useCallback((sessionId: string, sessionName: string) => {
    flow.showConfirm({
      title: 'Kill Session',
      message: `Kill session "${sessionName}"?`,
      variant: 'warning',
      confirmLabel: 'Kill',
      onConfirm: async () => {
        try {
          await killSession(sessionId);
          // Small delay to let server process the kill before refreshing
          await new Promise(resolve => setTimeout(resolve, 100));
          await refreshWorkspaces();
        } catch (err) {
          dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to kill session' });
        }
      },
    });
  }, [flow, refreshWorkspaces]);

  // ========== Workspace Creation (Custom State Machine) ==========

  // Core function to create workspace and open session
  const createWorkspaceAndOpenSession = useCallback(async (
    workspaceName: string,
    branchName: string,
    existsRemotely: boolean,
    linearIssue?: LinearIssue
  ) => {
    if (!state.currentProject) return;

    try {
      const baseDir = getProjectBaseDir(state.currentProject);
      const workspacesDir = getProjectWorkspacesDir(state.currentProject);
      const workspacePath = join(workspacesDir, workspaceName);
      const config = readProjectConfig(state.currentProject);

      // Check if workspace already exists
      if (existsSync(workspacePath)) {
        setWorkspaceFlow({ type: 'closed' });
        dispatch({ type: 'SET_ERROR', error: `Workspace "${workspaceName}" already exists` });
        return;
      }

      setWorkspaceFlow({ type: 'creating', workspaceName });

      // Create worktree
      await createWorktree(baseDir, workspacePath, branchName, config.baseBranch, existsRemotely);

      // Save Linear issue if present
      if (linearIssue && config.linearApiKey) {
        const promptDir = join(workspacePath, '.prompt');
        mkdirSync(promptDir, { recursive: true });
        const markdown = await generateMarkdown(linearIssue, promptDir, config.linearApiKey);
        writeFileSync(join(promptDir, 'issue.md'), markdown, 'utf-8');
      }

      setWorkspaceFlow({ type: 'closed' });
      await refreshWorkspaces();

      // Create session and attach
      await ensureServer();
      const session = await createSession(`${state.currentProject}:${workspaceName}:${Date.now()}`, workspacePath);
      dispatch({ type: 'SET_ATTACHED_SESSION', session });
      dispatch({ type: 'SET_VIEW', view: 'terminal' });
    } catch (err) {
      setWorkspaceFlow({ type: 'closed' });
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to create workspace' });
    }
  }, [state.currentProject, refreshWorkspaces]);

  // Handle selecting a source (branch/linear/manual)
  const handleSourceSelect = useCallback(async (source: WorkspaceSource) => {
    if (!state.currentProject) return;

    if (source === 'branch') {
      setWorkspaceFlow({ type: 'loading', title: 'Loading', message: 'Fetching remote branches...' });

      try {
        const baseDir = getProjectBaseDir(state.currentProject);
        const config = readProjectConfig(state.currentProject);
        const allBranches = await listRemoteBranches(baseDir);
        const branches = allBranches.filter(b => b !== config.baseBranch);

        if (branches.length === 0) {
          flow.showMessage({
            title: 'No Branches',
            message: `No remote branches found (excluding base branch ${config.baseBranch})`,
            variant: 'warning',
          });
          setWorkspaceFlow({ type: 'closed' });
          return;
        }

        setWorkspaceFlow({ type: 'branch-select', branches, selectedIndex: 0 });
      } catch (err) {
        flow.showMessage({
          title: 'Error',
          message: err instanceof Error ? err.message : 'Failed to fetch branches',
          variant: 'error',
        });
        setWorkspaceFlow({ type: 'closed' });
      }
    } else if (source === 'linear') {
      const config = readProjectConfig(state.currentProject);
      if (!config.linearApiKey) {
        flow.showMessage({
          title: 'Not Configured',
          message: 'Linear is not configured for this project',
          variant: 'warning',
        });
        setWorkspaceFlow({ type: 'closed' });
        return;
      }

      setWorkspaceFlow({ type: 'loading', title: 'Loading', message: 'Fetching Linear issues...' });

      try {
        const issues = await fetchUnstartedIssues(config.linearApiKey, config.linearTeamKey);

        if (issues.length === 0) {
          flow.showMessage({
            title: 'No Issues',
            message: 'No unstarted Linear issues found',
            variant: 'warning',
          });
          setWorkspaceFlow({ type: 'closed' });
          return;
        }

        setWorkspaceFlow({ type: 'linear-select', issues, selectedIndex: 0 });
      } catch (err) {
        flow.showMessage({
          title: 'Error',
          message: err instanceof Error ? err.message : 'Failed to fetch Linear issues',
          variant: 'error',
        });
        setWorkspaceFlow({ type: 'closed' });
      }
    } else if (source === 'manual') {
      setWorkspaceFlow({ type: 'manual-input', inputValue: '', error: null });
    }
  }, [state.currentProject, flow]);

  // Handle branch selection
  const handleBranchSelect = useCallback(async (branch: string) => {
    const workspaceName = sanitizeForFileSystem(branch);
    await createWorkspaceAndOpenSession(workspaceName, branch, true);
  }, [createWorkspaceAndOpenSession]);

  // Handle Linear issue selection
  const handleLinearSelect = useCallback(async (issue: LinearIssue) => {
    const workspaceName = generateWorkspaceName(issue.identifier, issue.title);
    await createWorkspaceAndOpenSession(workspaceName, workspaceName, false, issue);
  }, [createWorkspaceAndOpenSession]);

  // Handle manual name submission
  const handleManualSubmit = useCallback(async (name: string) => {
    if (!name || name.trim().length === 0) {
      setWorkspaceFlow(prev => prev.type === 'manual-input' ? { ...prev, error: 'Workspace name is required' } : prev);
      return;
    }
    if (!isValidWorkspaceName(name)) {
      setWorkspaceFlow(prev => prev.type === 'manual-input' ? { ...prev, error: 'Use only letters, numbers, hyphens, underscores' } : prev);
      return;
    }
    await createWorkspaceAndOpenSession(name, name, false);
  }, [createWorkspaceAndOpenSession]);

  // Main handler to start new workspace flow
  const handleNewWorkspaceFlow = useCallback(() => {
    if (!state.currentProject) return;

    const config = readProjectConfig(state.currentProject);
    const hasLinear = !!config.linearApiKey;

    const options: Array<{ label: string; description: string; value: WorkspaceSource }> = [
      { label: 'GitHub Branch', description: 'Create from existing remote branch', value: 'branch' },
      ...(hasLinear ? [{ label: 'Linear Issue', description: 'Create from Linear ticket', value: 'linear' as const }] : []),
      { label: 'Manual Name', description: 'Enter a custom workspace name', value: 'manual' },
    ];

    setWorkspaceFlow({ type: 'source-select', selectedIndex: 0, options });
  }, [state.currentProject]);

  // ========== Project Creation (Custom State Machine) ==========

  // Finalize project creation
  const finalizeProject = useCallback(async (projectName: string) => {
    setCurrentProject(projectName);
    await refreshProjects();
    setProjectFlow({ type: 'closed' });
    flow.showMessage({
      title: 'Project Created',
      message: `Project "${projectName}" has been created successfully!`,
      variant: 'success',
    });
  }, [refreshProjects, flow]);

  // Check if a command exists (for onboarding confirm steps)
  const checkCommand = useCallback(async (command: string): Promise<boolean> => {
    try {
      await execAsync(command);
      return true;
    } catch {
      return false;
    }
  }, []);

  // Advance to the next onboarding step
  const advanceOnboardingStep = useCallback(async () => {
    if (projectFlow.type !== 'onboarding') return;

    const currentStep = projectFlow.steps[projectFlow.currentStep];
    const newValues = { ...projectFlow.collectedValues };
    const newSecretKeys = [...projectFlow.collectedSecretKeys];

    // Save current step's value if applicable
    if (currentStep && (currentStep.type === 'input' || currentStep.type === 'secret')) {
      const stepWithKey = currentStep as { configKey: string; defaultValue?: string };
      const value = projectFlow.inputValue.trim() || stepWithKey.defaultValue || '';

      if (currentStep.type === 'secret') {
        await setProjectSecret(projectFlow.projectName, stepWithKey.configKey, value);
        newSecretKeys.push(stepWithKey.configKey);
      } else {
        newValues[stepWithKey.configKey] = value;
      }
    }

    const nextStepIndex = projectFlow.currentStep + 1;

    if (nextStepIndex >= projectFlow.steps.length) {
      // All steps done - create the project
      setProjectFlow({ type: 'creating', projectName: projectFlow.projectName });

      try {
        createProject(projectFlow.projectName, projectFlow.repo, projectFlow.baseBranch);
        copyBundleScripts(projectFlow.bundleDir, projectFlow.projectName);

        // Update project config with bundle values
        if (Object.keys(newValues).length > 0 || newSecretKeys.length > 0) {
          updateProjectConfig(projectFlow.projectName, {
            bundleValues: Object.keys(newValues).length > 0 ? newValues : undefined,
            bundleSecretKeys: newSecretKeys.length > 0 ? newSecretKeys : undefined,
            appliedBundle: {
              name: projectFlow.bundleName,
              version: '1.0',
              source: projectFlow.bundleDir,
              appliedAt: new Date().toISOString(),
            },
          });
        }

        await finalizeProject(projectFlow.projectName);
      } catch (err) {
        flow.showMessage({
          title: 'Error',
          message: err instanceof Error ? err.message : 'Failed to create project',
          variant: 'error',
        });
        setProjectFlow({ type: 'closed' });
      }
    } else {
      // Move to next step
      const nextStep = projectFlow.steps[nextStepIndex];

      // If it's a confirm step with checkCommand, start checking
      if (nextStep.type === 'confirm' && (nextStep as { checkCommand?: string }).checkCommand) {
        setProjectFlow({
          ...projectFlow,
          currentStep: nextStepIndex,
          collectedValues: newValues,
          collectedSecretKeys: newSecretKeys,
          inputValue: '',
          confirmStatus: 'checking',
        });

        const found = await checkCommand((nextStep as { checkCommand: string }).checkCommand);
        setProjectFlow(prev =>
          prev.type === 'onboarding'
            ? { ...prev, confirmStatus: found ? 'found' : 'missing' }
            : prev
        );
      } else {
        const defaultValue = (nextStep as { defaultValue?: string }).defaultValue || '';
        setProjectFlow({
          ...projectFlow,
          currentStep: nextStepIndex,
          collectedValues: newValues,
          collectedSecretKeys: newSecretKeys,
          inputValue: defaultValue,
          confirmStatus: null,
        });
      }
    }
  }, [projectFlow, checkCommand, finalizeProject, flow]);

  // Handle repository selection
  const handleSelectRepo = useCallback(async (repo: string) => {
    const projectName = extractRepoName(repo);

    // Check if project already exists
    if (projectExists(projectName)) {
      flow.showMessage({
        title: 'Project Exists',
        message: `Project "${projectName}" already exists`,
        variant: 'error',
      });
      setProjectFlow({ type: 'closed' });
      return;
    }

    setProjectFlow({ type: 'cloning', repo });

    try {
      const baseDir = getProjectBaseDir(projectName);
      await cloneRepository(repo, baseDir);
      const baseBranch = await getDefaultBranch(baseDir);

      // Check for bundle
      const bundleDir = detectBundleInRepo(baseDir);
      if (bundleDir) {
        const loadedBundle = loadBundleFromPath(bundleDir);

        if (loadedBundle.bundle.onboarding && loadedBundle.bundle.onboarding.length > 0) {
          // Start onboarding flow
          const firstStep = loadedBundle.bundle.onboarding[0];
          const initialInputValue = (firstStep as { defaultValue?: string }).defaultValue || '';

          // If first step is a confirm with checkCommand, start checking
          if (firstStep.type === 'confirm' && (firstStep as { checkCommand?: string }).checkCommand) {
            setProjectFlow({
              type: 'onboarding',
              repo,
              projectName,
              baseBranch,
              bundleDir: loadedBundle.bundleDir,
              bundleName: loadedBundle.bundle.name,
              steps: loadedBundle.bundle.onboarding,
              currentStep: 0,
              collectedValues: {},
              collectedSecretKeys: [],
              inputValue: '',
              confirmStatus: 'checking',
            });

            const found = await checkCommand((firstStep as { checkCommand: string }).checkCommand);
            setProjectFlow(prev =>
              prev.type === 'onboarding'
                ? { ...prev, confirmStatus: found ? 'found' : 'missing' }
                : prev
            );
          } else {
            setProjectFlow({
              type: 'onboarding',
              repo,
              projectName,
              baseBranch,
              bundleDir: loadedBundle.bundleDir,
              bundleName: loadedBundle.bundle.name,
              steps: loadedBundle.bundle.onboarding,
              currentStep: 0,
              collectedValues: {},
              collectedSecretKeys: [],
              inputValue: initialInputValue,
              confirmStatus: null,
            });
          }
          return;
        }

        // No onboarding, just copy scripts and create project
        createProject(projectName, repo, baseBranch);
        copyBundleScripts(bundleDir, projectName);
        updateProjectConfig(projectName, {
          appliedBundle: {
            name: loadedBundle.bundle.name,
            version: loadedBundle.bundle.version,
            source: loadedBundle.source,
            appliedAt: new Date().toISOString(),
          },
        });
      } else {
        // No bundle, just create project
        createProject(projectName, repo, baseBranch);
      }

      await finalizeProject(projectName);
    } catch (err) {
      flow.showMessage({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to clone repository',
        variant: 'error',
      });
      setProjectFlow({ type: 'closed' });
    }
  }, [flow, checkCommand, finalizeProject]);

  // Start new project flow
  const handleNewProjectFlow = useCallback(async () => {
    setProjectFlow({ type: 'loading-repos' });

    try {
      const repos = await listAllRepos();

      if (repos.length === 0) {
        flow.showMessage({
          title: 'No Repositories',
          message: 'No GitHub repositories found. Make sure you are logged in with `gh auth login`.',
          variant: 'warning',
        });
        setProjectFlow({ type: 'closed' });
        return;
      }

      setProjectFlow({ type: 'repo-select', repos, selectedIndex: 0 });
    } catch (err) {
      flow.showMessage({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to fetch repositories',
        variant: 'error',
      });
      setProjectFlow({ type: 'closed' });
    }
  }, [flow]);

  // ========== Shared Hooks ==========

  // Convert projects to ProjectInfo format
  const projectInfos: ProjectInfo[] = state.projects.map(p => ({
    name: p.name,
    repository: p.repository,
    workspaceCount: p.workspaceCount,
    isCurrent: p.isCurrent,
  }));

  // Project list hook
  const projectListProps = useProjectList({
    projects: projectInfos,
    onSelect: handleSelectProject,
    onCreateNew: handleCreateProject,
    onDelete: handleDeleteProject,
    onRefresh: refreshProjects,
  });

  // Convert workspaces to shared format
  const workspaceInfos = state.workspaces.map(w => ({
    id: w.name,
    name: w.name,
    path: w.path,
    projectName: state.currentProject || '',
    branch: w.branch,
    sessionCount: w.sessions.length,
    isStale: w.isStale,
  }));

  // Extract sessions
  const sessionInfos = state.workspaces.flatMap(w =>
    w.sessions.map(s => ({
      id: s.id,
      name: s.name,
      workspaceId: w.name,
      attached: s.attached,
      createdAt: s.createdAt,
      processTitle: s.processTitle,
    }))
  );

  // Spaces browser hook
  const spacesBrowserProps = useSpacesBrowser({
    workspaces: workspaceInfos,
    sessions: sessionInfos,
    onRequestSessions: () => {}, // Sessions already loaded
    onAttachSession: handleAttachSession,
    onRefresh: refreshWorkspaces,
    onBack: () => dispatch({ type: 'SET_PANEL_FOCUS', focus: 'projects' }),
    onCreateWorkspace: handleNewWorkspaceFlow,
    machineName: state.currentProject || undefined,
    showProjectHeaders: false, // Don't show project headers since we're already filtered
  });

  // Machine list hook (for remote mode)
  const machineListProps = useMachineList({
    machines: remoteMachines.machines,
    status: remoteMachines.status,
    error: remoteMachines.error,
    publicKey: undefined,
    onConnect: async (machine) => {
      dispatch({ type: 'SET_MACHINE', machine });
      dispatch({ type: 'SET_VIEW', view: 'projects' });
    },
    onRefresh: remoteMachines.refreshMachines,
  });

  // Inbox hook
  const inboxProps = useInbox({
    items: state.inbox,
    unreadCount: state.unreadCount,
    onClearItem: async (id) => {
      await clearInbox(id);
      await refreshInbox();
    },
    onClearAll: async () => {
      await clearInbox();
      await refreshInbox();
    },
    onMarkRead: async (id) => {
      await markInboxRead(id);
      await refreshInbox();
    },
    onAttachSession: async (sessionId) => {
      dispatch({ type: 'SET_VIEW', view: 'projects' });
      await handleAttachSession({ sessionId });
    },
    onClose: () => {
      dispatch({ type: 'SET_VIEW', view: 'projects' });
    },
  });

  // ========== Keyboard Handlers ==========

  useKeyboard(async (key) => {
    // Don't handle keys when in terminal view (Terminal component handles input)
    if (state.view === 'terminal') {
      return;
    }

    // Handle project creation flow (custom state machine)
    if (projectFlow.type !== 'closed') {
      if (key.name === 'escape') {
        setProjectFlow({ type: 'closed' });
        return;
      }

      if (projectFlow.type === 'repo-select') {
        if (key.name === 'up' || key.raw === 'k') {
          setProjectFlow({
            ...projectFlow,
            selectedIndex: Math.max(0, projectFlow.selectedIndex - 1),
          });
        } else if (key.name === 'down' || key.raw === 'j') {
          setProjectFlow({
            ...projectFlow,
            selectedIndex: Math.min(projectFlow.repos.length - 1, projectFlow.selectedIndex + 1),
          });
        } else if (key.name === 'return') {
          const repo = projectFlow.repos[projectFlow.selectedIndex];
          if (repo) {
            await handleSelectRepo(repo);
          }
        }
        return;
      }

      if (projectFlow.type === 'onboarding') {
        const step = projectFlow.steps[projectFlow.currentStep];

        if (step.type === 'info' || step.type === 'confirm') {
          // For info/confirm steps, Enter to continue (if not checking)
          if (key.name === 'return' && projectFlow.confirmStatus !== 'checking') {
            await advanceOnboardingStep();
          }
          return;
        }

        if (step.type === 'input' || step.type === 'secret') {
          if (key.name === 'return') {
            await advanceOnboardingStep();
          } else if (key.name === 'backspace') {
            setProjectFlow({
              ...projectFlow,
              inputValue: projectFlow.inputValue.slice(0, -1),
            });
          } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
            setProjectFlow({
              ...projectFlow,
              inputValue: projectFlow.inputValue + key.raw,
            });
          }
          return;
        }
        return;
      }

      // For loading/cloning/creating states, just wait (escape to cancel handled above)
      return;
    }

    // Handle workspace creation flow (custom state machine)
    if (workspaceFlow.type !== 'closed') {
      if (key.name === 'escape') {
        setWorkspaceFlow({ type: 'closed' });
        return;
      }

      if (workspaceFlow.type === 'source-select') {
        if (key.name === 'up' || key.raw === 'k') {
          setWorkspaceFlow({
            ...workspaceFlow,
            selectedIndex: Math.max(0, workspaceFlow.selectedIndex - 1),
          });
        } else if (key.name === 'down' || key.raw === 'j') {
          setWorkspaceFlow({
            ...workspaceFlow,
            selectedIndex: Math.min(workspaceFlow.options.length - 1, workspaceFlow.selectedIndex + 1),
          });
        } else if (key.name === 'return') {
          const selected = workspaceFlow.options[workspaceFlow.selectedIndex];
          if (selected) {
            await handleSourceSelect(selected.value);
          }
        }
        return;
      }

      if (workspaceFlow.type === 'branch-select') {
        if (key.name === 'up' || key.raw === 'k') {
          setWorkspaceFlow({
            ...workspaceFlow,
            selectedIndex: Math.max(0, workspaceFlow.selectedIndex - 1),
          });
        } else if (key.name === 'down' || key.raw === 'j') {
          setWorkspaceFlow({
            ...workspaceFlow,
            selectedIndex: Math.min(workspaceFlow.branches.length - 1, workspaceFlow.selectedIndex + 1),
          });
        } else if (key.name === 'return') {
          const branch = workspaceFlow.branches[workspaceFlow.selectedIndex];
          if (branch) {
            await handleBranchSelect(branch);
          }
        }
        return;
      }

      if (workspaceFlow.type === 'linear-select') {
        if (key.name === 'up' || key.raw === 'k') {
          setWorkspaceFlow({
            ...workspaceFlow,
            selectedIndex: Math.max(0, workspaceFlow.selectedIndex - 1),
          });
        } else if (key.name === 'down' || key.raw === 'j') {
          setWorkspaceFlow({
            ...workspaceFlow,
            selectedIndex: Math.min(workspaceFlow.issues.length - 1, workspaceFlow.selectedIndex + 1),
          });
        } else if (key.name === 'return') {
          const issue = workspaceFlow.issues[workspaceFlow.selectedIndex];
          if (issue) {
            await handleLinearSelect(issue);
          }
        }
        return;
      }

      if (workspaceFlow.type === 'manual-input') {
        if (key.name === 'return') {
          await handleManualSubmit(workspaceFlow.inputValue);
        } else if (key.name === 'backspace') {
          setWorkspaceFlow({
            ...workspaceFlow,
            inputValue: workspaceFlow.inputValue.slice(0, -1),
            error: null,
          });
        } else if (key.raw && key.raw.length === 1 && !key.ctrl && !key.meta) {
          setWorkspaceFlow({
            ...workspaceFlow,
            inputValue: workspaceFlow.inputValue + key.raw,
            error: null,
          });
        }
        return;
      }

      // For loading/creating states, just wait (escape to cancel handled above)
      return;
    }

    // Don't handle keys when flow is open
    if (flow.isOpen) {
      // Handle confirm modal with y/n shortcuts
      if (flow.flow.type === 'confirm') {
        if (key.raw === 'y' || key.name === 'return') {
          await flow.handleConfirm();
        } else if (key.raw === 'n' || key.name === 'escape') {
          flow.handleCancel();
        }
        return;
      }

      // Handle other modals
      if (key.name === 'escape') {
        flow.handleCancel();
      } else if (key.name === 'return') {
        await flow.handleConfirm();
      } else if (key.name === 'up' || key.raw === 'k') {
        flow.moveUp();
      } else if (key.name === 'down' || key.raw === 'j') {
        flow.moveDown();
      } else if (key.raw && isFlowInput(flow.flow)) {
        // Handle text input (now properly typed)
        if (key.name === 'backspace') {
          const current = flow.flow.inputValue || '';
          flow.handleInput(current.slice(0, -1));
        } else if (key.raw.length === 1 && !key.ctrl && !key.meta) {
          const current = flow.flow.inputValue || '';
          flow.handleInput(current + key.raw);
        }
      } else if (key.raw && isFlowConfirmTyped(flow.flow)) {
        // Handle typed confirmation input (now properly typed)
        if (key.name === 'backspace') {
          const current = flow.flow.inputValue || '';
          flow.handleInput(current.slice(0, -1));
        } else if (key.raw.length === 1 && !key.ctrl && !key.meta) {
          const current = flow.flow.inputValue || '';
          flow.handleInput(current + key.raw);
        }
      }
      return;
    }

    // Global shortcuts
    if (key.raw === '?' || (key.shift && key.raw === '?')) {
      flow.showHelp(getDefaultShortcuts());
      return;
    }

    if (key.raw === 'q' || (key.ctrl && key.raw === 'c')) {
      onQuit?.();
      return;
    }

    // Inbox shortcut (global) - open full-screen inbox view
    if (key.raw === 'i') {
      dispatch({ type: 'SET_VIEW', view: 'inbox' });
      return;
    }

    // Inbox view keyboard handling
    if (state.view === 'inbox') {
      if (key.name === 'escape') {
        if (inboxProps.isViewingThread) {
          inboxProps.closeThread();
        } else {
          inboxProps.close();
        }
      } else if (key.name === 'up' || key.raw === 'k') {
        inboxProps.moveUp();
      } else if (key.name === 'down' || key.raw === 'j') {
        inboxProps.moveDown();
      } else if (key.name === 'return') {
        await inboxProps.openThread();
      } else if (key.raw === 'x') {
        if (inboxProps.isViewingThread) {
          await inboxProps.deleteThread();
        } else {
          await inboxProps.deleteSelected();
        }
      } else if (key.raw === 'c') {
        await inboxProps.clearAll();
      } else if (key.raw === 'a' && inboxProps.isViewingThread) {
        await inboxProps.attachToSession();
      }
      return;
    }

    // View-specific shortcuts
    if (state.view === 'machines') {
      if (key.name === 'up' || key.raw === 'k') {
        machineListProps.moveUp();
      } else if (key.name === 'down' || key.raw === 'j') {
        machineListProps.moveDown();
      } else if (key.name === 'return') {
        machineListProps.connectSelected();
      } else if (key.raw === 'r') {
        machineListProps.refresh();
      }
      return;
    }

    if (state.view === 'projects') {
      // Panel switching
      if (key.name === 'tab') {
        dispatch({ type: 'SWITCH_PANEL' });
        return;
      }

      if (state.panelFocus === 'projects') {
        if (key.name === 'up' || key.raw === 'k') {
          projectListProps.moveUp();
        } else if (key.name === 'down' || key.raw === 'j') {
          projectListProps.moveDown();
        } else if (key.name === 'return') {
          projectListProps.selectProject();
        } else if (key.raw === 'n') {
          // In projects panel, 'n' creates new project
          await handleNewProjectFlow();
        } else if (key.raw === 'd') {
          projectListProps.deleteSelected();
        } else if (key.raw === 'r') {
          projectListProps.refresh();
        }
      } else {
        // Workspaces panel
        if (key.name === 'up' || key.raw === 'k') {
          spacesBrowserProps.moveUp();
        } else if (key.name === 'down' || key.raw === 'j') {
          spacesBrowserProps.moveDown();
        } else if (key.name === 'return') {
          // Let the hook handle it:
          // - workspace: toggle expand/collapse
          // - session: attach via onAttachSession
          // - new-session: create via onAttachSession
          spacesBrowserProps.activateSelected();
        } else if (key.raw === 'n') {
          // In workspaces panel, 'n' always creates new workspace
          // Sessions are created via expand (Enter) → "+ New session" (Enter)
          handleNewWorkspaceFlow();
        } else if (key.raw === 'd') {
          // Delete workspace
          const selected = spacesBrowserProps.selectedItem;
          if (selected?.type === 'workspace') {
            const workspace = state.workspaces.find(w => w.name === selected.workspace.id);
            if (workspace) {
              handleDeleteWorkspace(workspace);
            }
          }
        } else if (key.raw === 'x') {
          // Kill session
          const selected = spacesBrowserProps.selectedItem;
          if (selected?.type === 'session') {
            handleDeleteSession(selected.session.id, selected.session.name);
          }
        } else if (key.raw === 'r') {
          spacesBrowserProps.refresh();
        } else if (key.name === 'escape') {
          dispatch({ type: 'SET_PANEL_FOCUS', focus: 'projects' });
        }
      }
      return;
    }
  });

  // ========== Render ==========

  // Loading state
  if (state.isLoading) {
    return (
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={COLORS.loading}>Loading...</text>
      </box>
    );
  }

  // Error state
  if (state.error) {
    return (
      <box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={COLORS.error}>Error: {state.error}</text>
        <text fg={COLORS.textDim} marginTop={1}>Press 'q' to quit</text>
      </box>
    );
  }

  // Machine list view (remote mode)
  if (state.view === 'machines') {
    return (
      <box flexDirection="column" flexGrow={1}>
        <MachineListTUI {...machineListProps} focused={true} />
        <StatusBar hint="[↑↓] Navigate  [Enter] Connect  [r] Refresh  [?] Help  [q] Quit" />
        <FlowTUI flow={flow} />
      </box>
    );
  }

  // Terminal view (attached to session)
  if (state.view === 'terminal' && state.attachedSession) {
    return (
      <Terminal
        session={state.attachedSession}
        onDetach={handleTerminalDetach}
        onExit={handleTerminalExit}
        onKicked={handleTerminalKicked}
        onError={handleTerminalError}
      />
    );
  }

  // Inbox view (full-screen)
  if (state.view === 'inbox') {
    return <InboxTUI {...inboxProps} focused={true} />;
  }

  // Main project/workspace view
  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      {/* ASCII Art Header */}
      <box flexDirection="row" width="100%" height={13}>
        {/* ASCII art on left - fixed width */}
        <box flexDirection="column" alignItems="flex-start" paddingLeft={1} width={68}>
          {ASCII_LINES.map((line, i) => (
            <text key={i} fg={line.color}>{line.text}</text>
          ))}
        </box>

        {/* Status & Notifications on right */}
        <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingTop={1}>
          {/* Daemon status line */}
          <box flexDirection="row" gap={2}>
            <text fg={daemonStatus.tmux.running ? COLORS.title : COLORS.textDim}>
              tmux: {daemonStatus.tmux.running ? '●' : '○'} {daemonStatus.tmux.sessions ?? 0} sessions
            </text>
            <text fg={daemonStatus.serve.running ? COLORS.title : COLORS.textDim}>
              relay: {formatRelayStatus(daemonStatus.serve.relayStatus)} {daemonStatus.serve.running ? (daemonStatus.serve.clients ?? 0) + ' clients' : 'off'}
            </text>
          </box>

          {/* Uptime info */}
          {(daemonStatus.tmux.running || daemonStatus.serve.running) && (
            <text fg={COLORS.textDim}>
              {daemonStatus.tmux.uptime ? `tmux: ${formatUptime(daemonStatus.tmux.uptime)}` : ''}
              {daemonStatus.tmux.uptime && daemonStatus.serve.uptime ? '  ' : ''}
              {daemonStatus.serve.uptime ? `serve: ${formatUptime(daemonStatus.serve.uptime)}` : ''}
            </text>
          )}

          {/* Version mismatch warning */}
          {daemonStatus.versionMismatch && (
            <text fg={COLORS.error}>⚠ Version mismatch - restart daemons</text>
          )}

          {/* Notifications */}
          <box marginTop={1}>
            {state.unreadCount > 0 ? (
              <box flexDirection="column">
                <text fg={COLORS.loading}>{'📥'} {state.unreadCount} notification{state.unreadCount > 1 ? 's' : ''}</text>
                <text fg={COLORS.textDim}>[i] view inbox</text>
              </box>
            ) : (
              <text fg={COLORS.textDim}>No notifications</text>
            )}
          </box>
        </box>
      </box>

      {/* Main content - two panel layout */}
      <box flexDirection="row" flexGrow={1} width="100%" gap={1} paddingLeft={1} paddingRight={1}>
        <ProjectListTUI {...projectListProps} focused={state.panelFocus === 'projects'} />
        <SpacesBrowserTUI {...spacesBrowserProps} focused={state.panelFocus === 'workspaces'} />
      </box>

      {/* Status bar */}
      <StatusBar
        hint={state.panelFocus === 'projects'
          ? '[Tab] Switch  [Enter] Select  [n] New Project  [d] Delete  [?] Help  [q] Quit'
          : '[Tab] Switch  [Enter] Open/Join  [n] New Workspace  [d] Delete  [x] Kill  [?] Help  [q] Quit'
        }
      />

      {/* Flow modal overlay */}
      <FlowTUI flow={flow} />

      {/* Workspace creation flow modal */}
      <WorkspaceFlowModal flow={workspaceFlow} />

      {/* Project creation flow modal */}
      <ProjectFlowModal flow={projectFlow} />
    </box>
  );
}

// ============================================================================
// Workspace Flow Modal Component
// ============================================================================

function WorkspaceFlowModal({ flow }: { flow: WorkspaceFlowState }) {
  if (flow.type === 'closed') {
    return null;
  }

  const modalWidth = 60;
  // Calculate modal height based on content:
  // - source-select: title + spacer + (options * 2 lines each) + (spacers between) + spacer + hint + border/padding
  // - branch/linear-select: title + items (scrollable) + hint + border/padding
  // - manual-input: title + label + input box + error? + hint + border/padding
  const modalHeight = flow.type === 'manual-input' ? 10 :
                      flow.type === 'loading' || flow.type === 'creating' ? 6 :
                      flow.type === 'source-select' ? 6 + flow.options.length * 3 :
                      flow.type === 'branch-select' ? Math.min(16, 6 + flow.branches.length) :
                      flow.type === 'linear-select' ? Math.min(16, 6 + flow.issues.length) : 10;

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
    >
      <box
        flexDirection="column"
        width={modalWidth}
        height={modalHeight}
        borderStyle="rounded"
        borderColor={COLORS.borderFocused}
        backgroundColor="#1a1a2e"
        padding={1}
      >
        {/* Loading state */}
        {flow.type === 'loading' && (
          <>
            <text fg={COLORS.title} height={1}>{flow.title}</text>
            <text fg={COLORS.loading} height={1} marginTop={1}>{flow.message}</text>
          </>
        )}

        {/* Creating state */}
        {flow.type === 'creating' && (
          <>
            <text fg={COLORS.title} height={1}>Creating Workspace</text>
            <text fg={COLORS.loading} height={1} marginTop={1}>Creating {flow.workspaceName}...</text>
          </>
        )}

        {/* Source selection */}
        {flow.type === 'source-select' && (
          <>
            <text fg={COLORS.title} height={1}>Create Workspace From</text>
            <box height={1} />
            {flow.options.flatMap((opt, i) => [
              <text key={`${opt.value}-label`} fg={i === flow.selectedIndex ? COLORS.selected : COLORS.text} height={1}>
                {i === flow.selectedIndex ? '▸ ' : '  '}{opt.label}
              </text>,
              <text key={`${opt.value}-desc`} fg={COLORS.textDim} height={1} paddingLeft={4}>{opt.description}</text>,
              i < flow.options.length - 1 ? <box key={`${opt.value}-spacer`} height={1} /> : null,
            ].filter(Boolean))}
            <box height={1} />
            <text fg={COLORS.textDim} height={1}>[↑↓] Navigate  [Enter] Select  [Esc] Cancel</text>
          </>
        )}

        {/* Branch selection */}
        {flow.type === 'branch-select' && (
          <>
            <text fg={COLORS.title} height={1}>Select Branch</text>
            <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
              {flow.branches.slice(
                Math.max(0, flow.selectedIndex - 5),
                Math.max(0, flow.selectedIndex - 5) + 10
              ).map((branch, i) => {
                const actualIndex = Math.max(0, flow.selectedIndex - 5) + i;
                return (
                  <text key={branch} height={1} fg={actualIndex === flow.selectedIndex ? COLORS.selected : COLORS.text}>
                    {actualIndex === flow.selectedIndex ? '▸ ' : '  '}{branch}
                  </text>
                );
              })}
            </box>
            <text fg={COLORS.textDim} height={1}>[↑↓] Navigate  [Enter] Select  [Esc] Cancel</text>
          </>
        )}

        {/* Linear issue selection */}
        {flow.type === 'linear-select' && (
          <>
            <text fg={COLORS.title} height={1}>Select Linear Issue</text>
            <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
              {flow.issues.slice(
                Math.max(0, flow.selectedIndex - 5),
                Math.max(0, flow.selectedIndex - 5) + 10
              ).map((issue, i) => {
                const actualIndex = Math.max(0, flow.selectedIndex - 5) + i;
                const label = `${issue.identifier} - ${issue.title.slice(0, 40)}${issue.title.length > 40 ? '...' : ''}`;
                return (
                  <text key={issue.id} height={1} fg={actualIndex === flow.selectedIndex ? COLORS.selected : COLORS.text}>
                    {actualIndex === flow.selectedIndex ? '▸ ' : '  '}{label}
                  </text>
                );
              })}
            </box>
            <text fg={COLORS.textDim} height={1}>[↑↓] Navigate  [Enter] Select  [Esc] Cancel</text>
          </>
        )}

        {/* Manual input */}
        {flow.type === 'manual-input' && (
          <>
            <text fg={COLORS.title} height={1}>New Workspace</text>
            <text fg={COLORS.text} height={1} marginTop={1}>Enter workspace name:</text>
            <box
              marginTop={1}
              borderStyle="rounded"
              borderColor={COLORS.border}
              padding={0}
              width="100%"
            >
              <text fg={COLORS.text} height={1}>{flow.inputValue || ' '}_</text>
            </box>
            {flow.error && <text fg={COLORS.error} height={1} marginTop={1}>{flow.error}</text>}
            <text fg={COLORS.textDim} height={1} marginTop={1}>[Enter] Create  [Esc] Cancel</text>
          </>
        )}
      </box>
    </box>
  );
}

// ============================================================================
// Project Flow Modal Component
// ============================================================================

function ProjectFlowModal({ flow }: { flow: ProjectFlowState }) {
  if (flow.type === 'closed') {
    return null;
  }

  const modalWidth = 70;
  const modalHeight = flow.type === 'repo-select' ? 18 :
                      flow.type === 'onboarding' ? 14 :
                      8;

  return (
    <box
      position="absolute"
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
    >
      <box
        flexDirection="column"
        width={modalWidth}
        height={modalHeight}
        borderStyle="rounded"
        borderColor={COLORS.borderFocused}
        backgroundColor="#1a1a2e"
        padding={1}
      >
        {/* Loading repos state */}
        {flow.type === 'loading-repos' && (
          <>
            <text fg={COLORS.title} height={1}>New Project</text>
            <text fg={COLORS.loading} height={1} marginTop={1}>Fetching repositories...</text>
          </>
        )}

        {/* Repository selection */}
        {flow.type === 'repo-select' && (
          <>
            <text fg={COLORS.title} height={1}>Select Repository</text>
            <box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
              {flow.repos.slice(
                Math.max(0, flow.selectedIndex - 5),
                Math.max(0, flow.selectedIndex - 5) + 10
              ).map((repo, i) => {
                const actualIndex = Math.max(0, flow.selectedIndex - 5) + i;
                return (
                  <text key={repo} height={1} fg={actualIndex === flow.selectedIndex ? COLORS.selected : COLORS.text}>
                    {actualIndex === flow.selectedIndex ? '▸ ' : '  '}{repo}
                  </text>
                );
              })}
            </box>
            <text fg={COLORS.textDim} height={1}>[↑↓] Navigate  [Enter] Select  [Esc] Cancel</text>
          </>
        )}

        {/* Cloning state */}
        {flow.type === 'cloning' && (
          <>
            <text fg={COLORS.title} height={1}>Cloning Repository</text>
            <text fg={COLORS.loading} height={1} marginTop={1}>Cloning {flow.repo}...</text>
          </>
        )}

        {/* Onboarding steps */}
        {flow.type === 'onboarding' && (() => {
          const step = flow.steps[flow.currentStep];
          if (!step) return null;

          return (
            <>
              <text fg={COLORS.title} height={1}>
                {flow.bundleName} Setup ({flow.currentStep + 1}/{flow.steps.length})
              </text>
              <text fg={COLORS.selected} height={1} marginTop={1}>{step.title}</text>
              {step.description && (
                <text fg={COLORS.textDim} height={1} marginTop={1}>{step.description}</text>
              )}

              {/* Info step */}
              {step.type === 'info' && (
                <text fg={COLORS.text} height={1} marginTop={1}>Press Enter to continue</text>
              )}

              {/* Confirm step */}
              {step.type === 'confirm' && (
                <box flexDirection="column" marginTop={1}>
                  {flow.confirmStatus === 'checking' && (
                    <text fg={COLORS.loading} height={1}>⏳ Checking...</text>
                  )}
                  {flow.confirmStatus === 'found' && (
                    <text fg={COLORS.title} height={1}>✅ Found</text>
                  )}
                  {flow.confirmStatus === 'missing' && (
                    <>
                      <text fg={COLORS.error} height={1}>❌ Not found</text>
                      {(step as { installUrl?: string }).installUrl && (
                        <text fg={COLORS.selected} height={1} marginTop={1}>
                          Install: {(step as { installUrl: string }).installUrl}
                        </text>
                      )}
                    </>
                  )}
                  {flow.confirmStatus !== 'checking' && (
                    <text fg={COLORS.text} height={1} marginTop={1}>Press Enter to continue</text>
                  )}
                </box>
              )}

              {/* Input step */}
              {step.type === 'input' && (
                <box flexDirection="column" marginTop={1}>
                  <box
                    borderStyle="rounded"
                    borderColor={COLORS.border}
                    padding={0}
                    width="100%"
                  >
                    <text fg={COLORS.text} height={1}>{flow.inputValue || ' '}_</text>
                  </box>
                </box>
              )}

              {/* Secret step */}
              {step.type === 'secret' && (
                <box flexDirection="column" marginTop={1}>
                  <box
                    borderStyle="rounded"
                    borderColor={COLORS.border}
                    padding={0}
                    width="100%"
                  >
                    <text fg={COLORS.text} height={1}>{'•'.repeat(flow.inputValue.length) || ' '}_</text>
                  </box>
                  <text fg={COLORS.textDim} height={1} marginTop={1}>Value will be stored securely in OS keychain</text>
                </box>
              )}

              <text fg={COLORS.textDim} height={1} marginTop={1}>
                [Enter] {flow.currentStep === flow.steps.length - 1 ? 'Finish' : 'Next'}  [Esc] Cancel
              </text>
            </>
          );
        })()}

        {/* Creating state */}
        {flow.type === 'creating' && (
          <>
            <text fg={COLORS.title} height={1}>Creating Project</text>
            <text fg={COLORS.loading} height={1} marginTop={1}>Setting up {flow.projectName}...</text>
          </>
        )}
      </box>
    </box>
  );
}

// ============================================================================
// Status Bar Component
// ============================================================================

function StatusBar({ hint }: { hint: string }) {
  return (
    <box width="100%" height={1} backgroundColor={COLORS.statusBar}>
      <text fg={COLORS.textDim} paddingLeft={1}>{hint}</text>
    </box>
  );
}

// ============================================================================
// Entry Point
// ============================================================================

/** @deprecated Use RelayConfig instead */
export type TUIRelayConfig = RelayConfig;

export async function launchTUI(relayConfig?: RelayConfig): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
  });
  const root = createRoot(renderer);

  // Clean exit handler
  const handleQuit = () => {
    renderer.destroy();
    process.exit(0);
  };

  // Handle SIGINT
  process.on('SIGINT', handleQuit);

  // Cleanup on exit
  process.on('exit', () => {
    // Reset terminal state
    process.stdout.write('\x1b[?25h'); // Show cursor
    process.stdout.write('\x1b[?1049l'); // Exit alternate screen
    process.stdout.write('\x1b[0m'); // Reset colors
  });

  root.render(<App relayConfig={relayConfig} onQuit={handleQuit} />);
  renderer.start();
}
