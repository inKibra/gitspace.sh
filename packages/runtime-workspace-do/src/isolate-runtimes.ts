/**
 * The workspace runtimes open in this isolate. Durable Objects of one class can share an isolate, and the 128 MB limit
 * is the isolate's, so each object's memory lines say which others it shares with and what their latest estimates add
 * up to. Module state is per isolate.
 */
export type IsolateRuntimes = {
  /** Random, made on first use (workerd refuses random values at module scope); the same for every line of this isolate. */
  id: string;
  objectsOpen: number;
  /** The workspace of each open runtime, at most `LISTED_RUNTIMES`; one opened twice appears twice. */
  workspaceIds: string[];
};
export type IsolateRuntime = {
  /** Records this runtime's latest memory estimate. */
  estimated(totalBytes: number): void;
  close(): void;
};

const LISTED_RUNTIMES = 20;
let isolateId: string | undefined;
/** By runtime: its workspace and its latest estimate (0 until it has one). */
const open = new Map<object, { workspaceId: string; totalBytes: number }>();

export function openIsolateRuntime(workspaceId: string): IsolateRuntime {
  const key = {};
  const entry = { workspaceId, totalBytes: 0 };
  open.set(key, entry);
  return {
    estimated(totalBytes) { entry.totalBytes = totalBytes; },
    close() { open.delete(key); },
  };
}

/** The isolate's open runtimes and the sum of their latest estimates. */
export function isolateRuntimes(): { isolate: IsolateRuntimes; isolateTotalBytes: number } {
  isolateId ??= crypto.randomUUID();
  const entries = [...open.values()];
  return {
    isolate: { id: isolateId, objectsOpen: entries.length, workspaceIds: entries.slice(0, LISTED_RUNTIMES).map(entry => entry.workspaceId) },
    isolateTotalBytes: entries.reduce((sum, entry) => sum + entry.totalBytes, 0),
  };
}
