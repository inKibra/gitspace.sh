import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OMP_IPC_VERSION, OmpRpcPeer, type OmpChildInit } from '../../../account-omp/src/ipc.js';

export function serveLifecycleFixture(options: { root: string; generation: string; holdInitialize?: boolean; hangDispose?: boolean; stubborn?: boolean }) {
  let initialized = false;
  let sessionFile = '';
  let state = { id: 'canonical-session', messages: [] as string[] };
  const marker = (name: string) => join(options.root, `${options.generation}.${name}`);
  const record = (name: string) => appendFile(join(options.root, 'operations'), `${options.generation}:${name}\n`);
  const rpc = new OmpRpcPeer(message => process.send!(message), {
    health: async () => ({ protocolVersion: OMP_IPC_VERSION, platform: process.platform, arch: process.arch, bunVersion: Bun.version, pid: process.pid }),
    initialize: async ([input]: [OmpChildInit]) => {
      initialized = true;
      await writeFile(marker('pid'), String(process.pid));
      // Cross-process file gates cannot use the parent's fake clock.
      if (options.holdInitialize) while (!existsSync(marker('release'))) await Bun.sleep(5);
      sessionFile = input.input.sessionFile ?? join(options.root, 'session.json');
      if (input.input.sessionFile) state = JSON.parse(await readFile(sessionFile, 'utf8'));
      else await writeFile(sessionFile, JSON.stringify(state));
      await record('initialize');
      return { id: state.id, sessionFile, activity: { active: false, reasons: [] }, failure: input.input.executionFailure ?? null };
    },
    prompt: async ([text]: [string]) => {
      state.messages.push(text);
      await record('prompt');
      rpc.publish({ type: 'activity', activity: { active: true, reasons: [{ kind: 'turn' }] }, failure: null });
    },
    handoff: async () => {
      await writeFile(sessionFile, JSON.stringify(state));
      await record('handoff-flushed');
      rpc.publish({ type: 'activity', activity: { active: false, reasons: [] }, failure: { domain: 'agent', code: 'AGENT_EXECUTION_FAILED', message: 'GitSpace machine handoff', context: {} } });
      return true;
    },
    persist: async () => {
      await record('persist');
      if (existsSync(join(options.root, 'fail-persist'))) throw Object.assign(new Error('checkpoint disk unavailable'), { code: 'EIO' });
      await writeFile(sessionFile, JSON.stringify(state));
    },
    dispose: async () => {
      await record('dispose');
      if (options.hangDispose) await Promise.withResolvers<void>().promise;
    },
    control: async () => ({ thinking: 'off', fastMode: false, approvalMode: 'auto' }),
    setThinking: async () => {},
    setFast: async () => {},
    setApproval: async () => {},
    messages: async () => state.messages,
  });
  process.on('message', message => rpc.receive(message));
  process.on('disconnect', () => {
    if (initialized && options.stubborn) { setInterval(() => {}, 1000); return; }
    process.exit(0);
  });
}
