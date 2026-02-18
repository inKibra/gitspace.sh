/**
 * Process session naming helpers
 */

export const PROCESS_SESSION_PREFIX = 'proc';
export const PROCESS_SESSION_MAX_NAME = 64;

export function buildProcessSessionName(
  workspaceId: string,
  processName: string,
  instance: number
): string {
  const base = `${PROCESS_SESSION_PREFIX}:${workspaceId}:${processName}:${instance}`;
  if (base.length <= PROCESS_SESSION_MAX_NAME) {
    return base;
  }
  return base.slice(0, PROCESS_SESSION_MAX_NAME);
}

export function parseProcessSessionName(name: string): {
  workspaceId: string;
  processName: string;
  instance: number;
} | null {
  if (!name.startsWith(`${PROCESS_SESSION_PREFIX}:`)) return null;
  const parts = name.split(':');
  if (parts.length < 4) return null;
  const [, workspaceId, processName, instanceRaw] = parts;
  const instance = Number(instanceRaw);
  if (!workspaceId || !processName || Number.isNaN(instance)) return null;
  return { workspaceId, processName, instance };
}
