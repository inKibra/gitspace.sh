import { mkdir, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { RuntimeAttachResultSchema } from '@gitspace/protocol-runtime';
import type { z } from 'zod';
import type { ExecutorJournal, LocalAttachment } from './journal.js';
import { runSupervisorCommand, type RunExecutorCommand } from './commands.js';
import { acquireCheckout } from './artifactfs.js';
import type { ArtifactFsHost, CheckoutSource } from './artifactfs.js';

export type AttachmentEnrollment = z.infer<typeof RuntimeAttachResultSchema>;
export type AttachmentPreparation = {
  enrolled: AttachmentEnrollment;
  source: {
    repository: CheckoutSource;
    host: ArtifactFsHost;
    requiresFiltersOrSubmodules: boolean;
    hydrateLfs(directory: string): Promise<void>;
  } | null;
  /** The workspace's standard checkout path. */
  canonicalPath: string;
  deadlineAt: string;
  signal: AbortSignal;
  prerequisites: (local: LocalAttachment, signal: AbortSignal) => Promise<void>;
};

/** Each workspace has one checkout at its standard path. A checkout left by an earlier attachment is reused when it is on the workspace branch. */
export async function prepareMachineAttachment(journal: ExecutorJournal, options: AttachmentPreparation, runCommand: RunExecutorCommand = runSupervisorCommand): Promise<LocalAttachment> {
  const { attachment, executionSecret } = RuntimeAttachResultSchema.parse(options.enrolled);
  const rootPath = resolve(options.canonicalPath);
  let sequence = 0;
  const run = async (args: string[]) => {
    const result = await runCommand({ application: 'git', args, cwd: rootPath, attemptId: `attach-${attachment.attachmentId}-${attachment.generation}`, sequence: sequence++, deadlineAt: options.deadlineAt, signal: options.signal });
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
  if (exists) {
    if (await run(['symbolic-ref', '--short', 'HEAD']) !== attachment.checkout.branch) throw new Error(`The checkout at ${rootPath} is not on the workspace branch ${attachment.checkout.branch}; switch it back or move it aside`);
  } else {
    if (!options.source) throw new Error('The cloud did not send a source for this workspace checkout');
    await acquireCheckout({ name: basename(rootPath), directory: rootPath, source: options.source.repository, fixed: true, requiresFiltersOrSubmodules: options.source.requiresFiltersOrSubmodules, host: { ...options.source.host, root: dirname(rootPath) }, signal: options.signal, hydrateLfs: options.source.hydrateLfs });
    await run(['checkout', '-B', attachment.checkout.branch]);
  }
  await options.prerequisites(local, options.signal);
  const ready: LocalAttachment = { ...local, prerequisitesComplete: true, attachment: { ...(journal.attachment(attachment.attachmentId)?.attachment ?? attachment), state: 'ready', updatedAt: new Date().toISOString() } };
  journal.installAttachment(ready);
  return ready;
}
