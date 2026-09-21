import { rpcErrors } from '@gitspace/protocol';
import { currentAgentExecutionFailure, determineAgentState } from '@gitspace/protocol-agent';
import { deriveWorkspaceStatusSummary, type WorkspaceAgentState } from '@gitspace/protocol-workspace';
import { err, ok } from 'result-rpc';
import { eq } from 'drizzle-orm';
import type { ArtifactCapability, LocalArtifactResolver, LocalArtifactEntry } from './artifacts.js';
import type { GitSpaceDatabase } from './database.js';
import type { AppendFactEvent } from './fact-events.js';
import { emptyRelations, emptyStack, validateStack, type WorkspaceRelations, type WorkspaceStack } from '@gitspace/protocol-workspace';
import { agentSessions, factEvents, type AgentSession, type Workspace } from './schema.js';

export interface WorkspaceStackContext {
  relations: Map<string, WorkspaceRelations>;
  stacks: Map<string, WorkspaceStack>;
}

function operationFailed(operation: string) {
  return rpcErrors.operationFailed({ operation, message: `Unable to ${operation}` });
}

function renderState(session: AgentSession) {
  return determineAgentState(
    session.activity,
    session.state === 'closed' ? { closedAt: session.updatedAt } : {},
    currentAgentExecutionFailure(session.health),
  );
}

/** Sink for project facts; on a machine this is the cloud project log writer. */
export interface ProjectEventWriter {
  append(input: AppendFactEvent): void;
  /** Called after state and its facts commit in the same local transaction. */
  committed?(): void;
}

