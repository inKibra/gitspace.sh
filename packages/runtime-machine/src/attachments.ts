import { mkdir, realpath, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { RuntimeAttachResultSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import type { z } from 'zod';
import { ExecutorJournal, type LocalAttachment } from './journal.js';
import { runSupervisorCommand, type RunExecutorCommand } from './commands.js';
import { acquireCheckout } from './artifactfs.js';
import type { ArtifactFsHost, CheckoutSource } from './artifactfs.js';

export type AttachmentEnrollment = z.infer<typeof RuntimeAttachResultSchema>;
export type AttachmentPreparation = {
  enrolled: AttachmentEnrollment;
  source: { kind: 'local'; repository: string } | {
    kind: 'artifacts';
    repository: CheckoutSource;
    host: ArtifactFsHost;
    requiresFiltersOrSubmodules: boolean;
    hydrateLfs(directory: string): Promise<void>;
  };
  checkoutRoot: string;
  canonicalPath?: string;
  adoptExisting?: boolean;
  deadlineAt: string;
  signal: AbortSignal;
  prerequisites: (local: LocalAttachment, signal: AbortSignal) => Promise<void>;
};

/** Canonical caches share one standard path per workspace; explicit execution copies remain isolated. */
export async function prepareMachineAttachment(journal: ExecutorJournal, options: AttachmentPreparation, runCommand: RunExecutorCommand = runSupervisorCommand): Promise<LocalAttachment> {
  const { attachment, executionSecret } = RuntimeAttachResultSchema.parse(options.enrolled);
  const prior = journal.attachment(attachment.attachmentId);
  if (prior && prior.attachment.cache?.state !== 'reclaimed') {
    if (prior.attachment.generation !== attachment.generation || prior.executionSecret !== executionSecret || JSON.stringify(prior.attachment.checkout) !== JSON.stringify(attachment.checkout)) throw new Error('Attachment recovery changed admission');
    if (prior.checkoutPrepared === false) throw new Error('Attachment acquisition was interrupted; explicit cleanup is required before re-enrollment');
    if (prior.attachment.state === 'draining' || prior.attachment.state === 'lost' || prior.attachment.state === 'detached') throw new Error('Fenced attachment cannot resume preparation');
    await realpath(prior.rootPath);
    if (!prior.prerequisitesComplete) {
      await options.prerequisites(prior, options.signal);
      prior.prerequisitesComplete = true;
      prior.attachment = { ...(journal.attachment(attachment.attachmentId)?.attachment ?? attachment), state: 'ready', updatedAt: new Date().toISOString() };
      journal.installAttachment(prior);
    }
    return prior;
  }
  const source = options.source.kind === 'local' ? await realpath(options.source.repository) : null;
  let sequence = 0;
  const run = async (args: string[], cwd: string) => {
    const result = await runCommand({ application: 'git', args, cwd, attemptId: `attach-${attachment.attachmentId}-${attachment.generation}-${attachment.cacheAction?.requestId ?? 'initial'}`, sequence: sequence++, deadlineAt: options.deadlineAt, signal: options.signal });
    if (result.exitCode !== 0) throw new Error(result.output);
    return result.output.trim();
  };
  let rootPath = source ?? options.checkoutRoot;
  let ownedCheckout = false;
  if (attachment.role === 'cache') {
    if (attachment.checkout.kind !== 'shared' || !options.canonicalPath) throw new Error('Canonical cache requires the standard workspace path');
    rootPath = resolve(options.canonicalPath);
    await mkdir(dirname(rootPath), { recursive: true, mode: 0o700 });
    if (await realpath(dirname(rootPath)) !== dirname(rootPath)) throw new Error('Canonical checkout parent must not contain symlinks');
    let exists = false;
    try {
      const entry = await lstat(rootPath);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(rootPath) !== rootPath) throw new Error('Canonical checkout must be a physical directory');
      exists = true;
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (exists && !options.adoptExisting) throw new Error('Unclaimed canonical checkout already exists');
    journal.installAttachment({ attachment: { ...attachment, state: 'attaching' }, rootPath, executionSecret, prerequisitesComplete: false, checkoutPrepared: false, ownedCheckout: !exists });
    if (!exists) {
      ownedCheckout = true;
      if (options.source.kind === 'artifacts') {
        await acquireCheckout({ name: basename(rootPath), directory: rootPath, source: options.source.repository, fixed: true, requiresFiltersOrSubmodules: options.source.requiresFiltersOrSubmodules, host: { ...options.source.host, root: dirname(rootPath) }, signal: options.signal, hydrateLfs: options.source.hydrateLfs });
      } else {
        if (!source) throw new Error('Canonical cache requires a source');
        await run(['clone', '--no-hardlinks', '--', source, rootPath], dirname(rootPath));
        await run(['remote', 'remove', 'origin'], rootPath);
      }
      await run(['checkout', '-B', attachment.checkout.branch], rootPath);
    } else {
      const branch = await run(['symbolic-ref', '--short', 'HEAD'], rootPath);
      if (branch !== attachment.checkout.branch) throw new Error('Canonical branch does not match attachment checkout');
    }
  } else if (attachment.checkout.kind !== 'shared') {
    await mkdir(options.checkoutRoot, { recursive: true, mode: 0o700 });
    rootPath = resolve(options.checkoutRoot, Buffer.from(attachment.attachmentId).toString('base64url'));
    if (await realpath(options.checkoutRoot) !== resolve(options.checkoutRoot)) throw new Error('Private checkout parent must not contain symlinks');
    try { await lstat(rootPath); throw new Error('Unclaimed private checkout already exists'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    journal.installAttachment({ attachment: { ...attachment, state: 'attaching' }, rootPath, executionSecret, prerequisitesComplete: false, checkoutPrepared: false });
    if (options.source.kind === 'artifacts') {
      if (options.source.repository.commit !== attachment.checkout.commit) throw new Error('Artifacts assignment source does not match attachment commit');
      await acquireCheckout({
        name: Buffer.from(attachment.attachmentId).toString('base64url'), directory: rootPath,
        source: options.source.repository, fixed: attachment.checkout.kind === 'snapshot',
        requiresFiltersOrSubmodules: options.source.requiresFiltersOrSubmodules,
        host: options.source.host, signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1, Date.parse(options.deadlineAt) - Date.now()))]),
        hydrateLfs: options.source.hydrateLfs,
      });
    } else {
      if (!source) throw new Error('Local attachment source is missing');
      await run(['clone', '--no-hardlinks', '--no-checkout', '--', source, rootPath], options.checkoutRoot);
      await run(['remote', 'remove', 'origin'], rootPath);
    }
    const commit = await run(['rev-parse', '--verify', `${attachment.checkout.commit}^{commit}`], rootPath);
    if (commit !== attachment.checkout.commit) throw new Error('Attachment source commit does not match requested immutable commit');
    if (attachment.checkout.kind === 'branch') {
      if (attachment.role !== 'delegate') throw new Error('Only delegates may acquire branch checkouts');
      await run(['check-ref-format', '--branch', attachment.checkout.branch], rootPath);
      if (options.source.kind === 'artifacts') await run(['checkout', '-B', attachment.checkout.branch, commit], rootPath);
      else await run(['checkout', '-b', attachment.checkout.branch, commit], rootPath);
    } else if (options.source.kind === 'local') await run(['checkout', '--detach', commit], rootPath);
  } else {
    throw new Error('Only canonical caches may use the shared checkout');
  }
  const local: LocalAttachment = { attachment: { ...attachment, state: 'attaching' }, rootPath, executionSecret, prerequisitesComplete: false, checkoutPrepared: true, ownedCheckout };
  journal.installAttachment(local);
  await options.prerequisites(local, options.signal);
  local.prerequisitesComplete = true;
  local.attachment = { ...(journal.attachment(attachment.attachmentId)?.attachment ?? attachment), state: 'ready', updatedAt: new Date().toISOString() };
  journal.installAttachment(local);
  return local;
}

