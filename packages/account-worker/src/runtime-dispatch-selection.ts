import { z } from 'zod';
import { RuntimeDispatchSelectionSchema, RuntimeToolDispatchSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { ArtifactsCodeStore, artifactsWorkspaceRepository, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';
import { RuntimeAttachmentController } from './runtime-attachments.js';

const selectionState = z.object({ fingerprint: z.string(), deadline: z.string(), machineId: z.string().optional(), commit: z.string().optional(), checkpointRef: z.string().optional(), checkpointDispatch: RuntimeToolDispatchSchema.optional(), attachmentId: z.string().optional(), result: z.unknown().optional() });
export type DispatchSelectionState = z.infer<typeof selectionState>;
export class SourceCheckpointIncomplete extends Error {
  constructor(readonly status: 'failed' | 'interrupted') {
    super(`Source checkpoint ${status}; unresolved effects are not replayed`);
  }
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
    },
  });
  async function pause(signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 1000);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  async function select(input: { requestId: string; attemptId: string; conversationId: string; taskId: string; args: unknown }, state: DispatchSelectionState, signal: AbortSignal): Promise<RuntimeAttachment> {
    const selection = RuntimeDispatchSelectionSchema.parse(input.args);
    const repository = artifactsWorkspaceRepository(identity.workspaceId);
    // Pin the source before assignment. An unsafe unresolved checkpoint is never resubmitted.
    if (!state.commit) {
      if ((selection.at ?? 'current') === 'current') {
        while (!state.checkpointDispatch) {
          signal.throwIfAborted();
          const primary = options.runtime().attachments.list().find(item => item.role === 'primary' && item.state === 'ready');
          if (!primary) { await pause(signal); continue; }
          state.checkpointDispatch = RuntimeToolDispatchSchema.parse({ version: 1, ...identity, conversationId: input.conversationId, taskId: input.taskId, machineId: primary.machineId, attachmentId: primary.attachmentId, generation: primary.generation, requestId: `source:${input.requestId}`, attemptId: `source:${input.attemptId}`, tool: 'checkpoint', args: {}, deadlineAt: state.deadline, replay: 'unsafe' });
          save(input.attemptId, state);
        }
        const prior = options.runtime().attachments.getAttempt(state.checkpointDispatch.attemptId);
        const receipt = prior?.result ?? await options.runtime().attachments.execute(state.checkpointDispatch, signal);
        if (receipt.status !== 'completed') throw new SourceCheckpointIncomplete(receipt.status);
        const text = receipt.content.find(item => item.type === 'text');
        if (!text || text.type !== 'text') throw new Error('Source checkpoint did not return exact commit evidence');
        const checkpoint = z.object({ checkpoint: RuntimeGitCheckpointSchema }).parse(JSON.parse(text.text)).checkpoint;
        state.commit = checkpoint.worktreeCommit;
        state.checkpointRef = checkpoint.checkpointRef;
      } else {
        const source = selection.at!;
        const commit = await code.resolveRef(repository, source);
        if (!commit || !await code.readCommit(repository, commit)) throw new Error('Selected source does not exist in the canonical repository');
        state.commit = commit;
      }
      save(input.attemptId, state);
    }
    while (true) {
      signal.throwIfAborted();
      const attachments = options.runtime().attachments.list();
      if (!state.machineId) {
        const fleet = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).listMachines();
        const selector = selection.on;
        let candidates = fleet.filter(machine => machine.desiredState !== 'removed');
        if (typeof selector === 'string') {
          const exact = candidates.find(machine => machine.id === selector);
          candidates = exact ? [exact] : candidates.filter(machine => machine.label === selector);
          if (candidates.length > 1) throw new Error('Machine label is ambiguous; use its id');
          if (!candidates.length) throw new Error('Selected machine is not enrolled');
        } else {
          const lifecycle = selector?.profile ? await authority.getLifecycleState(identity.workspaceId) : null;
          candidates = candidates.filter(machine => {
            const available = attachments.filter(item => item.machineId === machine.id && item.state === 'ready');
            if (selector?.needs?.some(need => !available.some(item => item.capabilities.includes(need)))) return false;
            // Profiles are proven by successful canonical preparation/check receipts, not names or notes.
            if (selector?.profile && !['machine/prepare', 'checks'].every(phase => lifecycle?.runs.some(run => run.machineId === machine.id && run.profile === selector.profile && run.phase === phase && run.status === 'succeeded'))) return false;
            return machine.state === 'online' && machine.desiredState === 'online';
          });
          if (selector?.prefer === 'idle') {
            const idle = (machineId: string) => {
              const observations = attachments.filter(item => item.machineId === machineId && item.state === 'ready').map(item => item.executionObservation);
              return observations.length > 0 && observations.every(observation => {
                if (!observation) return false;
                const age = Date.now() - Date.parse(observation.observedAt);
                return age >= -5000 && age <= 30000 && observation.activeExecutions === 0;
              });
            };
            candidates.sort((a, b) => Number(idle(b.id)) - Number(idle(a.id)) || a.id.localeCompare(b.id));
          }
        }
        if (!candidates.length) { await pause(signal); continue; }
        state.machineId = candidates[0]!.id;
        save(input.attemptId, state);
      }
      let attachment = state.attachmentId ? attachments.find(item => item.attachmentId === state.attachmentId) : attachments.find(item => item.machineId === state.machineId && item.role === 'runner' && item.state === 'ready' && item.checkout.kind === 'snapshot' && item.checkout.commit === state.commit);
      if (!attachment) {
        const assigned = await attachmentController().request({ ...identity, requestId: `selection:${input.attemptId}`, machineId: state.machineId, sourceRef: state.commit, checkout: { kind: 'snapshot', commit: state.commit } });
        attachment = assigned.attachment;
      }
      state.attachmentId = attachment.attachmentId;
      save(input.attemptId, state);
      if (attachment.state === 'ready') {
        if (typeof selection.on === 'object') {
          if (selection.on.needs?.some(need => !attachment.capabilities.includes(need))) throw new Error('Ready attachment does not satisfy requested capabilities');
          if (selection.on.profile) {
            const lifecycle = await authority.getLifecycleState(identity.workspaceId);
            for (const phase of ['machine/prepare', 'checks', 'workspace/materialize']) {
              const receipt = lifecycle.runs.find(run => run.id === `attachment:${attachment.attachmentId}:${attachment.generation}:${phase}`);
              if (!receipt || receipt.status !== 'succeeded' || receipt.profile !== selection.on.profile) throw new Error('Ready attachment does not satisfy the requested environment profile');
            }
          }
        }
        return attachment;
      }
      if (attachment.state !== 'attaching') throw new Error(`Selected attachment is ${attachment.state}; no replacement was launched`);
      await pause(signal);
    }
  }
  return { load, save, select, pause };
}
