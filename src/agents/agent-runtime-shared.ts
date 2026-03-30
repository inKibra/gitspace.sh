import { realpathSync } from 'node:fs';

export function normalizeWorkspacePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