/** Explicit merge belongs only to a currently fenced cache. The returned commit is the integration evidence. */
export async function mergeDelegateCommit(input: { cache: LocalAttachment; delegate: LocalAttachment; expectedCacheCommit: string; commit: string; attemptId: string; deadlineAt: string; signal: AbortSignal }, runCommand: RunExecutorCommand = runSupervisorCommand): Promise<{ commit: string; sourceCommit: string }> {
  if (input.cache.attachment.role !== 'cache' || input.delegate.attachment.role !== 'delegate' || input.cache.attachment.projectId !== input.delegate.attachment.projectId || input.cache.attachment.workspaceId !== input.delegate.attachment.workspaceId) throw new Error('Merge attachment relationship is unauthorized');
  if (!/^[a-f0-9]{40,64}$/u.test(input.commit) || !/^[a-f0-9]{40,64}$/u.test(input.expectedCacheCommit)) throw new Error('Merge requires full immutable commit IDs');
  let sequence = 0;
  const run = async (args: string[]) => {
    const result = await runCommand({ application: 'git', args, cwd: input.cache.rootPath, attemptId: input.attemptId, sequence: sequence++, deadlineAt: input.deadlineAt, signal: input.signal });
    if (result.exitCode !== 0) throw new Error(result.output);
    return result.output.trim();
  };
  if (await run(['rev-parse', 'HEAD']) !== input.expectedCacheCommit) throw new Error('Cache source commit changed before merge');
  if (await run(['status', '--porcelain'])) throw new Error('Cache checkout must be clean before merge');
  await run(['fetch', '--no-tags', '--', input.delegate.rootPath, input.commit]);
  await run(['merge', '--no-edit', '--no-ff', input.commit]);
  return { commit: await run(['rev-parse', 'HEAD']), sourceCommit: input.commit };
}

