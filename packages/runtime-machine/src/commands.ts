import { createHash } from 'node:crypto';
import { daemonClientForProject } from '@gitspace/supervisor';

export type ExecutorCommand = { application: string; args: string[]; cwd: string; attemptId: string; sequence: number; deadlineAt: string; signal: AbortSignal; env?: Record<string, string> };
export type ExecutorCommandResult = { exitCode: number; output: string };
export type RunExecutorCommand = (command: ExecutorCommand) => Promise<ExecutorCommandResult>;
export class ExecutorEffectUncertain extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ExecutorEffectUncertain'; }
}
class ExecutorStopped extends Error {}

/** Stable process names permit observation, never a second launch, after a lost reply. */
export const runSupervisorCommand: RunExecutorCommand = async command => {
  const client = await daemonClientForProject(command.cwd);
  const name = `exec-${createHash('sha256').update(`${command.attemptId}:${command.sequence}`).digest('hex').slice(0, 40)}`;
  const remaining = () => Math.max(1, Math.min(2_147_483_647, Date.parse(command.deadlineAt) - Date.now()));
  if (command.signal.aborted || Date.parse(command.deadlineAt) <= Date.now()) throw new Error('Command canceled or deadline expired before launch');
  const environment: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  try {
    await client.request({ op: 'start', owner: command.attemptId, spec: { name, application: command.application, args: command.args, cwd: command.cwd, inheritEnv: false, env: { ...environment, ...command.env }, pty: false, restart: 'no', persist: true, detached: false } });
  } catch (error) { throw new ExecutorEffectUncertain('Supervisor launch outcome is uncertain', { cause: error }); }
  let abortStop: Promise<unknown> | undefined;
  const abort = () => { abortStop = client.request({ op: 'stop', name, timeoutMs: 5000 }); void abortStop.catch(() => {}); };
  command.signal.addEventListener('abort', abort, { once: true });
  if (command.signal.aborted) abort();
  try {
    const waited = await client.request({ op: 'wait', name, for: 'exit', timeoutMs: remaining() });
    if (waited.op !== 'wait') throw new Error('Supervisor returned an invalid wait response');
    if (waited.timedOut || command.signal.aborted) {
      await (abortStop ?? client.request({ op: 'stop', name, timeoutMs: 5000 }));
      throw new ExecutorStopped(waited.timedOut ? 'Command deadline exceeded; process tree stopped' : 'Command canceled; process tree stopped');
    }
    if (waited.daemon.exitCode === null) throw new Error(waited.daemon.failure ?? 'Process outcome remains uncertain');
    const logs = await client.request({ op: 'logs', name, lines: 10000, head: false });
    if (logs.op !== 'logs') throw new Error('Supervisor returned an invalid logs response');
    return { exitCode: waited.daemon.exitCode, output: logs.text };
  } catch (error) {
    if (error instanceof ExecutorEffectUncertain || error instanceof ExecutorStopped) throw error;
    throw new ExecutorEffectUncertain('Supervisor process outcome requires reconciliation', { cause: error });
  } finally { command.signal.removeEventListener('abort', abort); }
};

/** Recover only a single immutable command, never a guessed multi-effect tool outcome. */
export async function reconcileSupervisorCommand(command: Pick<ExecutorCommand, 'application' | 'args' | 'cwd' | 'attemptId' | 'sequence'>, cancel = false): Promise<ExecutorCommandResult | null> {
  const client = await daemonClientForProject(command.cwd);
  const name = `exec-${createHash('sha256').update(`${command.attemptId}:${command.sequence}`).digest('hex').slice(0, 40)}`;
  let described = await client.request({ op: 'describe', name });
  if (described.op !== 'describe' || described.daemon.owner !== command.attemptId || described.daemon.name !== name || described.daemon.restartCount !== 0
    || described.spec.application !== command.application || JSON.stringify(described.spec.args) !== JSON.stringify(command.args) || described.spec.cwd !== command.cwd
    || described.spec.restart !== 'no' || described.spec.pty || described.spec.inheritEnv !== false || !described.spec.persist || described.spec.detached) throw new ExecutorEffectUncertain('Supervisor evidence does not match immutable command admission');
  if (cancel && described.daemon.state !== 'exited') {
    const id = described.daemon.id;
    const stopped = await client.request({ op: 'stop', name, timeoutMs: 5000 });
    described = await client.request({ op: 'describe', name });
    if (stopped.op !== 'stop' || stopped.daemon.id !== id || described.op !== 'describe' || described.daemon.id !== id || described.daemon.restartCount !== 0) throw new ExecutorEffectUncertain('Supervisor identity changed during cancellation');
  }
  if (described.daemon.state !== 'exited' || described.daemon.exitCode === null || described.daemon.failure) return null;
  const logs = await client.request({ op: 'logs', name, lines: 10000, head: false });
  const confirmed = await client.request({ op: 'describe', name });
  if (logs.op !== 'logs' || confirmed.op !== 'describe' || confirmed.daemon.id !== described.daemon.id || confirmed.daemon.state !== 'exited' || confirmed.daemon.exitCode !== described.daemon.exitCode || confirmed.daemon.restartCount !== 0) throw new ExecutorEffectUncertain('Supervisor evidence changed during recovery');
  return { exitCode: described.daemon.exitCode, output: logs.text };
}
