/** Account authority operations have a separate batch queue from machine work.
 * A signed envelope cannot be split or rewritten after signing. Every `runtime.*`
 * procedure is the account's cloud runtime; machines implement none of them. */
const ACCOUNT_CLOUD_RPC_PATHS: Readonly<Record<string, true>> = {
  'providers.login.start': true, 'providers.login.events': true,
  'providers.login.respond': true, 'providers.login.cancel': true,
  'providers.usage': true, 'providers.models': true,
  'settings.get': true, 'settings.update': true, 'settings.reserveHandle': true, 'settings.git.get': true,
  'settings.runtime.get': true, 'settings.runtime.set': true, 'settings.events': true,
  'inference.list': true, 'inference.create': true, 'inference.update': true,
  'inference.delete': true, 'inference.assign': true, 'inference.events': true,
  placements: true, 'session.locate': true,
  machines: true, 'machine.events': true, 'machine.createSandbox': true, 'machine.updateNotes': true,
  'machine.sleep': true, 'machine.resume': true, 'machine.destroy': true,
  'machine.image.list': true, 'machine.image.events': true, 'machine.image.set': true,
  'machine.image.retry': true, 'machine.image.cancel': true, 'machine.image.recover': true,
  'machine.image.defaults.get': true, 'machine.image.defaults.set': true,
  'project.list': true, 'devices.list': true, 'devices.revoke': true,
  'project.events': true, 'project.directoryEvents': true, 'space.events': true, 'incidents.record': true,
  'providers.list': true, 'providers.apiKey.set': true, 'providers.logout': true,
  'mcp.composio.setup.get': true, 'mcp.composio.setup.put': true, 'mcp.composio.setup.delete': true,
  'mcp.composio.catalog': true, 'mcp.composio.authorize': true, 'mcp.composio.refresh': true,
  'mcp.composio.tools': true, 'mcp.composio.updateTools': true, 'mcp.composio.disconnect': true,
  'mcp.connections.list': true, 'mcp.connections.create': true, 'mcp.connections.update': true,
  'mcp.connections.delete': true, 'mcp.connections.status': true,
  'mcp.grants.list': true, 'mcp.grants.put': true, 'mcp.grants.delete': true,
  'mcp.discover': true,
  'skills.list': true, 'skills.update': true,
  'secrets.list': true, 'secrets.put': true, 'secrets.delete': true,
  'secrets.account.list': true, 'secrets.account.put': true, 'secrets.account.delete': true,
  'secrets.account.grant': true, 'secrets.account.revoke': true,
  'configuration.values.get': true, 'configuration.values.put': true, 'configuration.values.delete': true,
  'crons.list': true, 'crons.create': true, 'crons.update': true, 'crons.delete': true,
  'crons.runNow': true, 'crons.cancelRun': true, 'crons.history': true,
  'inspector.view': true,
  'inspector.transcript': true,
  'inspector.transcriptPage': true,
  'inspector.transcriptContent': true,
  'inspector.availability': true,
  'project.ensureGitSpace': true,
  'inspector.artifacts.read': true,
  'inspector.artifacts.readPage': true,
  'inspector.artifacts.list': true, 'inspector.artifacts.copyToProject': true,
  'inspector.artifacts.shares.list': true, 'inspector.artifacts.shares.create': true, 'inspector.artifacts.shares.revoke': true,
  'environment.approve': true, 'environment.revokeApproval': true,
  'environment.recoverRun': true, 'environment.runLog': true,
  'environment.events': true, 'environment.cancelRun': true,
};

/** The account, not a machine, serves this procedure. */
export function isAccountCloudRpcPath(path: string): boolean {
  return path.startsWith('runtime.') || Object.hasOwn(ACCOUNT_CLOUD_RPC_PATHS, path);
}

/** Workspace reads use cloud state when there is no live holder.
 * Per-space queues remain separate from account mutations and runtime work. */
export function isSpaceCloudRpcPath(path: string): boolean {
  return path === 'environment.get' || (path.startsWith('inspector.') && !Object.hasOwn(ACCOUNT_CLOUD_RPC_PATHS, path));
}

export function spaceCloudRpcSpaceId(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const outer = input as Record<string, unknown>;
  const record = outer.input && typeof outer.input === 'object'
    ? outer.input as Record<string, unknown>
    : outer;
  return typeof record.spaceId === 'string' ? record.spaceId : null;
}

/** The space or session a machine-bound call names. The account Worker forwards
 * each signed batch whole to that target's holder, so a batch names one target.
 * Terminal calls name their machine explicitly and never follow a holder. */
export type RpcCallTarget =
  | { kind: 'space'; spaceId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'terminal'; spaceId: string; machineId: string };

export function isTerminalRpcPath(path: string): boolean {
  return path.startsWith('terminals.');
}

/** Project-level calls whose `projectId` names the project's base space. */
const BASE_SPACE_RPC_PATHS: Readonly<Record<string, true>> = {
  'space.view': true, transcript: true, transcriptPage: true, transcriptContent: true,
  'workspace.create': true, 'session.createProject': true, events: true, 'project.setBaseBranch': true,
};

export function rpcCallTarget(path: string, input: unknown): RpcCallTarget | null {
  if (!input || typeof input !== 'object') return null;
  if (isTerminalRpcPath(path)) {
    return 'spaceId' in input && typeof input.spaceId === 'string' && 'machineId' in input && typeof input.machineId === 'string'
      ? { kind: 'terminal', spaceId: input.spaceId, machineId: input.machineId }
      : null;
  }
  const named = 'spaceId' in input && typeof input.spaceId === 'string' ? input.spaceId
    : 'workspaceId' in input && typeof input.workspaceId === 'string' ? input.workspaceId
    : null;
  const spaceId = named || (Object.hasOwn(BASE_SPACE_RPC_PATHS, path) && 'projectId' in input && typeof input.projectId === 'string' ? input.projectId : null);
  if (spaceId) return { kind: 'space', spaceId };
  return 'sessionId' in input && typeof input.sessionId === 'string' && input.sessionId ? { kind: 'session', sessionId: input.sessionId } : null;
}
