import type {
  CreateProjectParams,
  CreateWorkspaceParams,
  DeleteProjectParams,
  FinalizeProjectParams,
  PreparedProjectResult,
} from '../../session/backend.js';
import type { SessionLinearIssueSummary } from '../../types/lifecycle.js';
import type { AppClientContext } from './context.js';
import { agentSessionFailure, agentSessionSuccess, describeAppClientError, type AgentSessionCommandResult } from './errors.js';

export interface AppLifecycleClient {
  listGithubRepos: (backendKey: string, org?: string) => Promise<AgentSessionCommandResult<string[]>>;
  listRemoteBranches: (backendKey: string, projectName: string) => Promise<AgentSessionCommandResult<string[]>>;
  listLinearIssues: (backendKey: string, projectName: string) => Promise<AgentSessionCommandResult<SessionLinearIssueSummary[]>>;
  createProject: (backendKey: string, params: CreateProjectParams) => Promise<AgentSessionCommandResult<CreateProjectParams>>;
  prepareProjectCreation: (backendKey: string, params: CreateProjectParams) => Promise<AgentSessionCommandResult<PreparedProjectResult>>;
  finalizeProjectCreation: (backendKey: string, params: FinalizeProjectParams) => Promise<AgentSessionCommandResult<FinalizeProjectParams>>;
  cancelProjectCreation: (backendKey: string, projectName: string) => Promise<AgentSessionCommandResult<{ projectName: string }>>;
  createWorkspace: (backendKey: string, params: CreateWorkspaceParams) => Promise<AgentSessionCommandResult<CreateWorkspaceParams>>;
  deleteProject: (backendKey: string, projectName: string, params?: DeleteProjectParams) => Promise<AgentSessionCommandResult<{ projectName: string }>>;
}

export function createAppLifecycleClient(context: AppClientContext): AppLifecycleClient {
  const withBackend = async <T>(backendKey: string, workspaceId: string, run: (backend: NonNullable<ReturnType<typeof context.multi.getBackend>>) => Promise<T>): Promise<AgentSessionCommandResult<T>> => {
    const backend = context.multi.getBackend(backendKey);
    if (!backend) {
      return agentSessionFailure({ code: 'backend-unavailable', message: `Backend ${backendKey} is not available`, workspaceId, backendKey });
    }
    try {
      return agentSessionSuccess(await run(backend));
    } catch (error) {
      return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Lifecycle operation failed'), workspaceId, backendKey, cause: error });
    }
  };

  return {
    listGithubRepos: (backendKey, org) => withBackend(backendKey, '', (backend) => backend.listGithubRepos(org)),
    listRemoteBranches: (backendKey, projectName) => withBackend(backendKey, projectName, (backend) => backend.listRemoteBranches(projectName)),
    listLinearIssues: (backendKey, projectName) => withBackend(backendKey, projectName, (backend) => backend.listLinearIssues(projectName)),
    createProject: async (backendKey, params) => withBackend(backendKey, params.projectName ?? '', async (backend) => {
      await backend.createProject(params);
      await backend.listProjects();
      await backend.listWorkspaces();
      await backend.listSessions();
      return params;
    }),
    prepareProjectCreation: (backendKey, params) => withBackend(backendKey, params.projectName ?? '', async (backend) => {
      if (!backend.prepareProjectCreation) throw new Error('Project preparation unavailable');
      return backend.prepareProjectCreation(params);
    }),
    finalizeProjectCreation: async (backendKey, params) => withBackend(backendKey, params.projectName, async (backend) => {
      if (!backend.finalizeProjectCreation) throw new Error('Project finalization unavailable');
      await backend.finalizeProjectCreation(params);
      await backend.listProjects();
      await backend.listWorkspaces();
      await backend.listSessions();
      return params;
    }),
    cancelProjectCreation: async (backendKey, projectName) => withBackend(backendKey, projectName, async (backend) => {
      if (!backend.cancelProjectCreation) throw new Error('Project cancellation unavailable');
      await backend.cancelProjectCreation(projectName);
      await backend.listProjects();
      await backend.listWorkspaces();
      await backend.listSessions();
      return { projectName };
    }),
    createWorkspace: async (backendKey, params) => withBackend(backendKey, `${params.projectName}:${params.workspaceName}`, async (backend) => {
      await backend.createWorkspace(params);
      await backend.listWorkspaces();
      await backend.listSessions();
      return params;
    }),
    deleteProject: async (backendKey, projectName, params) => withBackend(backendKey, projectName, async (backend) => {
      await backend.deleteProject(projectName, params);
      await backend.listProjects();
      await backend.listWorkspaces();
      await backend.listSessions();
      return { projectName };
    }),
  };
}
