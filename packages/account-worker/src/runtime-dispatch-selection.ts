import { z } from 'zod';
import { RuntimeDispatchSelectionSchema, RuntimeMachineIdSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, artifactsWorkspaceRepository, isAttachmentOnline, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import { RuntimeAttachmentController } from './runtime-attachments.js';
import { attachmentMachineKind } from './runtime-machine-loss.js';

const selectionState = z.object({ fingerprint: z.string(), deadline: z.string(), machineId: z.string().optional(), commit: z.string().optional(), attachmentId: z.string().optional(), result: z.unknown().optional() });
export type DispatchSelectionState = z.infer<typeof selectionState>;

/** A cache machine work can be dispatched to: online, and ready or paused/reclaimed so that dispatch wakes it first. */
export function isDispatchableCache(item: RuntimeAttachment, now: number): boolean {
  return item.role === 'cache' && isAttachmentOnline(item, now) && (item.state === 'ready' || item.cache?.state === 'paused' || item.cache?.state === 'reclaimed');
}

export function createDispatchSelector(options: { storage: DurableObjectStorage; env: Env; identity: { projectId: string; workspaceId: string }; runtime(): WorkspaceRuntime }) {
  const { storage, env, identity } = options;
  storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_host_selection (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  const load = (id: string) => {
    const row = storage.sql.exec<{ state: string }>('SELECT state FROM runtime_host_selection WHERE id=?', id).toArray()[0];
    return row ? selectionState.parse(JSON.parse(row.state)) : null;
  };
  const save = (id: string, state: DispatchSelectionState) => storage.sql.exec('INSERT INTO runtime_host_selection(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state', id, JSON.stringify(state));
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  const attachmentController = () => new RuntimeAttachmentController({ attachments: options.runtime().attachments, code, publish: () => options.runtime().publish(),
    snapshot: () => options.runtime().cloudFiles.initializeSnapshot(),
    origin: async () => (await authority.getProject())?.repositoryReference ?? null,
    lifecycle: () => authority.getLifecycleState(identity.workspaceId),
    authorizeMachine: async machineId => {
      const machine = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).getMachine(machineId);
      if (!machine || machine.desiredState === 'removed' || !await env.CREDENTIALS.getByName(env.ACCOUNT_ID).hasRuntimeMachine(machineId)) throw new Error('Attachment target is not an enrolled account machine');
      options.runtime().attachments.recordMachineKind(machineId, attachmentMachineKind(machine));
    },
  });
  async function cache(args: unknown, eligible?: readonly RuntimeAttachment[]): Promise<RuntimeAttachment> {
    const selection = RuntimeDispatchSelectionSchema.parse(args);
    const now = Date.now();
    let candidates = (eligible ?? options.runtime().attachments.list()).filter(item => isDispatchableCache(item, now));
    const selector = selection.on;
    if (typeof selector === 'string') {
      let machineId = candidates.find(item => item.machineId === selector)?.machineId;
      if (!machineId) {
        const fleet = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).listMachines();
        const named = fleet.filter(item => item.id === selector || item.label === selector);
        if (named.length > 1) throw new Error('Machine label is ambiguous; use its id');
        machineId = named[0] ? RuntimeMachineIdSchema.parse(named[0].id) : undefined;
      }
      candidates = candidates.filter(item => item.machineId === machineId);
    } else if (selector) {
      if (selector.needs) candidates = candidates.filter(item => selector.needs!.every(need => item.capabilities.includes(need)));
      if (selector.profile) {
        const lifecycle = await authority.getLifecycleState(identity.workspaceId);
        candidates = candidates.filter(item => ['machine/prepare', 'checks'].every(phase => lifecycle.runs.some(run => run.machineId === item.machineId && run.profile === selector.profile && run.phase === phase && run.status === 'succeeded')));
      }
      if (selector.prefer === 'idle') {
        const idle = (item: RuntimeAttachment) => {
          const observation = item.executionObservation;
          const age = observation ? Date.now() - Date.parse(observation.observedAt) : Infinity;
          return observation && age >= -5000 && age <= 30000 && observation.activeExecutions === 0 ? 1 : 0;
        };
        candidates.sort((a, b) => idle(b) - idle(a));
      }
    } else {
      const preferred = options.runtime().defaultExecutionMachine();
      if (preferred !== null) candidates.sort((a, b) => Number(b.machineId === preferred) - Number(a.machineId === preferred));
    }
    const selected = candidates.find(item => item.state === 'ready') ?? candidates[0];
    if (!selected) throw new Error('No machine attached: attach a ready workspace cache or choose an available execution machine.');
    return selected;
  }
  async function pause(signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 1000);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  async function select(input: { requestId: string; attemptId: string; args: unknown }, state: DispatchSelectionState, signal: AbortSignal): Promise<RuntimeAttachment> {
    const selection = RuntimeDispatchSelectionSchema.parse(input.args);
    let canonical = await cache(state.machineId ? { ...selection, on: state.machineId } : input.args);
    if (canonical.state !== 'ready') {
      const action = options.runtime().attachments.requestCacheAction({ ...canonical, requestId: `wake:${input.attemptId}`, action: { kind: 'setup' } });
      options.runtime().publish();
      while (canonical.state !== 'ready') {
        if (canonical.cacheAction?.status === 'failed') throw new Error(canonical.cacheAction.error ?? 'Cache setup failed');
        await pause(signal);
        const current = options.runtime().attachments.list().find(item => item.attachmentId === action.attachment.attachmentId);
        if (!current || !isAttachmentOnline(current, Date.now())) throw new Error(current?.state === 'lost' ? `No machine attached: selected cache was lost (${current.lossReason ?? 'unknown'})` : 'No machine attached: selected cache is offline');
        canonical = current;
      }
    }
    if (selection.at === undefined) return canonical;
    if (!state.machineId) { state.machineId = canonical.machineId; save(input.attemptId, state); }
    if (!state.commit) {
      if (selection.at === 'current') {
        const checkpoint = await options.runtime().cloudFiles.initializeSnapshot();
        if (!checkpoint) throw new Error('Cloud working copy is unavailable');
        state.commit = checkpoint.worktreeCommit;
      } else {
        const repository = artifactsWorkspaceRepository(identity.workspaceId);
        const commit = await code.resolveRef(repository, selection.at);
        if (!commit || !await code.readCommit(repository, commit)) throw new Error('Selected source does not exist in the canonical repository');
        state.commit = commit;
      }
      save(input.attemptId, state);
    }
    while (true) {
      signal.throwIfAborted();
      const attachments = options.runtime().attachments.list();
      const host = attachments.find(item => item.machineId === state.machineId && item.role === 'cache' && item.state !== 'lost' && item.state !== 'detached');
      if (!host || !isAttachmentOnline(host, Date.now())) throw new Error('No machine attached: selected machine is offline');
      let attachment = state.attachmentId ? attachments.find(item => item.attachmentId === state.attachmentId) : attachments.find(item => item.machineId === state.machineId && item.role === 'runner' && item.state === 'ready' && item.checkout.kind === 'snapshot' && item.checkout.commit === state.commit);
      if (!attachment) {
        if (state.attachmentId) throw new Error('Selected runner is no longer attached');
        attachment = (await attachmentController().request({ ...identity, requestId: `selection:${input.attemptId}`, machineId: state.machineId, sourceRef: state.commit, checkout: { kind: 'snapshot', commit: state.commit } })).attachment;
      }
      state.attachmentId = attachment.attachmentId;
      save(input.attemptId, state);
      if (attachment.state === 'ready') return attachment;
      if (attachment.state !== 'attaching') throw new Error(`Selected attachment is ${attachment.state}; no replacement was launched`);
      await pause(signal);
    }
  }
  return { load, save, select, cache };
}
