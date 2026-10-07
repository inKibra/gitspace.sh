import type { DaemonResponse } from '@gitspace/supervisor';
import { checkoutPath } from '@gitspace/runtime-machine';
import { PROTECTED_LIFECYCLE_SOCKET } from './protected-lifecycle.js';

export async function workspaceProcessVisible(root: string, process: Extract<DaemonResponse, { op: 'describe' }>): Promise<boolean> {
  if (process.spec.visibility === 'private' || process.spec.inheritEnv === false || process.spec.envNames.includes(PROTECTED_LIFECYCLE_SOCKET)) return false;
  try { await checkoutPath(root, process.spec.cwd); return true; } catch { return false; }
}
