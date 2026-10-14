import { RuntimeAttachmentReadyInputSchema, RuntimeAssignmentsInputSchema } from '@gitspace/protocol-runtime';
import type { RuntimeAttachment, RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import type { AttachmentStore, ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';

export const executorCapabilities = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find', 'ast_grep', 'rule_match_ast', 'ast_edit', 'ast_resolve', 'proc', 'service', 'browser', 'sync_machine'];

/** Invoked behind canonical project/workspace and enrolled-machine authorization. */
export class RuntimeAttachmentController {
  constructor(private readonly options: {
    attachments: AttachmentStore;
    code: ArtifactsCodeStore;
    publish(): void;
    snapshot(): Promise<RuntimeSnapshotCommitInput['checkpoint'] | null>;
    /** Canonical project origin; never supplied by the request or the execution grant. */
    origin(projectId: string): Promise<string | null>;
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

  async assignments(raw: unknown) {
    const input = RuntimeAssignmentsInputSchema.parse(raw);
    await this.options.authorizeMachine(input.machineId);
    const assigned = await this.options.attachments.assignments(input.machineId, executorCapabilities);
    const assignments = await Promise.all(assigned.map(async ({ grant }) => {
      const checkpoint = await this.options.snapshot();
      if (!checkpoint) return { grant, source: null, checkpoint };
      const repository = `workspace-${grant.attachment.workspaceId}`;
      const info = await this.options.code.info(repository);
      const requiresFiltersOrSubmodules = await this.requiresFiltersOrSubmodules(repository, checkpoint.worktreeCommit);
      return { grant, source: { ref: checkpoint.checkpointRef, commit: checkpoint.worktreeCommit, requiresFiltersOrSubmodules, remote: info.remote, origin: await this.options.origin(grant.attachment.projectId), checkpoint }, checkpoint };
    }));
    return { assignments };
  }

  async ready(raw: unknown) {
    const input = RuntimeAttachmentReadyInputSchema.parse(raw);
    await this.options.authorizeMachine(input.machineId);
    const result = this.options.attachments.ready(input);
    this.options.publish();
    return result;
  }
}
