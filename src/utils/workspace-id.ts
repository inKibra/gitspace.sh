import { isAbsolute, relative, resolve, sep } from 'path';

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

export function detectWorkspaceContextFromCwd(
  cwd: string,
  gitspaceDir: string
): { projectName: string; workspaceName: string } | null {
  const resolvedCwd = resolve(cwd);
  const resolvedGitspaceDir = resolve(gitspaceDir);

  const cwdRelativeToGitspace = relative(resolvedGitspaceDir, resolvedCwd);
  if (
    cwdRelativeToGitspace === '' ||
    cwdRelativeToGitspace === '.' ||
    cwdRelativeToGitspace.startsWith('..') ||
    isAbsolute(cwdRelativeToGitspace)
  ) {
    return null;
  }

  const parts = cwdRelativeToGitspace.split(sep).filter(Boolean);
  if (parts.length < 3 || parts[1] !== 'workspaces') {
    return null;
  }

  const projectName = parts[0];
  const workspaceName = parts[2];
  if (!projectName || !workspaceName) {
    return null;
  }

  return { projectName, workspaceName };
}
