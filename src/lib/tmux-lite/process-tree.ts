// Mirrors the subset of Bun's `Subprocess` this module needs. `kill` must match
// Bun's own signature (`number | NodeJS.Signals`) — widening it to `string`
// makes a real Subprocess unassignable to this interface.
export interface SignalableSubprocess {
  pid: number;
  kill: (signal?: number | NodeJS.Signals) => void;
}

export function readProcessGroupId(
  pid: number,
  spawnSyncImpl: typeof Bun.spawnSync = Bun.spawnSync,
): number | null {
  const result = spawnSyncImpl(['ps', '-o', 'pgid=', '-p', String(pid)]);
  if (result.exitCode !== 0) {
    return null;
  }
  const value = result.stdout.toString().trim();
  const groupId = Number(value);
  return Number.isInteger(groupId) && groupId > 0 ? groupId : null;
}

export function signalProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  readProcessGroupIdImpl: (pid: number) => number | null = readProcessGroupId,
): boolean {
  const processGroupId = readProcessGroupIdImpl(pid);
  const currentProcessGroupId = processGroupId ? readProcessGroupIdImpl(process.pid) : null;
  if (processGroupId && processGroupId !== currentProcessGroupId) {
    try {
      process.kill(-processGroupId, signal);
      return true;
    } catch {}
  }

  if (pid !== currentProcessGroupId) {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {}
  }

  if (pid !== process.pid) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {}
  }

  return false;
}

export function signalSubprocessTree(
  proc: SignalableSubprocess,
  signal: NodeJS.Signals,
  readProcessGroupIdImpl: (pid: number) => number | null = readProcessGroupId,
): boolean {
  if (signalProcessTree(proc.pid, signal, readProcessGroupIdImpl)) {
    return true;
  }

  try {
    proc.kill(signal);
    return true;
  } catch {}

  return false;
}
