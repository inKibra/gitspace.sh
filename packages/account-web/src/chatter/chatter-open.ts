import { useSyncExternalStore } from 'react';
import type { ChatterKind } from '@gitspace/protocol/chatter-contract';

/** A request to open a project's Chatter pane (docs/CHATTER-DESIGN.md §11): to show one post (`offset`, its topic's
 * thread loaded when this tab does not hold it), or with the composer filled (`draft`; the topic is suggested as usual).
 * `serial` tells two equal requests apart, so the pane handles each once. */
export type ChatterOpenRequest = { projectId: string; offset?: number; draft?: { text: string; kind: ChatterKind }; serial: number };

let latest: ChatterOpenRequest | null = null;
let serial = 0;
const listeners = new Set<() => void>();

/** Opens the Chatter pane of `projectId` in this tab, when one is mounted for it. */
export function openChatter(request: Omit<ChatterOpenRequest, 'serial'>): void {
  latest = { ...request, serial: ++serial };
  for (const listener of listeners) listener();
}

/** The latest open request for `projectId`, or null. */
export function useChatterOpenRequest(projectId: string): ChatterOpenRequest | null {
  const request = useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => latest);
  return request?.projectId === projectId ? request : null;
}
