import { FactEventStore, factEvents, type AppendFactEvent, type GitSpaceDatabase } from '@gitspace/core';
import type { ProjectEvent } from '@gitspace/protocol';
import { asc, eq } from 'drizzle-orm';

export interface ProjectEventAuthority {
  appendProjectEvent(input: Omit<ProjectEvent, 'offset' | 'createdAt'> & { projectId: string }): Promise<ProjectEvent>;
}

/** The durable project log doubles as its delivery outbox; acknowledgement never deletes history. */
export class CloudProjectEventWriter {
  readonly facts: FactEventStore;
  private pending: Promise<void> | null = null;
  private retry: Timer | null = null;
  private retryDelay = 1000;

  constructor(
    private readonly authority: ProjectEventAuthority,
    private readonly database: GitSpaceDatabase,
    private readonly onError: (error: unknown) => void,
  ) {
    this.facts = new FactEventStore(database);
    this.committed();
  }

  append(input: AppendFactEvent): void {
    this.facts.append(input);
    this.committed();
  }

  committed(): void {
    this.facts.committed();
    if (this.pending) return;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const pending = Promise.resolve().then(() => this.deliver());
    this.pending = pending;
    void pending.then(() => { this.retryDelay = 1000; }, (error: unknown) => {
      this.onError(error);
      // This retries unacknowledged writes, not a polling read disguised as a stream.
      this.retry = setTimeout(() => { this.retry = null; this.committed(); }, this.retryDelay);
      this.retry.unref?.();
      this.retryDelay = Math.min(30_000, this.retryDelay * 2);
    }).finally(() => { if (this.pending === pending) this.pending = null; });
  }

  private async deliver(): Promise<void> {
    for (;;) {
      const batch = this.database.orm.select().from(factEvents).where(eq(factEvents.cloudSynced, false)).orderBy(asc(factEvents.offset)).limit(128).all();
      if (batch.length === 0) return;
      for (const event of batch) {
        await this.authority.appendProjectEvent({ eventId: event.eventId, projectId: event.projectId, scope: event.scope, entity: event.entity, entityId: event.entityId, revision: event.revision, operation: event.operation, payload: event.payload });
        this.database.orm.update(factEvents).set({ cloudSynced: true }).where(eq(factEvents.eventId, event.eventId)).run();
      }
    }
  }

  async flush(): Promise<void> {
    this.committed();
    await this.pending;
  }
}
