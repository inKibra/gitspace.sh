import { skillUpdateSchema, type GitSpaceRpcContext, type ProjectCronDraft, type McpConnection, type McpConnectionDraft, type ProjectMcpGrant } from '@gitspace/protocol';
import {
  listProjectSecretsContract,
  putProjectSecretContract,
  deleteProjectSecretContract,
  listAccountSecretsContract,
  putAccountSecretContract,
  deleteAccountSecretContract,
  grantAccountSecretContract,
  revokeAccountSecretContract,
  getConfigurationValuesContract,
  putConfigurationValueContract,
  deleteConfigurationValueContract,
  listSkillsContract,
  updateSkillContract,
  listMcpConnectionsContract,
  createMcpConnectionContract,
  updateMcpConnectionContract,
  deleteMcpConnectionContract,
  getMcpConnectionStatusContract,
  listProjectMcpGrantsContract,
  putProjectMcpGrantContract,
  deleteProjectMcpGrantContract,
  listComposioPluginCatalogContract,
  authorizeComposioPluginContract,
  refreshComposioPluginContract,
  listComposioPluginToolsContract,
  updateComposioPluginToolsContract,
  disconnectComposioPluginContract,
  listProjectCronsContract,
  createProjectCronContract,
  updateProjectCronContract,
  deleteProjectCronContract,
  runProjectCronNowContract,
  projectCronHistoryContract,
} from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';
import { ProjectAuthorityDO, UserProjectIndexDO, ProjectMcpGrantNotFoundError, ProjectMcpGrantRevisionConflictError } from './project-authority.js';
import { ProjectSecretsDO } from './project-secrets.js';
import { UserSkillsDO, SkillRevisionConflict } from './user-skills.js';
import { UserMcpConnectionsDO, McpConnectionNotFoundError, McpConnectionRevisionConflictError, McpConnectionValidationError } from './local-mcp.js';
import { ProjectCronsDO, ProjectCronValidationError, ProjectCronNotFoundError, ProjectCronRevisionConflictError, ProjectCronAlreadyRunningError } from './project-crons.js';
import { ComposioPluginGateway } from './composio-plugins.js';
import { signComposioState, type CredentialVaultDO } from './application.js';

function mcpConnectionView(connection: McpConnection) {
  return { ...connection, statusCheckedAt: connection.statusCheckedAt ? new Date(connection.statusCheckedAt) : null, createdAt: new Date(connection.createdAt), updatedAt: new Date(connection.updatedAt) };
}
function projectMcpGrantView(grant: ProjectMcpGrant) {
  return { ...grant, createdAt: new Date(grant.createdAt), updatedAt: new Date(grant.updatedAt) };
}

