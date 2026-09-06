/** Account authority operations have a separate batch queue from machine work.
 * A signed envelope cannot be split or rewritten after signing. */
export const ACCOUNT_CLOUD_RPC_PATHS: Readonly<Record<string, true>> = {
  'settings.get': true, 'settings.update': true, 'settings.reserveHandle': true, 'settings.git.get': true,
  'settings.omp.get': true, 'settings.events': true,
  machines: true, 'machine.events': true, 'machine.createSandbox': true, 'machine.updateNotes': true,
  'machine.sleep': true, 'machine.resume': true, 'machine.destroy': true,
  'project.list': true, 'devices.list': true, 'devices.revoke': true,
  'providers.list': true, 'providers.apiKey.set': true, 'providers.logout': true,
  'mcp.composio.setup.get': true, 'mcp.composio.setup.set': true, 'mcp.composio.setup.delete': true,
  'inspector.bootstrap': true,
  'inspector.availability': true,
  'project.ensureGitSpace': true,
  'inspector.artifacts.read': true,
  'inspector.artifacts.list': true, 'inspector.artifacts.copyToProject': true,
  'inspector.artifacts.shares.list': true, 'inspector.artifacts.shares.create': true, 'inspector.artifacts.shares.revoke': true,
  'environment.approve': true, 'environment.revokeApproval': true,
  'environment.recoverRun': true, 'environment.runLog': true,
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
