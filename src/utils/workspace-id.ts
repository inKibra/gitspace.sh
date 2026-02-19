export function toWorkspaceId(projectName: string, workspaceName: string): string {
  return `${projectName}:${workspaceName}`;
}

export function toCanonicalWorkspaceId(workspace: { projectName: string; id: string }): string {
  return toWorkspaceId(workspace.projectName, workspace.id);
}

export function matchesWorkspaceId(
  workspace: { projectName: string; id: string },
  workspaceId: string
): boolean {
  return workspace.id === workspaceId || toCanonicalWorkspaceId(workspace) === workspaceId;
}

export function resolveWorkspaceName(projectName: string, workspaceId: string): string {
  const prefix = `${projectName}:`;
  if (workspaceId.startsWith(prefix)) {
    return workspaceId.slice(prefix.length);
  }
  return workspaceId;
}
