import { createHash } from 'node:crypto';
import { lstat, realpath, open, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { LocalAttachment, ExecutorJournal } from './journal.js';

const Change = z.object({ path: z.string(), before: z.string(), after: z.string() });
const resolving = new WeakMap<ExecutorJournal, Set<string>>();
const Proposal = z.object({ scope: z.string(), state: z.enum(['staged', 'applying', 'applied', 'rejected']), changes: z.array(Change) });
function scope(local: LocalAttachment): string {
  const a = local.attachment;
  return JSON.stringify([a.projectId, a.workspaceId, a.machineId, a.attachmentId, a.generation, a.checkout, local.rootPath]);
}
export async function proposalPath(root: string, path: string): Promise<string> {
  const canonical = await realpath(root);
  if (canonical !== resolve(root)) throw new Error('AST checkout root must not be a symlink');
  const target = resolve(root, path), rel = relative(canonical, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('AST path leaves checkout');
  let current = canonical;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error('AST paths must not contain symlinks');
  }
  if (!(await lstat(target)).isFile()) throw new Error('AST target must be a regular file');
  return target;
}
export function stageProposal(journal: ExecutorJournal, local: LocalAttachment, attemptId: string, changes: z.infer<typeof Change>[]): string {
  const proposal = Proposal.parse({ scope: scope(local), state: 'staged', changes });
  const id = createHash('sha256').update(JSON.stringify([proposal.scope, attemptId, changes])).digest('hex');
  const prior = journal.proposal(id);
  if (prior === null) journal.saveProposal(id, proposal);
  else if (Proposal.parse(prior).scope !== proposal.scope || JSON.stringify(Proposal.parse(prior).changes) !== JSON.stringify(changes)) throw new Error('AST proposal identity conflict');
  return id;
}
export async function resolveProposal(journal: ExecutorJournal, local: LocalAttachment, id: string, action: 'apply' | 'reject', signal: AbortSignal): Promise<string> {
  let active = resolving.get(journal);
  if (!active) { active = new Set(); resolving.set(journal, active); }
  if (active.has(id)) throw new Error('AST proposal resolution already in progress');
  active.add(id);
  try { return await resolveStoredProposal(journal, local, id, action, signal); }
  finally { active.delete(id); }
}
async function resolveStoredProposal(journal: ExecutorJournal, local: LocalAttachment, id: string, action: 'apply' | 'reject', signal: AbortSignal): Promise<string> {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid AST proposal identity');
  const stored = journal.proposal(id);
  if (stored === null) throw new Error('Unknown AST proposal');
  const proposal = Proposal.parse(stored);
  if (proposal.scope !== scope(local)) throw new Error('AST proposal attachment or generation changed');
  if (proposal.state === 'applied' || proposal.state === 'rejected') {
    if ((action === 'apply') !== (proposal.state === 'applied')) throw new Error('AST proposal already resolved differently');
    return proposal.state;
  }
  if (action === 'reject') {
    if (proposal.state === 'applying') throw new Error('AST proposal application may be partial; resume apply, not reject');
    journal.saveProposal(id, { ...proposal, state: 'rejected' });
    return 'rejected';
  }
  const paths = new Set<string>();
  const files: { handle: FileHandle; after: string; before: string; current: string }[] = [];
  try {
    // Open and validate every preimage before the first source write. O_NOFOLLOW
    // also rejects replacement of the final path by a symlink after inspection.
    for (const change of proposal.changes) {
      const path = await proposalPath(local.rootPath, change.path);
      if (paths.has(path)) throw new Error('Duplicate AST proposal path');
      paths.add(path);
      const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
      files.push({ handle, after: change.after, before: change.before, current: '' });
      const file = files[files.length - 1]!;
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('AST target must be an unlinked regular checkout file');
      if (await proposalPath(local.rootPath, change.path) !== path) throw new Error('AST source path changed');
      file.current = await handle.readFile('utf8');
      if (file.current !== change.before && !(proposal.state === 'applying' && file.current === change.after)) throw new Error('AST proposal source changed; no further writes performed');
    }
    signal.throwIfAborted();
    journal.saveProposal(id, { ...proposal, state: 'applying' });
    for (const file of files) {
      signal.throwIfAborted();
      if (file.current === file.after) continue;
      // Multi-file application is resumable, not atomic. A torn individual write
      // remains an explicit conflict instead of silently overwriting user edits.
      const bytes = Buffer.from(file.after);
      let offset = 0;
      while (offset < bytes.length) offset += (await file.handle.write(bytes, offset, bytes.length - offset, offset)).bytesWritten;
      await file.handle.truncate(bytes.length);
      await file.handle.sync();
    }
    journal.saveProposal(id, { ...proposal, state: 'applied' });
    return 'applied';
  } catch (error) {
    throw new Error(`AST proposal ${id} unresolved; durable resolution state retained for recovery: ${error instanceof Error ? error.message : String(error)}`);
  } finally { await Promise.all(files.map(file => file.handle.close())); }
}
