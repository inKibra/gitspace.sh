/**
 * Process session naming helpers
 */

export const PROCESS_SESSION_PREFIX = 'proc';
export const PROCESS_SESSION_MAX_NAME = 64;

/**
 * Encode a process name for use as a single filesystem path segment.
 */
export function encodeProcessNameForPath(processName: string): string {
  return encodeURIComponent(processName);
}

export function buildProcessSessionName(
  workspaceId: string,
  processName: string,
  instance: number
): string {
  const instancePart = String(instance);
  const prefix = `${PROCESS_SESSION_PREFIX}:`;
  let workspacePart = workspaceId;
  let processPart = processName;

  const build = () => `${prefix}${workspacePart}:${processPart}:${instancePart}`;

  let candidate = build();
  if (candidate.length <= PROCESS_SESSION_MAX_NAME) {
    return candidate;
  }

  const maxWorkspaceLength = Math.max(
    1,
    PROCESS_SESSION_MAX_NAME - (prefix.length + 2 + instancePart.length + processPart.length)
  );
  if (workspacePart.length > maxWorkspaceLength) {
    workspacePart = workspacePart.slice(0, maxWorkspaceLength);
    candidate = build();
  }

  if (candidate.length > PROCESS_SESSION_MAX_NAME) {
    const maxProcessLength = Math.max(
      1,
      PROCESS_SESSION_MAX_NAME - (prefix.length + 2 + instancePart.length + workspacePart.length)
    );
    processPart = processPart.slice(0, maxProcessLength);
    candidate = build();
  }

  return candidate;
}

/**
 * Parse a process session name in the format:
 * `proc:<workspaceId>:<processName>:<instance>`
 *
 * Note: `<workspaceId>` and `<processName>` must not contain `:`.
 */
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
