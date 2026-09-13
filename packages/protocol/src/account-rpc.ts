/** Account authority operations have a separate batch queue from machine work.
 * A signed envelope cannot be split or rewritten after signing. */
export const ACCOUNT_CLOUD_RPC_PATHS: Readonly<Record<string, true>> = {
  'settings.get': true, 'settings.update': true, 'settings.reserveHandle': true, 'settings.git.get': true,
  'settings.omp.get': true, 'settings.events': true,
  placements: true, 'session.locate': true,
  machines: true, 'machine.events': true, 'machine.createSandbox': true, 'machine.updateNotes': true,
  'machine.sleep': true, 'machine.resume': true, 'machine.destroy': true,
  'project.list': true, 'devices.list': true, 'devices.revoke': true,
  'project.events': true, 'project.directoryEvents': true, 'space.events': true, 'incidents.record': true,
  'providers.list': true, 'providers.apiKey.set': true, 'providers.logout': true,
  'mcp.composio.setup.get': true, 'mcp.composio.setup.put': true, 'mcp.composio.setup.delete': true,
  'mcp.composio.catalog': true, 'mcp.composio.authorize': true, 'mcp.composio.refresh': true,
  'mcp.composio.tools': true, 'mcp.composio.updateTools': true, 'mcp.composio.disconnect': true,
  'mcp.connections.list': true, 'mcp.connections.create': true, 'mcp.connections.update': true,
  'mcp.connections.delete': true, 'mcp.connections.status': true,
  'mcp.grants.list': true, 'mcp.grants.put': true, 'mcp.grants.delete': true,
  'skills.list': true, 'skills.update': true,
  'secrets.list': true, 'secrets.put': true, 'secrets.delete': true,
  'secrets.account.list': true, 'secrets.account.put': true, 'secrets.account.delete': true,
  'secrets.account.grant': true, 'secrets.account.revoke': true,
  'configuration.values.get': true, 'configuration.values.put': true, 'configuration.values.delete': true,
  'crons.list': true, 'crons.create': true, 'crons.update': true, 'crons.delete': true,
  'crons.runNow': true, 'crons.history': true,
  'inspector.bootstrap': true,
  'inspector.transcript': true,
  'inspector.transcriptPage': true,
  'inspector.transcriptContent': true,
  'inspector.availability': true,
  'project.ensureGitSpace': true,
  'inspector.artifacts.read': true,
  'inspector.artifacts.list': true, 'inspector.artifacts.copyToProject': true,
  'inspector.artifacts.shares.list': true, 'inspector.artifacts.shares.create': true, 'inspector.artifacts.shares.revoke': true,
  'environment.approve': true, 'environment.revokeApproval': true,
  'environment.recoverRun': true, 'environment.runLog': true,
  'environment.events': true, 'environment.cancelRun': true,
};

/** Runtime metadata has a canonical cloud view only when no machine is online. */
export const ACCOUNT_RUNTIME_RPC_PATHS: Readonly<Record<string, true>> = {
  'settings.omp.get': true,
  'providers.list': true,
};

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
