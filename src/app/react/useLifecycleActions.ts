import type { UseFlowReturn } from '../../components/Flow.js';
import type {
  CreateProjectParams,
  CreateWorkspaceParams,
  DeleteProjectParams,
  FinalizeProjectParams,
  PreparedProjectResult,
} from '../../session/backend.js';
import type { AppClient, AppClientContext } from '../client/index.js';
import { useAppClient } from './useAppClient.js';
import {
  useLifecycleController,
  type ProjectCreatedDetails,
  type UseLifecycleControllerResult,
  type WorkspaceCreatedDetails,
} from '../session/useLifecycleController.js';

export interface UseLifecycleActionsOptions {
  client?: AppClient | AppClientContext | null;
  backendKey: string;
  flow: Pick<UseFlowReturn, 'showLoading' | 'showSelect' | 'showInput' | 'showConfirmTyped' | 'showMessage' | 'showWizard' | 'close'>;
  getProjectNames: () => string[];
  refreshProjects?: () => void | Promise<void>;
  refreshWorkspaces?: () => void | Promise<void>;
  refreshSessions?: () => void | Promise<void>;
	  onProjectCreated?: (details: ProjectCreatedDetails) => void | Promise<void>;
	  onWorkspaceCreating?: (details: WorkspaceCreatedDetails) => void | Promise<void>;
	  onWorkspaceCreated?: (details: WorkspaceCreatedDetails) => void | Promise<void>;
	  onWorkspaceCreateFailed?: (details: WorkspaceCreatedDetails, error: unknown) => void | Promise<void>;
	  showCreateWorkspaceSuccessMessage?: boolean;
  openCreateGoalFlow?: (projectName?: string | null) => void;
}

export function useLifecycleActions(options: UseLifecycleActionsOptions): UseLifecycleControllerResult {
  const client = useAppClient(options.client ?? null);

  return useLifecycleController({
    flow: options.flow,
    listGithubRepos: async (org?: string) => {
      const result = await client.lifecycle.listGithubRepos(options.backendKey, org);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
      return result.value;
    },
    listRemoteBranches: async (projectName: string) => {
      const result = await client.lifecycle.listRemoteBranches(options.backendKey, projectName);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
      return result.value;
    },
    listLinearIssues: async (projectName: string) => {
      const result = await client.lifecycle.listLinearIssues(options.backendKey, projectName);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
      return result.value;
    },
    createProject: async (params: CreateProjectParams) => {
      const result = await client.lifecycle.createProject(options.backendKey, params);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
    },
    prepareProjectCreation: async (params: CreateProjectParams): Promise<PreparedProjectResult> => {
      const result = await client.lifecycle.prepareProjectCreation(options.backendKey, params);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
      return result.value;
    },
    finalizeProjectCreation: async (params: FinalizeProjectParams) => {
      const result = await client.lifecycle.finalizeProjectCreation(options.backendKey, params);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
    },
    cancelProjectCreation: async (projectName: string) => {
      const result = await client.lifecycle.cancelProjectCreation(options.backendKey, projectName);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
    },
    createWorkspace: async (params: CreateWorkspaceParams) => {
      const result = await client.lifecycle.createWorkspace(options.backendKey, params);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
    },
    deleteProject: async (projectName: string, params?: DeleteProjectParams) => {
      const result = await client.lifecycle.deleteProject(options.backendKey, projectName, params);
      if (!result.ok) throw result.error.cause ?? new Error(result.error.message);
    },
    openCreateGoalFlow: options.openCreateGoalFlow,
    getProjectNames: options.getProjectNames,
    refreshProjects: options.refreshProjects ?? (() => undefined),
    refreshWorkspaces: options.refreshWorkspaces ?? (() => undefined),
    refreshSessions: options.refreshSessions,
	    onProjectCreated: options.onProjectCreated,
	    onWorkspaceCreating: options.onWorkspaceCreating,
	    onWorkspaceCreated: options.onWorkspaceCreated,
	    onWorkspaceCreateFailed: options.onWorkspaceCreateFailed,
	    showCreateWorkspaceSuccessMessage: options.showCreateWorkspaceSuccessMessage,
  });
}
