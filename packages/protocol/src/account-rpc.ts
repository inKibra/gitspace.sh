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
};

/** Runtime metadata has a canonical cloud view only when no machine is online. */
export const ACCOUNT_RUNTIME_RPC_PATHS: Readonly<Record<string, true>> = {
  'settings.omp.get': true,
  'providers.list': true,
};
