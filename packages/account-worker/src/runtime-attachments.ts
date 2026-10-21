import { RuntimeAttachmentReadyInputSchema, RuntimeAssignmentsInputSchema } from '@gitspace/protocol-runtime';
import type { RuntimeAttachment, RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import type { AttachmentStore, ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { z } from 'zod';

export const CheckoutSourceFactsSchema = z.object({ commit: z.string(), remote: z.string(), requiresFiltersOrSubmodules: z.boolean() });
export type CheckoutSourceFacts = z.infer<typeof CheckoutSourceFactsSchema>;

export const executorCapabilities = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find', 'ast_grep', 'ast_edit', 'ast_resolve', 'proc', 'service', 'browser', 'sync_machine', 'import_ref', 'drive_transfer'];

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
    /** What the last assignment read learned about a commit's checkout: computed once per commit, not per read. */
    sourceFacts: { read(): Promise<CheckoutSourceFacts | null>; write(facts: CheckoutSourceFacts): Promise<void> };
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
      let facts = await this.options.sourceFacts.read();
      if (facts?.commit !== checkpoint.worktreeCommit) {
        const [info, requiresFiltersOrSubmodules] = await Promise.all([this.options.code.info(repository), this.requiresFiltersOrSubmodules(repository, checkpoint.worktreeCommit)]);
        facts = { commit: checkpoint.worktreeCommit, remote: info.remote, requiresFiltersOrSubmodules };
        await this.options.sourceFacts.write(facts);
      }
      const { remote, requiresFiltersOrSubmodules } = facts;
      return { grant, source: { ref: checkpoint.checkpointRef, commit: checkpoint.worktreeCommit, requiresFiltersOrSubmodules, remote, origin: await this.options.origin(grant.attachment.projectId), checkpoint }, checkpoint };
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
