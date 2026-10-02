import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OMP_IPC_VERSION, OmpRpcPeer, type OmpChildInit } from '../../../account-omp/src/ipc.js';
import type { InferenceExecutionContext } from '@gitspace/protocol';

export function serveLifecycleFixture(options: { root: string; generation: string; holdInitialize?: boolean; holdPrompt?: boolean; hangDispose?: boolean; stubborn?: boolean }) {
  let initialized = false;
  let sessionFile = '';
  let state = { id: 'canonical-session', messages: [] as string[] };
  let inference: InferenceExecutionContext;
  const admission = (method: string, text: string) => appendFile(join(options.root, 'admissions'), `${JSON.stringify({
    method, text, projectId: inference.projectId, profileId: inference.profile.id,
    assignmentRevision: inference.assignmentRevision, profileRevision: inference.profile.revision,
    advancedGeneration: inference.advanced.generation, token: inference.broker.token,
    ambient: !!(process.env.OPENAI_API_KEY || process.env.AWS_ACCESS_KEY_ID || process.env.OMP_AUTH_BROKER_TOKEN || process.env.GITSPACE_MACHINE_SIGNING_KEY),
  })}\n`);
  const marker = (name: string) => join(options.root, `${options.generation}.${name}`);
  const record = (name: string) => appendFile(join(options.root, 'operations'), `${options.generation}:${name}\n`);
  const rpc = new OmpRpcPeer(message => process.send!(message), {
    health: async () => ({ protocolVersion: OMP_IPC_VERSION, platform: process.platform, arch: process.arch, bunVersion: Bun.version, pid: process.pid }),
    initialize: async ([input]: [OmpChildInit]) => {
      initialized = true;
      inference = input.inference;
      await writeFile(marker('pid'), String(process.pid));
      // Cross-process file gates cannot use the parent's fake clock.
      if (options.holdInitialize) while (!existsSync(marker('release'))) await Bun.sleep(5);
      sessionFile = input.input.sessionFile ?? join(options.root, `${input.input.sessionKey === 'canonical' ? 'session' : input.input.sessionKey}.json`);
      if (input.input.sessionFile) state = JSON.parse(await readFile(sessionFile, 'utf8'));
      else state = { id: input.input.sessionKey, messages: [] };
      if (!input.input.sessionFile) await writeFile(sessionFile, JSON.stringify(state));
      await record('initialize');
      // Like the real child, report activity while the host is still installing this worker.
      rpc.publish({ type: 'activity', activity: { active: false, reasons: [] }, failure: null });
      return { id: state.id, sessionFile, activity: { active: false, reasons: [] }, failure: input.input.executionFailure ?? null };
    },
    prompt: async ([text]: [string]) => {
      state.messages.push(text);
      await admission('prompt', text);
      await record('prompt');
      rpc.publish({ type: 'activity', activity: { active: true, reasons: [{ kind: 'turn' }] }, failure: null });
      if (options.holdPrompt) {
        await writeFile(marker('prompt-started'), text);
        while (!existsSync(marker('prompt-release'))) await Bun.sleep(5);
        await writeFile(sessionFile, JSON.stringify(state));
        rpc.publish({ type: 'activity', activity: { active: false, reasons: [] }, failure: null });
      }
      return true;
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
    control: async () => ({ thinking: 'off', fastMode: false, approvalMode: 'auto', queue: { steering: [], followUp: [] } }),
    setThinking: async () => {},
    setFast: async () => {},
    setApproval: async () => {},
    resume: async () => { await admission('resume', 'continue'); },
    compact: async () => { await admission('compact', 'summary'); return { queue: { steering: [], followUp: [] } }; },
    reloadAuth: async () => {
      if (existsSync(join(options.root, 'fail-auth'))) throw new Error('Profile broker unavailable');
      await appendFile(join(options.root, 'auth-reloads'), `${inference.projectId}:${inference.profile.id}\n`);
    },
    applyInference: async ([next]: [InferenceExecutionContext]) => {
      inference = next;
      await record('apply-inference');
    },
    stop: async () => { rpc.publish({ type: 'activity', activity: { active: false, reasons: [] }, failure: null }); },
    clearQueue: async () => {},
    messages: async () => state.messages,
  });
  process.on('message', message => rpc.receive(message));
  process.on('disconnect', () => {
    if (initialized && options.stubborn) { setInterval(() => {}, 1000); return; }
    process.exit(0);
  });
}
