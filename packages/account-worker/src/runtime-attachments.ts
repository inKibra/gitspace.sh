import { RuntimeAttachmentRequestInputSchema, RuntimeAttachmentReadyInputSchema, RuntimeAssignmentsInputSchema } from '@gitspace/protocol-runtime';
import type { RuntimeAttachment, RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import type { AttachmentStore, ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import type { LifecycleState } from '@gitspace/protocol-environment';

export const executorCapabilities = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find', 'ast_grep', 'rule_match_ast', 'ast_edit', 'ast_resolve', 'proc', 'service', 'browser'];

/** Invoked behind canonical project/workspace and enrolled-machine authorization. */
export class RuntimeAttachmentController {
  constructor(private readonly options: {
    attachments: AttachmentStore;
    code: ArtifactsCodeStore;
    publish(): void;
    snapshot(): Promise<RuntimeSnapshotCommitInput['checkpoint'] | null>;
    /** Canonical project origin; never supplied by the request or the execution grant. */
    origin(projectId: string): Promise<string | null>;
    lifecycle(projectId: string, workspaceId: string): Promise<LifecycleState>;
    /** Enrollment/trust checks are required even when the target is offline. */
    authorizeMachine(machineId: RuntimeAttachment['machineId']): Promise<void>;
  }) {}

  private async requiresFiltersOrSubmodules(repository: string, commit: string) {
    const metadata = await this.options.code.readCommit(repository, commit);
    if (!metadata) throw new Error('Selected snapshot commit is unavailable');
    const trees = [metadata.treeHash];
    while (trees.length) {
      const next = trees.pop();
      if (!next) break;
      const tree = await this.options.code.readTree(repository, next);
      if (!tree) throw new Error('Selected snapshot tree is unavailable');
      for (const entry of tree) {
        if (entry.type === 'gitlink' || entry.name === '.gitattributes' || entry.name === '.gitmodules') return true;
        if (entry.type === 'tree') trees.push(entry.hash);
      }
    }
    return false;
  }

  async request(raw: unknown) {
    const input = RuntimeAttachmentRequestInputSchema.parse(raw);
    await this.options.authorizeMachine(input.machineId);
    const repository = `workspace-${input.workspaceId}`;
    const checkpoint = input.sourceRef.startsWith('refs/gitspace/') ? await this.options.snapshot() : null;
    if (input.sourceRef.startsWith('refs/gitspace/') && checkpoint?.checkpointRef !== input.sourceRef) throw new Error('Selected checkpoint ref is not canonical');
    const resolved = await this.options.code.resolveRef(repository, checkpoint?.worktreeCommit ?? input.sourceRef);
    if (resolved !== input.checkout.commit) throw new Error('Assigned source ref no longer resolves to the selected commit');
    const requiresFiltersOrSubmodules = await this.requiresFiltersOrSubmodules(repository, resolved);
    const result = await this.options.attachments.request(input, {
      ref: input.sourceRef, commit: resolved, requiresFiltersOrSubmodules,
    }, input.checkout.kind === 'branch' ? [...executorCapabilities, 'delegate_export'] : executorCapabilities);
    this.options.publish();
    return result;
  }

  async assignments(raw: unknown) {
    const input = RuntimeAssignmentsInputSchema.parse(raw);
    await this.options.authorizeMachine(input.machineId);
    const assigned = await this.options.attachments.assignments(input.machineId, executorCapabilities);
    const assignments = await Promise.all(assigned.map(async ({ grant, source }) => {
      if (grant.attachment.role === 'cache') {
        const checkpoint = await this.options.snapshot();
        if (!checkpoint) return { grant, source: null, checkpoint };
        const info = await this.options.code.info(`workspace-${grant.attachment.workspaceId}`);
        const requiresFiltersOrSubmodules = await this.requiresFiltersOrSubmodules(`workspace-${grant.attachment.workspaceId}`, checkpoint.worktreeCommit);
        return { grant, source: { ref: checkpoint.checkpointRef, commit: checkpoint.worktreeCommit, requiresFiltersOrSubmodules, remote: info.remote, origin: await this.options.origin(grant.attachment.projectId), checkpoint }, checkpoint };
      }
      if (!source) throw new Error('Private attachment source is missing');
      const checkpoint = null;
      const sourceCheckpoint = source.checkpoint;
      if (grant.attachment.state === 'draining' || grant.attachment.state === 'lost') return { grant, source: { ...source, origin: null }, checkpoint, sourceCheckpoint };
      const info = await this.options.code.info(`workspace-${grant.attachment.workspaceId}`);
      return { grant, source: { ...source, remote: info.remote, origin: await this.options.origin(grant.attachment.projectId) }, checkpoint, sourceCheckpoint };
    }));
    return { assignments };
  }

  async ready(raw: unknown) {
    const input = RuntimeAttachmentReadyInputSchema.parse(raw);
    await this.options.authorizeMachine(input.machineId);
    const attachment = this.options.attachments.list().find(item => item.attachmentId === input.attachmentId && item.generation === input.generation);
    const lifecycle = await this.options.lifecycle(input.projectId, input.workspaceId);
    for (const phase of ['machine/prepare', 'checks', 'workspace/materialize']) {
      const runId = attachment?.cacheAction?.action === 'setup' ? `attachment:${input.attachmentId}:${input.generation}:${attachment.cacheAction.requestId}:${phase}` : `attachment:${input.attachmentId}:${input.generation}:${phase}`;
      const run = lifecycle.runs.find(candidate => candidate.id === runId);
      if (!run || run.status !== 'succeeded' || run.machineId !== input.machineId || run.attachment?.attachmentId !== input.attachmentId || run.attachment.generation !== input.generation) throw new Error(`Attachment prerequisite ${phase} lacks a successful durable receipt`);
    }
    const checkpoint = attachment?.role === 'cache' ? await this.options.snapshot() : null;
    if (attachment?.role === 'cache' && !checkpoint) throw new Error('Cache readiness requires its canonical checkpoint');
    const result = this.options.attachments.ready(input, checkpoint?.worktreeCommit);
    this.options.publish();
    return result;
  }
}
