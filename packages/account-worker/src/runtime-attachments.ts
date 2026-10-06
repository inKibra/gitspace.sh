import { RuntimeAttachmentRequestInputSchema, RuntimeAttachmentReadyInputSchema, RuntimeAssignmentsInputSchema } from '@gitspace/protocol-runtime';
import type { RuntimeAttachment, RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import type { AttachmentStore, ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import type { LifecycleState } from '@gitspace/protocol-environment';

export const executorCapabilities = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find', 'ast_grep', 'rule_match_ast', 'ast_edit', 'ast_resolve', 'codemode', 'jobs', 'proc', 'browser'];

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

  async request(raw: unknown) {
    const input = RuntimeAttachmentRequestInputSchema.parse(raw);
    await this.options.authorizeMachine(input.machineId);
    const repository = `workspace-${input.workspaceId}`;
    const checkpoint = input.role === 'replica' || input.sourceRef.startsWith('refs/gitspace/') ? await this.options.snapshot() : null;
    if (input.role === 'replica' && (!checkpoint || input.checkout.kind !== 'branch' || input.checkout.commit !== checkpoint.worktreeCommit)) throw new Error('Replica requires the current cloud snapshot and a private branch checkout');
    if (input.sourceRef.startsWith('refs/gitspace/') && checkpoint?.checkpointRef !== input.sourceRef) throw new Error('Selected checkpoint ref is not canonical');
    const resolved = await this.options.code.resolveRef(repository, checkpoint?.worktreeCommit ?? input.sourceRef);
    if (resolved !== input.checkout.commit) throw new Error('Assigned source ref no longer resolves to the selected commit');
    const metadata = await this.options.code.readCommit(repository, resolved);
    if (!metadata) throw new Error('Selected snapshot commit is unavailable');
    const trees = [metadata.treeHash];
    let requiresFiltersOrSubmodules = false;
    while (trees.length && !requiresFiltersOrSubmodules) {
      const tree = await this.options.code.readTree(repository, trees.pop()!);
      if (!tree) throw new Error('Selected snapshot tree is unavailable');
      for (const entry of tree) {
        if (entry.type === 'gitlink' || entry.name === '.gitattributes' || entry.name === '.gitmodules') { requiresFiltersOrSubmodules = true; break; }
        if (entry.type === 'tree') trees.push(entry.hash);
      }
    }
    const result = await this.options.attachments.request(input, {
      ref: input.sourceRef, commit: resolved, requiresFiltersOrSubmodules,
      ...(input.role === 'replica' && checkpoint ? { checkpoint } : {}),
    }, input.checkout.kind === 'branch' && input.role !== 'replica' ? [...executorCapabilities, 'delegate_export'] : executorCapabilities);
    this.options.publish();
    return result;
  }

  async assignments(raw: unknown) {
    const input = RuntimeAssignmentsInputSchema.parse(raw);
    await this.options.authorizeMachine(input.machineId);
    const assigned = await this.options.attachments.assignments(input.machineId);
    const assignments = await Promise.all(assigned.map(async ({ grant, source }) => {
      if (grant.attachment.role === 'primary') return { grant, source: null, checkpoint: await this.options.snapshot() };
      if (!source) throw new Error('Private attachment source is missing');
      const checkpoint = grant.attachment.role === 'replica' ? await this.options.snapshot() : null;
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
    if (attachment?.role === 'primary') {
      const checkpoint = await this.options.snapshot();
      if (!checkpoint) throw new Error('Primary readiness requires its canonical checkpoint');
      const result = this.options.attachments.ready(input, checkpoint.worktreeCommit);
      this.options.publish();
      return result;
    }
    const lifecycle = await this.options.lifecycle(input.projectId, input.workspaceId);
    for (const phase of ['machine/prepare', 'checks', 'workspace/materialize']) {
      const run = lifecycle.runs.find(candidate => candidate.id === `attachment:${input.attachmentId}:${input.generation}:${phase}`);
      if (!run || run.status !== 'succeeded' || run.machineId !== input.machineId || run.attachment?.attachmentId !== input.attachmentId || run.attachment.generation !== input.generation) throw new Error(`Attachment prerequisite ${phase} lacks a successful durable receipt`);
    }
    const result = this.options.attachments.ready(input);
    this.options.publish();
    return result;
  }
}
