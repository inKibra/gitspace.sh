import { z } from 'zod';
import { WORKER_MANIFEST_FILE } from '@gitspace/protocol';

export const frontendManifestSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1),
    hash: z.templateLiteral(['sha256:', z.string().regex(/^[a-f0-9]{64}$/u)]),
    size: z.number().int().nonnegative(),
  })),
});
export type FrontendManifest = z.infer<typeof frontendManifestSchema>;

export interface ReleaseObjectKeys {
  /** Worker manifest; its modules live beside it at `workerModuleKey(worker, name)`. */
  worker: string;
  machine: string;
  frontendManifest: string;
  /** Prefix of the frontend tree; files live at `<frontend>/<path>`. */
  frontend: string;
}

export function releaseObjectKeys(sha: string): ReleaseObjectKeys {
  return {
    worker: `releases/${sha}/${WORKER_MANIFEST_FILE}`,
    machine: `releases/${sha}/machine.manifest.json`,
    frontendManifest: `releases/${sha}/frontend.manifest.json`,
    frontend: `releases/${sha}/frontend`,
  };
}

/** Frontend trees are hundreds of small lazily loaded chunks; each transfer is a signed round trip. */
export const FRONTEND_TRANSFER_CONCURRENCY = 16;

/** Runs `task` over every item with bounded concurrency; after any failure no new task starts. */
export async function forEachConcurrent<T>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try { await task(items[index]!, index); } catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

