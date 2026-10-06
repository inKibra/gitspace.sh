import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GitLfsObjectSchema, type GitLfsObject } from '@gitspace/protocol-workspace';

const Inventory = z.object({ version: z.literal(1), head: z.string().regex(/^[a-f0-9]{40,64}$/u), objects: z.array(GitLfsObjectSchema) });
type Git = (root: string, args: string[]) => Promise<Uint8Array>;

/** The saved ancestor boundary avoids revisiting unchanged history, including deleted paths. */
export async function committedLfsInventory(root: string, head: string | null, git: Git, scan: (root: string, revisions: string[]) => Promise<Map<string, GitLfsObject>>) {
  if (!head) return new Map<string, GitLfsObject>();
  const path = resolve(root, new TextDecoder().decode(await git(root, ['rev-parse', '--git-path', 'gitspace-lfs-inventory.json'])).trim());
  let previous: z.infer<typeof Inventory> | undefined;
  try {
    const parsed = Inventory.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (parsed.success) previous = parsed.data;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (previous?.head === head) return new Map(previous.objects.map(object => [object.oid, object]));
  let ancestor = false;
  if (previous) {
    try { await git(root, ['merge-base', '--is-ancestor', previous.head, head]); ancestor = true; } catch { /* Rewrite or missing ancestor requires one complete rescan. */ }
  }
  const objects = new Map<string, GitLfsObject>(ancestor && previous ? previous.objects.map(object => [object.oid, object]) : []);
  for (const [oid, object] of await scan(root, ancestor && previous ? [head, `^${previous.head}`] : [head])) objects.set(oid, object);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, head, objects: [...objects.values()] }));
  await rename(temporary, path);
  return objects;
}

const OriginInventory = z.object({
  version: z.literal(1),
  identity: z.string(),
  attempted: z.array(GitLfsObjectSchema),
  confirmed: z.array(GitLfsObjectSchema),
  cursor: z.string().optional(),
});

/** Local discovery classifications survive process restarts; only acknowledged positives are saved. */
export async function originLfsInventory(root: string, identity: string, git: Git) {
  const path = resolve(root, new TextDecoder().decode(await git(root, ['rev-parse', '--git-path', 'gitspace-lfs-origin-inventory.json'])).trim());
  let previous: z.infer<typeof OriginInventory> | undefined;
  try {
    const parsed = OriginInventory.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (parsed.success && parsed.data.identity === identity) previous = parsed.data;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const attempted = new Map(previous?.attempted.map(object => [object.oid, object]) ?? []);
  const confirmed = new Map(previous?.confirmed.map(object => [object.oid, object]) ?? []);
  return {
    attempted, confirmed,
    cursor: previous?.cursor,
    async save() {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, identity, attempted: [...attempted.values()], confirmed: [...confirmed.values()], cursor: this.cursor }));
      await rename(temporary, path);
    },
  };
}