/** Draining is explicit cloud authorization, persisted locally before stopping effects. */
export async function cleanupMachineAttachment(journal: ExecutorJournal, input: {
  attachment: RuntimeAttachment; checkoutRoot: string; canonicalPath?: string; signal: AbortSignal;
  stopAndVerify(local: LocalAttachment): Promise<void | false>;
  verifyUnmounted(rootPath: string): Promise<void>;
}): Promise<LocalAttachment> {
  const assigned = input.attachment;
  const local = journal.attachment(assigned.attachmentId);
  if (!local) throw new Error('Cleanup requires a recorded owned checkout');
  const previous = local.attachment;
  if (assigned.state !== 'draining') throw new Error('Cleanup requires explicit draining attachment');
  if (previous.role !== assigned.role || previous.generation !== assigned.generation || previous.ownershipGeneration !== assigned.ownershipGeneration || previous.projectId !== assigned.projectId || previous.workspaceId !== assigned.workspaceId || previous.machineId !== assigned.machineId || JSON.stringify(previous.checkout) !== JSON.stringify(assigned.checkout)) throw new Error('Cleanup admission changed');
  if (assigned.role === 'cache' && !local.ownedCheckout) {
    if (assigned.checkout.kind !== 'shared') throw new Error('Canonical cleanup requires shared checkout');
    if (previous.state !== 'detached') journal.installAttachment({ ...local, attachment: assigned });
    input.signal.throwIfAborted();
    if (await input.stopAndVerify(local) === false) return journal.attachment(assigned.attachmentId) ?? local;
    if (journal.unresolved(previous).length) throw new Error('Cleanup blocked by unresolved executor effects');
    const detached: LocalAttachment = { ...local, attachment: { ...assigned, state: 'detached', updatedAt: new Date().toISOString() } };
    journal.installAttachment(detached);
    return detached;
  }
  const parent = resolve(input.checkoutRoot);
  if (await realpath(parent) !== parent) throw new Error('Cleanup parent must not contain symlinks');
  const expected = assigned.role === 'cache' && input.canonicalPath ? resolve(input.canonicalPath) : resolve(parent, Buffer.from(assigned.attachmentId).toString('base64url'));
  if (resolve(local.rootPath) !== expected) throw new Error('Cleanup target is not the exact owned checkout');
  if (journal.attachments().some(other => {
    if (other.attachment.attachmentId === assigned.attachmentId) return false;
    const otherRoot = resolve(other.rootPath);
    return otherRoot === expected || otherRoot.startsWith(`${expected}/`) || expected.startsWith(`${otherRoot}/`);
  })) throw new Error('Cleanup target overlaps another attachment');
  if (previous.state !== 'detached') journal.installAttachment({ ...local, attachment: assigned });
  input.signal.throwIfAborted();
  if (await input.stopAndVerify(local) === false) return journal.attachment(assigned.attachmentId) ?? local;
  if (journal.unresolved(previous).length) throw new Error('Cleanup blocked by unresolved executor effects');
  await input.verifyUnmounted(expected);
  try {
    const entry = await lstat(expected);
    if (entry.isSymbolicLink() || !entry.isDirectory() || await realpath(expected) !== expected) throw new Error('Cleanup target is not an owned physical directory');
    input.signal.throwIfAborted();
    await rm(expected, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  try { await lstat(expected); throw new Error('Cleanup directory remains present'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const detached: LocalAttachment = { ...local, attachment: { ...assigned, state: assigned.role === 'cache' && !assigned.detachRequest ? 'attaching' : 'detached', ...(assigned.cache ? { cache: { ...assigned.cache, state: 'reclaimed', activity: [], reclaimBlocked: null } } : {}), updatedAt: new Date().toISOString() } };
  journal.installAttachment(detached);
  return detached;
}
