// The `blocks` builders that read code: diff, excerpt and changeSet, from the workspace's cloud working copy through the
// checkouts the Inspector reads (cloud-repository.ts). commandRun and testReport read job records in runtime-core.
import { changeSetBlock, diffBlock, excerptBlock, packageCandidates, PACKAGE_MANIFESTS, type BuiltBlock, type ChangeSetFile } from '@gitspace/protocol/block-builders';
import type { RepositoryStatus } from '@gitspace/protocol/inspector-contract';
import type { RuntimeBlocksArguments } from '@gitspace/protocol-runtime/tool-arguments';
import type { InspectorCloudContext } from './account-inspector-data.js';
import { cloudPackageFolders, cloudRepositoryDiff, cloudRepositoryFile, withCloudCheckout, withPinnedCloudCheckout, type CloudCheckout } from './cloud-repository.js';

/** A changed file's status as a ChangeSet shows it: an untracked or copied file is a new one. */
const CHANGE_STATUS: Record<Exclude<RepositoryStatus, 'clean'>, ChangeSetFile['status']> = {
  added: 'added', untracked: 'added', copied: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed', conflicted: 'conflicted',
};

/** The block a code-reading `blocks` call builds from the workspace's cloud working copy. */
export async function cloudBlock(env: Env, userId: string, source: InspectorCloudContext, args: RuntimeBlocksArguments): Promise<BuiltBlock<unknown>> {
  switch (args.op) {
    case 'diff': return withCloudCheckout(env, userId, source, 'base', args.base ?? null, async checkout => {
      const view = await cloudRepositoryDiff(env, userId, checkout, 'base', args.path);
      return diffBlock({ path: args.path, patch: view.patch, base: `${args.base ?? source.project.baseBranch} (merge base ${checkout.baseCommit.slice(0, 7)})` });
    });
    case 'excerpt': {
      const read = (checkout: CloudCheckout) => cloudRepositoryFile(env, userId, checkout, 'current', args.path);
      const file = args.commit === undefined ? await withCloudCheckout(env, userId, source, 'current', null, read) : await withPinnedCloudCheckout(env, source, args.commit, args.commit, read);
      if (file.binary) throw new Error(`${args.path} is a binary file`);
      // A file unchanged since HEAD is HEAD's version: pinned, the excerpt's link keeps opening these lines.
      const commit = args.commit ?? (file.status === 'clean' ? file.headCommit : null);
      return excerptBlock({ path: args.path, text: file.content, start: args.start, end: args.end, commit, highlight: args.highlight, note: args.note });
    }
    case 'changeSet': return withCloudCheckout(env, userId, source, 'base', args.base ?? null, async checkout => {
      const view = await cloudRepositoryDiff(env, userId, checkout, 'base', null);
      const files = view.files.flatMap(file => file.status === 'clean' ? [] : [{ path: file.path, added: file.additions ?? 0, removed: file.deletions ?? 0, status: CHANGE_STATUS[file.status], binary: file.binary ? true : null }]);
      const packages = await cloudPackageFolders(checkout, packageCandidates(files.map(file => file.path)), PACKAGE_MANIFESTS);
      return changeSetBlock({ base: `${args.base ?? source.project.baseBranch} (merge base ${checkout.baseCommit.slice(0, 7)})`, head: view.headCommit.slice(0, 7), files, packages });
    });
    default: throw new Error(`blocks ${args.op} reads a job or process, not the working copy`);
  }
}
