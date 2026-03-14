export interface PreparedWorkspaceIntegrations {
  env: Record<string, string>;
  requiredIntegrationIds: string[];
}

/**
 * Stub: integration env injection is deferred to the architecture cleanup (issue #70).
 * Bundle integration steps are not yet part of the active type system.
 */
export async function prepareWorkspaceIntegrations(
  _projectName: string,
  _workspacePath: string,
): Promise<PreparedWorkspaceIntegrations> {
  return { env: {}, requiredIntegrationIds: [] };
}