export class GitSpaceHandlers {
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly artifacts: LocalArtifactResolver,
    readonly events: ProjectEventWriter,
  ) {}

  bootstrap(input: { projectId: string; workspaceId: string | null }) {
    const project = this.database.getProject(input.projectId);
    if (!project) return err(rpcErrors.projectNotFound({ projectId: input.projectId }));
    const baseSpace = this.database.getBaseSpace(project.id);
    if (!baseSpace) return err(operationFailed('load base space'));
    const workspaces = this.database.listWorkspaces(project.id);
    const stack = this.stackContext(project.id, workspaces);
    const selected = input.workspaceId === null
      ? baseSpace
      : workspaces.find((workspace) => workspace.id === input.workspaceId) ?? null;
    if (!selected) {
      return input.workspaceId === null
        ? err(operationFailed('load base space'))
        : err(rpcErrors.workspaceNotFound({ workspaceId: input.workspaceId }));
    }
    const mainAgent = this.database.orm.select().from(agentSessions)
      .where(eq(agentSessions.spaceId, selected.id)).get() ?? null;
    const capability: Extract<ArtifactCapability, { kind: 'project' }> = {
      kind: 'project',
      projectId: project.id,
      ...(selected.kind === 'worktree' ? { currentWorkspaceId: selected.id } : {}),
    };
    const baseArtifacts = this.artifacts.list(capability, 'local://base/');
    if (baseArtifacts.status === 'error') return err(operationFailed('load base artifacts'));
    const workspaceArtifacts = selected.kind === 'worktree'
      ? this.artifacts.list(capability, 'local://workspace/')
      : ok([] as LocalArtifactEntry[]);
    if (workspaceArtifacts.status === 'error') return err(operationFailed('load workspace artifacts'));
    return ok({
      project: {
        id: project.id,
        name: project.name,
        repositoryPath: this.database.getBaseSpace(project.id)!.rootPath,
        baseBranch: project.baseBranch,
        connected: true,
      },
      workspaces: workspaces.map((workspace) => this.workspaceView(workspace, stack)),
      baseSpace: this.baseSpaceView(baseSpace),
      mainAgent: mainAgent ? {
        id: mainAgent.id,
        projectId: selected.projectId,
        workspaceId: selected.kind === 'worktree' ? selected.id : null,
        scope: selected.kind === 'worktree' ? 'workspace' as const : 'project' as const,
        ompSessionId: mainAgent.ompSessionId,
        state: mainAgent.state,
        controlsAvailable: false,
        lastEventOffset: mainAgent.lastEventOffset,
        resumePending: mainAgent.resumePending,
        createdAt: new Date(mainAgent.createdAt),
        activity: mainAgent.activity,
        renderState: renderState(mainAgent),
        health: mainAgent.health,
        updatedAt: new Date(mainAgent.updatedAt),
      } : null,
      artifacts: [...baseArtifacts.value, ...workspaceArtifacts.value],
    });
  }

  possessSpace(input: { spaceId: string; holderId: string }) {
    const space = this.database.getSpace(input.spaceId);
    if (!space) return err(rpcErrors.workspaceNotFound({ workspaceId: input.spaceId }));
    const result = this.database.orm.transaction((tx) => {
      const possessed = this.database.possessSpace(input.spaceId, input.holderId);
      if (possessed.status === 'error') {
        const current = this.database.getSpacePlacement(input.spaceId);
        return current
          ? err(rpcErrors.workspacePossessed({ workspaceId: input.spaceId, holderId: current.holderId, generation: current.generation }))
          : err(rpcErrors.workspaceNotFound({ workspaceId: input.spaceId }));
      }
      tx.insert(factEvents).values({ projectId: space.projectId, scope: 'workspace', entity: 'space', entityId: space.id, revision: possessed.value.generation, operation: 'updated', payload: { placement: { holderId: possessed.value.holderId, generation: possessed.value.generation } }, createdAt: new Date().toISOString() }).run();
      return ok(possessed.value);
    });
    this.events.committed?.();
    return result;
  }



  baseSpaceView(space: NonNullable<ReturnType<GitSpaceDatabase['getBaseSpace']>>) {
    const mainAgent = this.database.orm.select().from(agentSessions).where(eq(agentSessions.spaceId, space.id)).get();
    const agentState: WorkspaceAgentState | null = mainAgent ? renderState(mainAgent) : null;
    return {
      id: space.id,
      projectId: space.projectId,
      kind: 'base' as const,
      name: space.name,
      branch: space.branch,
      closedAt: space.closedAt ? new Date(space.closedAt) : null,
      possessedBy: space.placementState === 'closed' ? null : space.holderId,
      spaceGeneration: space.generation,
      status: deriveWorkspaceStatusSummary({ agents: agentState && mainAgent ? [{ state: agentState, failure: currentAgentExecutionFailure(mainAgent.health), compaction: mainAgent.activity.reasons.find((reason) => reason.kind === 'compacting') }] : [] }),
    };
  }
  /** Relations and stack validations for every workspace in a project, computed once so list views share one graph. */
  stackContext(projectId: string, workspaces: Workspace[] = this.database.listWorkspaces(projectId)): WorkspaceStackContext {
    const relations = this.database.listSpaceRelations(projectId);
    const stacks = validateStack(workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      phase: workspace.phase,
      closedAt: workspace.closedAt,
      relations: relations.get(workspace.id) ?? emptyRelations(),
    })));
    return { relations, stacks };
  }

  workspaceView(workspace: Workspace, stack: WorkspaceStackContext = this.stackContext(workspace.projectId)) {
    const possession = this.database.getWorkspacePossession(workspace.id);
    const mainAgent = this.database.orm.select().from(agentSessions)
      .where(eq(agentSessions.spaceId, workspace.id)).get();
    const agentState: WorkspaceAgentState | null = mainAgent ? renderState(mainAgent) : null;
    return {
      id: workspace.id,
      projectId: workspace.projectId,
      projectName: this.database.getProject(workspace.projectId)?.name ?? workspace.projectId,
      name: workspace.name,
      branch: workspace.branch,
      rootPath: workspace.rootPath,
      phase: workspace.phase,
      closedAt: workspace.closedAt ? new Date(workspace.closedAt) : null,
      possessedBy: possession?.holderId ?? null,
      possessionGeneration: possession?.generation ?? null,
      spaceGeneration: workspace.generation,
      status: deriveWorkspaceStatusSummary({ agents: agentState && mainAgent ? [{ state: agentState, failure: currentAgentExecutionFailure(mainAgent.health), compaction: mainAgent.activity.reasons.find((reason) => reason.kind === 'compacting') }] : [] }),
      relations: stack.relations.get(workspace.id) ?? emptyRelations(),
      stack: stack.stacks.get(workspace.id) ?? emptyStack(),
    };
  }
}
