import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessIdentity } from './protocol.js';
const exec = promisify(execFile);
export function getDaemonRuntimeDir(projectDir: string): string {
  return join(process.env.GITSPACE_SUPERVISOR_HOME ?? join(homedir(), '.gitspace', 'supervisor'), createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 24));
}
/** Boot evidence is independent of whether a launch committed its child PID. */
export async function bootIdentity(): Promise<string | null> {
  try {
    if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || null;
    if (process.platform === 'darwin') return (await exec('/usr/sbin/sysctl', ['-n', 'kern.boottime'])).stdout.trim() || null;
    return null;
  } catch {
    return null;
  }
}
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    if (process.platform === 'linux') {
      const [boot, stat] = await Promise.all([readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || fields[0] === 'X') return null;
      const started = fields[19];
      if (!started) throw new Error('Missing kernel process start identity');
      return { pid, boot: boot.trim(), started };
    }
    if (process.platform === 'darwin') {
      const [boot, started] = await Promise.all([exec('/usr/sbin/sysctl', ['-n', 'kern.boottime']), exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='])]);
      if (!started.stdout.trim()) return null;
      return { pid, boot: boot.stdout.trim(), started: started.stdout.trim() };
    }
    throw new Error('Supervisor requires Linux or macOS process identity support');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH' || error.code === 1)) return null;
    throw error;
  }
}
export async function sameProcess(identity: ProcessIdentity): Promise<boolean> {
  const current = await processIdentity(identity.pid);
  return current !== null && current.boot === identity.boot && current.started === identity.started;
}
/** Enumerate before signaling: descendants can create their own sessions/groups. */
export async function descendants(pid: number): Promise<ProcessIdentity[]> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=']);
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [child, parent] of rows) if (child && parent && ids.has(parent) && !ids.has(child)) { ids.add(child); changed = true; }
  }
  const identities = await Promise.all([...ids].map(processIdentity));
  return identities.filter((identity): identity is ProcessIdentity => identity !== null);
}
export async function signalIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
  if (!await sameProcess(identity)) return;
  try { process.kill(identity.pid, signal); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}
