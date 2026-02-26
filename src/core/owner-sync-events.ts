import type { SyncCategory } from '../relay/protocol.js';

export type OwnerSyncWriteHandler = (category: SyncCategory) => void | Promise<void>;

let ownerSyncWriteHandler: OwnerSyncWriteHandler | null = null;

export function setOwnerSyncWriteHandler(handler: OwnerSyncWriteHandler | null): void {
  ownerSyncWriteHandler = handler;
}

export function notifyOwnerSyncCategoryDirty(category: SyncCategory): void {
  if (!ownerSyncWriteHandler) {
    return;
  }

  try {
    const result = ownerSyncWriteHandler(category);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch(() => {
        // best-effort sync only
      });
    }
  } catch {
    // best-effort sync only
  }
}