/** Account management uses canonical authorities, never runtime placement or control-request forwarding. */
export function configurationCloudProcedures(env: Env, userId: string, deviceId: string, origin: string) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const projects = (env.USER_PROJECTS as DurableObjectNamespace<UserProjectIndexDO>).getByName(userId);
  const secrets = (env.PROJECT_SECRETS as DurableObjectNamespace<ProjectSecretsDO>).getByName(userId);
  const skills = (env.USER_SKILLS as DurableObjectNamespace<UserSkillsDO>).getByName(userId);
  const connections = (env.USER_MCP_CONNECTIONS as DurableObjectNamespace<UserMcpConnectionsDO>).getByName(userId);
  const vault = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(userId);
  const project = async (projectId: string) => {
    if (!(await projects.list()).some(entry => entry.id === projectId)) throw new Error('Project does not belong to this account');
    return (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`${userId}:${projectId}`);
  };
  const values = async (projectId?: string) => ({ global: await projects.getEnvironmentValues(), project: projectId === undefined ? {} : await (await project(projectId)).getEnvironmentValues() });
  const changeValue = async (scope: 'global' | 'project', projectId: string | undefined, name: string, value: string | null) => {
    if (projectId !== undefined) await project(projectId);
    if (scope === 'global') await projects.setEnvironmentValue(name, value);
    else {
      if (!projectId) throw new Error('Project scope requires an explicit project');
      await (await project(projectId)).setEnvironmentValue(name, value);
    }
  };
  const connection = async (id: string) => {
    const value = await connections.get(userId, id);
    if (!value) throw new McpConnectionNotFoundError(id);
    return value;
  };
  const composioConnection = async (id: string) => {
    const value = await connection(id);
    if (value.transport.type !== 'composio') throw new Error('Connection is not a Composio plugin');
    return { ...value, transport: value.transport };
  };
  const gateway = async () => new ComposioPluginGateway(env, await vault.getProviderSecret('composio'));
  const validateCronTarget = async (projectId: string, draft: ProjectCronDraft) => {
    if (draft.target.projectId !== projectId) throw new ProjectCronValidationError('target', 'Cron target must belong to its owning project');
    if (draft.target.scope === 'workspace' && await projects.locateWorkspace(draft.target.spaceId) !== projectId) throw new ProjectCronValidationError('target', 'Cron workspace does not belong to its owning project');
  };
  const listSecrets = server.implement(listProjectSecretsContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); return ok(await secrets.list(input.projectId));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'listSecrets', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putSecret = server.implement(putProjectSecretContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); return ok(await secrets.put({ ...input, updatedBy: deviceId }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'putSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const deleteSecret = server.implement(deleteProjectSecretContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); return ok({ deleted: await secrets.delete(input.projectId, input.name) });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'deleteSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const listAccountSecrets = server.implement(listAccountSecretsContract).handler(async ({ errors }) => {
    try {
      return ok(await secrets.listAccount());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'listAccountSecrets', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putAccountSecret = server.implement(putAccountSecretContract).handler(async ({ input, errors }) => {
    try {
      return ok(await secrets.putAccount({ ...input, updatedBy: deviceId }));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'putAccountSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const deleteAccountSecret = server.implement(deleteAccountSecretContract).handler(async ({ input, errors }) => {
    try {
      return ok({ deleted: await secrets.deleteAccount(input.name) });
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'deleteAccountSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const grantAccountSecret = server.implement(grantAccountSecretContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); return ok(await secrets.grantAccount(input));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'grantAccountSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const revokeAccountSecret = server.implement(revokeAccountSecretContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); return ok(await secrets.revokeAccount(input.name, input.projectId));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'revokeAccountSecret', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const getValues = server.implement(getConfigurationValuesContract).handler(async ({ input, errors }) => {
    try {
      return ok(await values(input.projectId));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'getValues', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putValue = server.implement(putConfigurationValueContract).handler(async ({ input, errors }) => {
    try {
      await changeValue(input.scope, input.projectId, input.name, input.value); return ok(await values(input.projectId));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'putValue', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const deleteValue = server.implement(deleteConfigurationValueContract).handler(async ({ input, errors }) => {
    try {
      await changeValue(input.scope, input.projectId, input.name, null); return ok(await values(input.projectId));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'deleteValue', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const listSkills = server.implement(listSkillsContract).handler(async ({ errors }) => {
    try {
      return ok(await skills.list());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'listSkills', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const updateSkill = server.implement(updateSkillContract).handler(async ({ input, errors }) => {
    try {
      const update = skillUpdateSchema.parse(input.update);
      for (const id of new Set([...update.exceptions, ...update.assignments.map(entry => entry.projectId)])) await project(id);
      return ok(await skills.update(update));
    } catch (error) {
      if (error instanceof SkillRevisionConflict) return err(errors.SkillConflict({ skillId: error.skillId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'updateSkill', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const listConnections = server.implement(listMcpConnectionsContract).handler(async ({ errors }) => {
    try {
      return ok((await connections.list(userId)).map(mcpConnectionView));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'listConnections', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const createConnection = server.implement(createMcpConnectionContract).handler(async ({ input, errors }) => {
    try {
      return ok(mcpConnectionView(await connections.create(userId, input.connection as McpConnectionDraft)));
    } catch (error) {
      if (error instanceof McpConnectionValidationError) return err(errors.McpInvalid({ field: error.field, message: error.message }));
      return err(errors.OperationFailed({ operation: 'createConnection', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const updateConnection = server.implement(updateMcpConnectionContract).handler(async ({ input, errors }) => {
    try {
      return ok(mcpConnectionView(await connections.update(userId, input.connectionId, input.expectedRevision, input.connection as McpConnectionDraft)));
    } catch (error) {
      if (error instanceof McpConnectionNotFoundError || error instanceof ProjectMcpGrantNotFoundError) return err(errors.McpNotFound({ resource: error instanceof ProjectMcpGrantNotFoundError ? 'grant' : 'connection', id: error.connectionId }));
      if (error instanceof McpConnectionRevisionConflictError || error instanceof ProjectMcpGrantRevisionConflictError) return err(errors.McpRevisionConflict({ resource: error.connectionId, expected: error.expected, actual: error.actual }));
      if (error instanceof McpConnectionValidationError) return err(errors.McpInvalid({ field: error.field, message: error.message }));
      return err(errors.OperationFailed({ operation: 'updateConnection', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const deleteConnection = server.implement(deleteMcpConnectionContract).handler(async ({ input, errors }) => {
    try {
      const current = await connection(input.connectionId); if (current.transport.type === 'composio') throw new Error('Use plugin disconnect for Composio connections'); return ok({ connectionId: input.connectionId, deleted: await connections.delete(userId, input.connectionId, input.expectedRevision) });
    } catch (error) {
      if (error instanceof McpConnectionNotFoundError || error instanceof ProjectMcpGrantNotFoundError) return err(errors.McpNotFound({ resource: error instanceof ProjectMcpGrantNotFoundError ? 'grant' : 'connection', id: error.connectionId }));
      if (error instanceof McpConnectionRevisionConflictError || error instanceof ProjectMcpGrantRevisionConflictError) return err(errors.McpRevisionConflict({ resource: error.connectionId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'deleteConnection', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const connectionStatus = server.implement(getMcpConnectionStatusContract).handler(async ({ input, errors }) => {
    try {
      return ok(mcpConnectionView(await connection(input.connectionId)));
    } catch (error) {
      if (error instanceof McpConnectionNotFoundError || error instanceof ProjectMcpGrantNotFoundError) return err(errors.McpNotFound({ resource: error instanceof ProjectMcpGrantNotFoundError ? 'grant' : 'connection', id: error.connectionId }));
      return err(errors.OperationFailed({ operation: 'connectionStatus', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const listGrants = server.implement(listProjectMcpGrantsContract).handler(async ({ input, errors }) => {
    try {
      return ok((await (await project(input.projectId)).listMcpGrants()).map(projectMcpGrantView));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'listGrants', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const putGrant = server.implement(putProjectMcpGrantContract).handler(async ({ input, errors }) => {
    try {
      await connection(input.connectionId); return ok(projectMcpGrantView(await (await project(input.projectId)).putMcpGrant({ ...input, createdBy: deviceId })));
    } catch (error) {
      if (error instanceof McpConnectionNotFoundError || error instanceof ProjectMcpGrantNotFoundError) return err(errors.McpNotFound({ resource: error instanceof ProjectMcpGrantNotFoundError ? 'grant' : 'connection', id: error.connectionId }));
      if (error instanceof McpConnectionRevisionConflictError || error instanceof ProjectMcpGrantRevisionConflictError) return err(errors.McpRevisionConflict({ resource: error.connectionId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'putGrant', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const deleteGrant = server.implement(deleteProjectMcpGrantContract).handler(async ({ input, errors }) => {
    try {
      return ok({ projectId: input.projectId, connectionId: input.connectionId, deleted: await (await project(input.projectId)).deleteMcpGrant(input.connectionId, input.expectedRevision) });
    } catch (error) {
      if (error instanceof McpConnectionNotFoundError || error instanceof ProjectMcpGrantNotFoundError) return err(errors.McpNotFound({ resource: error instanceof ProjectMcpGrantNotFoundError ? 'grant' : 'connection', id: error.connectionId }));
      if (error instanceof McpConnectionRevisionConflictError || error instanceof ProjectMcpGrantRevisionConflictError) return err(errors.McpRevisionConflict({ resource: error.connectionId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'deleteGrant', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const catalog = server.implement(listComposioPluginCatalogContract).handler(async ({ errors }) => {
    try {
      return ok(await (await gateway()).catalog());
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'catalog', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const authorize = server.implement(authorizeComposioPluginContract).handler(async ({ input, errors }) => {
    try {
      const toolkit = input.toolkit.trim().toLowerCase(); const label = input.label.trim(); if (!toolkit || !label) throw new McpConnectionValidationError('toolkit', 'Choose a plugin and provide an account label'); const state = crypto.randomUUID(); const accountApiKey = await vault.getProviderSecret('composio'); const callback = new URL('/v1/mcp/composio/callback', origin); callback.searchParams.set('principal', userId); callback.searchParams.set('gitspace_state', state); callback.searchParams.set('signature', await signComposioState(env, userId, state, accountApiKey)); const authorization = await new ComposioPluginGateway(env, accountApiKey).authorize(userId, toolkit, callback.toString()); const saved = await connections.createComposio(userId, { id: `composio-${toolkit.slice(0, 80)}-${crypto.randomUUID().slice(0, 8)}`, label, toolkit, connectedAccountId: authorization.connectedAccountId, state, expiresAt: new Date(Date.now() + 600_000).toISOString() }); return ok({ connection: mcpConnectionView(saved), redirectUrl: authorization.redirectUrl });
    } catch (error) {
      if (error instanceof McpConnectionValidationError) return err(errors.McpInvalid({ field: error.field, message: error.message }));
      return err(errors.OperationFailed({ operation: 'authorize', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const refresh = server.implement(refreshComposioPluginContract).handler(async ({ input, errors }) => {
    try {
      const current = await composioConnection(input.connectionId); const status = await (await gateway()).status(current.transport.connectedAccountId); return ok(mcpConnectionView(await connections.updateComposioStatus(userId, input.connectionId, status.status, status.message)));
    } catch (error) {
      if (error instanceof McpConnectionNotFoundError || error instanceof ProjectMcpGrantNotFoundError) return err(errors.McpNotFound({ resource: error instanceof ProjectMcpGrantNotFoundError ? 'grant' : 'connection', id: error.connectionId }));
      return err(errors.OperationFailed({ operation: 'refresh', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const tools = server.implement(listComposioPluginToolsContract).handler(async ({ input, errors }) => {
    try {
      const current = await composioConnection(input.connectionId); return ok(await (await gateway()).tools(current.transport.toolkit));
    } catch (error) {
      if (error instanceof McpConnectionNotFoundError || error instanceof ProjectMcpGrantNotFoundError) return err(errors.McpNotFound({ resource: error instanceof ProjectMcpGrantNotFoundError ? 'grant' : 'connection', id: error.connectionId }));
      return err(errors.OperationFailed({ operation: 'tools', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const updateTools = server.implement(updateComposioPluginToolsContract).handler(async ({ input, errors }) => {
    try {
      const current = await composioConnection(input.connectionId);
      const available = new Set((await (await gateway()).tools(current.transport.toolkit)).map(tool => tool.slug));
      if (input.allowedTools.some(tool => !available.has(tool))) throw new McpConnectionValidationError('allowedTools', 'Selected plugin tool is unavailable');
      return ok(mcpConnectionView(await connections.updateComposioTools(userId, input.connectionId, input.expectedRevision, [...input.allowedTools])));
    } catch (error) {
      if (error instanceof McpConnectionNotFoundError || error instanceof ProjectMcpGrantNotFoundError) return err(errors.McpNotFound({ resource: error instanceof ProjectMcpGrantNotFoundError ? 'grant' : 'connection', id: error.connectionId }));
      if (error instanceof McpConnectionRevisionConflictError || error instanceof ProjectMcpGrantRevisionConflictError) return err(errors.McpRevisionConflict({ resource: error.connectionId, expected: error.expected, actual: error.actual }));
      if (error instanceof McpConnectionValidationError) return err(errors.McpInvalid({ field: error.field, message: error.message }));
      return err(errors.OperationFailed({ operation: 'updateTools', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const disconnect = server.implement(disconnectComposioPluginContract).handler(async ({ input, errors }) => {
    try {
      const current = await composioConnection(input.connectionId); if (current.revision !== input.expectedRevision) throw new McpConnectionRevisionConflictError(input.connectionId, input.expectedRevision, current.revision); await (await gateway()).disconnect(current.transport.connectedAccountId); return ok({ connectionId: input.connectionId, deleted: await connections.delete(userId, input.connectionId, input.expectedRevision) });
    } catch (error) {
      if (error instanceof McpConnectionNotFoundError || error instanceof ProjectMcpGrantNotFoundError) return err(errors.McpNotFound({ resource: error instanceof ProjectMcpGrantNotFoundError ? 'grant' : 'connection', id: error.connectionId }));
      if (error instanceof McpConnectionRevisionConflictError || error instanceof ProjectMcpGrantRevisionConflictError) return err(errors.McpRevisionConflict({ resource: error.connectionId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'disconnect', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const listCrons = server.implement(listProjectCronsContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); return ok(await (env.PROJECT_CRONS as DurableObjectNamespace<ProjectCronsDO>).getByName(JSON.stringify([userId, input.projectId])).list(input.projectId));
    } catch (error) {
      return err(errors.OperationFailed({ operation: 'listCrons', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const createCron = server.implement(createProjectCronContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); await validateCronTarget(input.projectId, input.draft); return ok(await (env.PROJECT_CRONS as DurableObjectNamespace<ProjectCronsDO>).getByName(JSON.stringify([userId, input.projectId])).create(input));
    } catch (error) {
      if (error instanceof ProjectCronValidationError) return err(errors.CronInvalid({ field: error.field, message: error.message }));
      return err(errors.OperationFailed({ operation: 'createCron', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const updateCron = server.implement(updateProjectCronContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); await validateCronTarget(input.projectId, input.draft); return ok(await (env.PROJECT_CRONS as DurableObjectNamespace<ProjectCronsDO>).getByName(JSON.stringify([userId, input.projectId])).update(input));
    } catch (error) {
      if (error instanceof ProjectCronValidationError) return err(errors.CronInvalid({ field: error.field, message: error.message }));
      if (error instanceof ProjectCronNotFoundError) return err(errors.CronNotFound({ projectId: error.projectId, cronId: error.cronId }));
      if (error instanceof ProjectCronRevisionConflictError) return err(errors.CronRevisionConflict({ cronId: error.cronId, expected: error.expected, actual: error.actual }));
      return err(errors.OperationFailed({ operation: 'updateCron', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const deleteCron = server.implement(deleteProjectCronContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); return ok(await (env.PROJECT_CRONS as DurableObjectNamespace<ProjectCronsDO>).getByName(JSON.stringify([userId, input.projectId])).delete(input));
    } catch (error) {
      if (error instanceof ProjectCronNotFoundError) return err(errors.CronNotFound({ projectId: error.projectId, cronId: error.cronId }));
      if (error instanceof ProjectCronRevisionConflictError) return err(errors.CronRevisionConflict({ cronId: error.cronId, expected: error.expected, actual: error.actual }));
      if (error instanceof ProjectCronAlreadyRunningError) return err(errors.CronAlreadyRunning({ cronId: error.cronId, runId: error.runId, state: error.state }));
      return err(errors.OperationFailed({ operation: 'deleteCron', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const runNow = server.implement(runProjectCronNowContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); return ok(await (env.PROJECT_CRONS as DurableObjectNamespace<ProjectCronsDO>).getByName(JSON.stringify([userId, input.projectId])).runNow(input));
    } catch (error) {
      if (error instanceof ProjectCronNotFoundError) return err(errors.CronNotFound({ projectId: error.projectId, cronId: error.cronId }));
      if (error instanceof ProjectCronAlreadyRunningError) return err(errors.CronAlreadyRunning({ cronId: error.cronId, runId: error.runId, state: error.state }));
      return err(errors.OperationFailed({ operation: 'runNow', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  const history = server.implement(projectCronHistoryContract).handler(async ({ input, errors }) => {
    try {
      await project(input.projectId); return ok(await (env.PROJECT_CRONS as DurableObjectNamespace<ProjectCronsDO>).getByName(JSON.stringify([userId, input.projectId])).history(input));
    } catch (error) {
      if (error instanceof ProjectCronNotFoundError) return err(errors.CronNotFound({ projectId: error.projectId, cronId: error.cronId }));
      return err(errors.OperationFailed({ operation: 'history', message: error instanceof Error ? error.message : String(error) }));
    }
  });
  return {
    secrets: { list: listSecrets, put: putSecret, delete: deleteSecret, account: { list: listAccountSecrets, put: putAccountSecret, delete: deleteAccountSecret, grant: grantAccountSecret, revoke: revokeAccountSecret } },
    configuration: { values: { get: getValues, put: putValue, delete: deleteValue } },
    skills: { list: listSkills, update: updateSkill },
    crons: { list: listCrons, create: createCron, update: updateCron, delete: deleteCron, runNow, history },
    mcp: { connections: { list: listConnections, create: createConnection, update: updateConnection, delete: deleteConnection, status: connectionStatus }, grants: { list: listGrants, put: putGrant, delete: deleteGrant }, composio: { catalog, authorize, refresh, tools, updateTools, disconnect } },
  };
}
