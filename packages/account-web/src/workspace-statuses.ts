import { z } from 'zod';
import { workspaceStatusRowSchema, type WorkspaceStatusRow, type workspaceStatusMessageSchema } from '@gitspace/protocol/account-directory';
import { ACCOUNT_GROUP, savedCopy, schemaForm, type SavedCopy } from './first-paint-cache.js';

/** The sidebar's status rows: every row when the directory socket opens, then one row per change. Until the socket's
 * first rows arrive, the rows this browser saved last time. */
export class WorkspaceStatuses {
  private readonly rows = new Map<string, WorkspaceStatusRow>();
  private readonly listeners = new Set<() => void>();
  private received = false;
  private version = 0;

  constructor(private readonly saved?: SavedCopy<WorkspaceStatusRow[]>) {}

  receive(message: z.input<typeof workspaceStatusMessageSchema>): void {
    if (message.type === 'statuses') {
      this.rows.clear();
      for (const row of message.rows) this.rows.set(row.workspaceId, workspaceStatusRowSchema.parse(row));
    } else {
      const { type: _type, ...row } = message;
      this.rows.set(message.workspaceId, workspaceStatusRowSchema.parse(row));
    }
    this.received = true;
    this.version += 1;
    this.saved?.write([...this.rows.values()]);
    for (const listener of [...this.listeners]) listener();
  }

  /** A workspace's status row: its status, its last-message preview, its open items and its goal. */
  get(workspaceId: string): WorkspaceStatusRow | undefined {
    this.restore();
    return this.rows.get(workspaceId);
  }

  /** Every row. */
  all(): WorkspaceStatusRow[] {
    this.restore();
    return [...this.rows.values()];
  }

  /** Grows with every message, for `useSyncExternalStore`. */
  revision = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private restore(): void {
    if (!this.received && this.rows.size === 0) for (const row of this.saved?.read() ?? []) this.rows.set(row.workspaceId, row);
  }
}

export const workspaceStatuses = new WorkspaceStatuses(savedCopy(ACCOUNT_GROUP, 'statuses', schemaForm(z.array(workspaceStatusRowSchema))));
