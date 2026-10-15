import type { z } from 'zod';
import type { workspaceStatusMessageSchema } from '@gitspace/protocol/account-directory';
import type { WorkspaceStatusSummary } from '@gitspace/protocol-workspace';

/** The sidebar's status rows: every row when the directory socket opens, then one row per change. */
export class WorkspaceStatuses {
  private readonly rows = new Map<string, WorkspaceStatusSummary>();
  private readonly listeners = new Set<() => void>();

  receive(message: z.infer<typeof workspaceStatusMessageSchema>): void {
    if (message.type === 'statuses') {
      this.rows.clear();
      for (const row of message.rows) this.rows.set(row.workspaceId, row.status);
    } else this.rows.set(message.workspaceId, message.status);
    for (const listener of [...this.listeners]) listener();
  }

  get(workspaceId: string): WorkspaceStatusSummary | undefined {
    return this.rows.get(workspaceId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export const workspaceStatuses = new WorkspaceStatuses();
