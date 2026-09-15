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
  private failure: unknown;
  private committedWhilePending = false;

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
    if (this.retry) return;
    if (this.pending) {
      this.committedWhilePending = true;
      return;
    }
    this.committedWhilePending = false;
    const pending = Promise.resolve().then(() => this.deliver());
    this.pending = pending;
    void pending.then(() => {
      this.pending = null;
      // A commit can land after deliver's final empty read but before this continuation.
      if (this.committedWhilePending) this.committed();
    }, (error: unknown) => {
      this.pending = null;
      this.failure = error;
      // New facts and flushes must respect the overload backoff of the oldest unsent fact.
      this.retry = setTimeout(() => { this.retry = null; this.committed(); }, this.retryDelay);
      this.retry.unref?.();
      this.retryDelay = Math.min(30_000, this.retryDelay * 2);
      this.onError(error);
    });
  }

  private async deliver(): Promise<void> {
    for (;;) {
      const batch = this.database.orm.select().from(factEvents).where(eq(factEvents.cloudSynced, false)).orderBy(asc(factEvents.offset)).limit(128).all();
      if (batch.length === 0) return;
      for (const event of batch) {
        await this.authority.appendProjectEvent({ eventId: event.eventId, projectId: event.projectId, scope: event.scope, entity: event.entity, entityId: event.entityId, revision: event.revision, operation: event.operation, payload: event.payload });
        this.database.orm.update(factEvents).set({ cloudSynced: true }).where(eq(factEvents.eventId, event.eventId)).run();
        this.retryDelay = 1000;
        this.failure = undefined;
      }
    }
  }

  async flush(): Promise<void> {
    for (;;) {
      if (this.retry) throw this.failure;
      if (!this.pending) this.committed();
      await this.pending;
      if (!this.pending) return;
    }
  }
}
