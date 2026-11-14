import { z } from 'zod';
import { workspaceStatusRowSchema, type WorkspaceStatusRow, type workspaceStatusMessageSchema } from '@gitspace/protocol/account-directory';
import type { WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { ACCOUNT_GROUP, savedCopy, schemaForm, type SavedCopy } from './first-paint-cache.js';

/** The sidebar's status rows: every row when the directory socket opens, then one row per change. Until the socket's
 * first rows arrive, the rows this browser saved last time. */
export class WorkspaceStatuses {
  private readonly rows = new Map<string, WorkspaceStatusRow>();
  private readonly listeners = new Set<() => void>();
  private received = false;

  constructor(private readonly saved?: SavedCopy<WorkspaceStatusRow[]>) {}

  receive(message: z.infer<typeof workspaceStatusMessageSchema>): void {
    if (message.type === 'statuses') {
      this.rows.clear();
      for (const row of message.rows) this.rows.set(row.workspaceId, row);
    } else this.rows.set(message.workspaceId, { projectId: message.projectId, workspaceId: message.workspaceId, status: message.status });
    this.received = true;
    this.saved?.write([...this.rows.values()]);
    for (const listener of [...this.listeners]) listener();
  }

  get(workspaceId: string): WorkspaceStatusSummary | undefined {
    if (!this.received && this.rows.size === 0) for (const row of this.saved?.read() ?? []) this.rows.set(row.workspaceId, row);
    return this.rows.get(workspaceId)?.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export const workspaceStatuses = new WorkspaceStatuses(savedCopy(ACCOUNT_GROUP, 'statuses', schemaForm(z.array(workspaceStatusRowSchema))));
