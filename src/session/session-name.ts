import { SessionNameExistsError } from '../types/errors.js';

export interface ExistingSessionName {
  name: string;
}

interface BuildSessionNameOptions {
  projectName: string;
  workspaceName: string;
  requestedName?: string;
  sessions: ExistingSessionName[];
}

function getSessionPrefix(projectName: string, workspaceName: string): string {
  return `${projectName}:${workspaceName}:`;
}

export function buildSessionName(options: BuildSessionNameOptions): string {
  const { projectName, workspaceName, requestedName, sessions } = options;
  const prefix = getSessionPrefix(projectName, workspaceName);

  if (requestedName && requestedName.length > 0) {
    const fullName = `${prefix}${requestedName}`;
    if (sessions.some((session) => session.name === fullName)) {
      throw new SessionNameExistsError(
        `Session name "${requestedName}" already exists in workspace "${workspaceName}"`
      );
    }
    return fullName;
  }

  const usedNumericSuffixes = new Set<number>();
  for (const session of sessions) {
    if (!session.name.startsWith(prefix)) {
      continue;
    }
    const suffix = session.name.slice(prefix.length);
    const parsed = Number.parseInt(suffix, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      usedNumericSuffixes.add(parsed);
    }
  }

  let candidate = 1;
  while (usedNumericSuffixes.has(candidate)) {
    candidate += 1;
  }

  return `${prefix}${candidate}`;
}
