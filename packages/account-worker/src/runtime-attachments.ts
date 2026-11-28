import { RuntimeAssignmentSchema, RuntimeAttachmentReadyInputSchema, RuntimeAssignmentsInputSchema, RuntimeAttachmentSchema, RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime';
import type { RuntimeAttachment, RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import type { AttachmentStore, ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { z } from 'zod';

export const CheckoutSourceFactsSchema = z.object({ commit: z.string(), remote: z.string(), requiresFiltersOrSubmodules: z.boolean() });
export type CheckoutSourceFacts = z.infer<typeof CheckoutSourceFactsSchema>;

/** What the fleet catalog holds of one workspace for one machine, written by the workspace: what
 * `RuntimeAttachmentController.assignments` answers there, with each execution grant still sealed. */
export const MachineWorkspaceAssignmentsSchema = z.object({
  attachments: z.array(z.object({ attachment: RuntimeAttachmentSchema, sealedSecret: z.string() })),
  source: RuntimeAssignmentSchema.shape.source,
  checkpoint: RuntimeGitCheckpointSchema.nullable(),
});
export type MachineWorkspaceAssignments = z.infer<typeof MachineWorkspaceAssignmentsSchema>;

export const executorCapabilities = ['read', 'write', 'edit', 'apply_patch', 'bash', 'grep', 'find', 'ast_grep', 'ast_edit', 'ast_resolve', 'proc', 'service', 'browser', 'sync_machine', 'import_ref', 'publish_commit', 'drive_transfer'];

/** Operating system names a `needs` may use for a platform's OS; macOS reports itself as `darwin`. */
const OS_CAPABILITIES: Record<string, readonly string[]> = { darwin: ['darwin', 'macos'], linux: ['linux'] };

/** What a machine offers to `needs`: every executor's tools, then its platform as it reported it (`darwin-arm64`), its
 * operating system (`darwin`, `macos`) and its architecture (`arm64`). */
export function machineCapabilities(platform: string | null): string[] {
  if (platform === null) return [...executorCapabilities];
  const [os = '', arch = ''] = platform.split('-');
  return [...executorCapabilities, platform, ...(OS_CAPABILITIES[os] ?? [os]), arch];
}

export type RuntimeAttachmentControllerOptions = {
  attachments: AttachmentStore;
  code: ArtifactsCodeStore;
  snapshot(): Promise<RuntimeSnapshotCommitInput['checkpoint'] | null>;
  /** Canonical project origin; never supplied by the request or the execution grant. */
  origin(projectId: string): Promise<string | null>;
  /** Enrollment/trust checks are required even when the target is offline. */
  authorizeMachine(machineId: RuntimeAttachment['machineId']): Promise<void>;
  /** What the machine offers to `needs`: its tools and platform (`machineCapabilities`). */
  capabilities(machineId: RuntimeAttachment['machineId']): Promise<string[]>;
  /** What the last assignment read learned about a commit's checkout: computed once per commit, not per read. */
  sourceFacts: { read(): Promise<CheckoutSourceFacts | null>; write(facts: CheckoutSourceFacts): Promise<void> };
};
export type CheckoutSourceServices = Pick<RuntimeAttachmentControllerOptions, 'code' | 'origin' | 'sourceFacts'>;

async function requiresFiltersOrSubmodules(code: ArtifactsCodeStore, repository: string, commit: string) {
  const metadata = await code.readCommit(repository, commit);
  if (!metadata) throw new Error('Selected snapshot commit is unavailable');
  const trees = [metadata.treeHash];
  while (trees.length) {
    const next = trees.pop();
    if (!next) break;
    const tree = await code.readTree(repository, next);
    if (!tree) throw new Error('Selected snapshot tree is unavailable');
    for (const entry of tree) {
      if (entry.type === 'gitlink' || entry.name === '.gitattributes' || entry.name === '.gitmodules') return true;
      if (entry.type === 'tree') trees.push(entry.hash);
    }
  }
  return false;
}

/** Where a machine's checkout of the workspace's checkpoint comes from. */
export async function checkoutSource(services: CheckoutSourceServices, identity: Pick<RuntimeAttachment, 'projectId' | 'workspaceId'>, checkpoint: RuntimeSnapshotCommitInput['checkpoint']) {
  const repository = `workspace-${identity.workspaceId}`;
  let facts = await services.sourceFacts.read();
  if (facts?.commit !== checkpoint.worktreeCommit) {
    const [info, filtered] = await Promise.all([services.code.info(repository), requiresFiltersOrSubmodules(services.code, repository, checkpoint.worktreeCommit)]);
    facts = { commit: checkpoint.worktreeCommit, remote: info.remote, requiresFiltersOrSubmodules: filtered };
    await services.sourceFacts.write(facts);
  }
  return { ref: checkpoint.checkpointRef, commit: checkpoint.worktreeCommit, requiresFiltersOrSubmodules: facts.requiresFiltersOrSubmodules, remote: facts.remote, origin: await services.origin(identity.projectId), checkpoint };
}

/** Invoked behind canonical project/workspace and enrolled-machine authorization. */
export class RuntimeAttachmentController {
  constructor(private readonly options: RuntimeAttachmentControllerOptions) {}

  async assignments(raw: unknown) {
    const input = RuntimeAssignmentsInputSchema.parse(raw);
    await this.options.authorizeMachine(input.machineId);
    const assigned = await this.options.attachments.assignments(input.machineId, await this.options.capabilities(input.machineId));
    const assignments = await Promise.all(assigned.map(async ({ grant }) => {
      const checkpoint = await this.options.snapshot();
      return { grant, source: checkpoint ? await checkoutSource(this.options, grant.attachment, checkpoint) : null, checkpoint };
    }));
    return { assignments };
  }

  async ready(raw: unknown) {
    const input = RuntimeAttachmentReadyInputSchema.parse(raw);
    await this.options.authorizeMachine(input.machineId);
    return this.options.attachments.ready(input);
  }
}
