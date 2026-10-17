import { mkdir, realpath, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { RuntimeAttachResultSchema } from '@gitspace/protocol-runtime';
import type { z } from 'zod';
import type { ExecutorJournal, LocalAttachment } from './journal.js';
import { runSupervisorCommand, type RunExecutorCommand } from './commands.js';
import { acquireCheckout, CHECKOUT_ACQUIRING_MARKER } from './artifactfs.js';
import type { ArtifactFsHost, CheckoutSource } from './artifactfs.js';

export type AttachmentEnrollment = z.infer<typeof RuntimeAttachResultSchema>;
export type AttachmentPreparation = {
  enrolled: AttachmentEnrollment;
  source: {
    repository: CheckoutSource;
    host: ArtifactFsHost;
    requiresFiltersOrSubmodules: boolean;
    hydrateLfs(directory: string): Promise<void>;
    submoduleEnvironment(directory: string): Promise<Record<string, string>>;
  } | null;
  /** The workspace's standard checkout path. */
  canonicalPath: string;
  deadlineAt: string;
  signal: AbortSignal;
  /** `acquired`: this preparation created the checkout (a new one, or one an unfinished acquisition left), so it holds
   * only its source. */
  prerequisites: (local: LocalAttachment, signal: AbortSignal, acquired: boolean) => Promise<void>;
};

/** A Git checkout whose acquisition did not finish: it still carries the marker, or (left by a version without the
 * marker) its HEAD is detached and it has no branch at all, which a finished checkout always has. */
async function unfinishedAcquisition(rootPath: string, git: (args: string[]) => Promise<{ exitCode: number; output: string }>): Promise<boolean> {
  if (await lstat(join(rootPath, '.git', CHECKOUT_ACQUIRING_MARKER)).then(() => true, () => false)) return true;
  if ((await git(['symbolic-ref', '-q', 'HEAD'])).exitCode === 0) return false;
  const branches = await git(['for-each-ref', '--count=1', 'refs/heads']);
  return branches.exitCode === 0 && branches.output.trim() === '';
}

/** Each workspace has one checkout at its standard path. A checkout left by an earlier attachment is reused when it is on the workspace branch. */
export async function prepareMachineAttachment(journal: ExecutorJournal, options: AttachmentPreparation, runCommand: RunExecutorCommand = runSupervisorCommand): Promise<LocalAttachment> {
  const { attachment, executionSecret } = RuntimeAttachResultSchema.parse(options.enrolled);
  const rootPath = resolve(options.canonicalPath);
  let sequence = 0;
  const git = (args: string[]) => runCommand({ application: 'git', args, cwd: rootPath, attemptId: `attach-${attachment.attachmentId}-${attachment.generation}`, sequence: sequence++, deadlineAt: options.deadlineAt, signal: options.signal });
  const run = async (args: string[]) => {
    const result = await git(args);
    if (result.exitCode !== 0) throw new Error(result.output);
    return result.output.trim();
  };
  await mkdir(dirname(rootPath), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(rootPath)) !== dirname(rootPath)) throw new Error('Checkout parent must not contain symlinks');
  let exists = false;
  try {
    const entry = await lstat(rootPath);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(rootPath) !== rootPath) throw new Error('Checkout must be a physical directory');
    exists = true;
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const local: LocalAttachment = { attachment: { ...attachment, state: 'attaching' }, rootPath, executionSecret, prerequisitesComplete: false };
  journal.installAttachment(local);
  if (exists && await unfinishedAcquisition(rootPath, git)) {
    // An acquisition that failed part way (a submodule, LFS) never became a checkout: acquire it again.
    await rm(rootPath, { recursive: true, force: true });
    exists = false;
  }
  if (exists) {
    const head = await git(['symbolic-ref', '-q', '--short', 'HEAD']);
    if (head.exitCode !== 0 || head.output.trim() !== attachment.checkout.branch) throw new Error(`The checkout at ${rootPath} is not on the workspace branch ${attachment.checkout.branch}${head.exitCode !== 0 ? ' (its HEAD is detached)' : ''}; switch it back or move it aside`);
  } else {
    if (!options.source) throw new Error('The cloud did not send a source for this workspace checkout');
    await acquireCheckout({ name: basename(rootPath), directory: rootPath, source: options.source.repository, fixed: true, requiresFiltersOrSubmodules: options.source.requiresFiltersOrSubmodules, host: { ...options.source.host, root: dirname(rootPath) }, signal: options.signal, hydrateLfs: options.source.hydrateLfs, submoduleEnvironment: options.source.submoduleEnvironment });
    await run(['checkout', '-B', attachment.checkout.branch]);
    await rm(join(rootPath, '.git', CHECKOUT_ACQUIRING_MARKER), { force: true });
  }
  await options.prerequisites(local, options.signal, !exists);
  const ready: LocalAttachment = { ...local, prerequisitesComplete: true, attachment: { ...(journal.attachment(attachment.attachmentId)?.attachment ?? attachment), state: 'ready', updatedAt: new Date().toISOString() } };
  journal.installAttachment(ready);
  return ready;
}
