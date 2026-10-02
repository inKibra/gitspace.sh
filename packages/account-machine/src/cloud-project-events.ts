import { FactEventStore, factEvents, type AppendFactEvent, type GitSpaceDatabase } from '@gitspace/core';
import type { ProjectEvent } from '@gitspace/protocol';
import { and, asc, eq } from 'drizzle-orm';

export interface ProjectEventAuthority {
  appendProjectEvent(input: Omit<ProjectEvent, 'offset' | 'createdAt'> & { projectId: string }): Promise<ProjectEvent>;
}

interface ProjectDelivery {
  pending: Promise<void> | null;
  retry: Timer | null;
  retryDelay: number;
  failure?: unknown;
}

/** The durable project log doubles as its delivery outbox; acknowledgement never deletes history. */
export class CloudProjectEventWriter {
  readonly facts: FactEventStore;
  private readonly projects = new Map<string, ProjectDelivery>();

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
    this.pump();
  }

  private hasUnsent(projectId: string): boolean {
    return this.database.orm.select({ offset: factEvents.offset }).from(factEvents)
      .where(and(eq(factEvents.cloudSynced, false), eq(factEvents.projectId, projectId))).limit(1).all().length !== 0;
  }

  private pump(): void {
    let active = [...this.projects.values()].filter((state) => state.pending).length;
    if (active >= 4) return;
    const projects = this.database.orm.select({ projectId: factEvents.projectId }).from(factEvents)
      .where(eq(factEvents.cloudSynced, false)).groupBy(factEvents.projectId).all();
    for (const { projectId } of projects) {
      const state = this.projects.get(projectId);
      if (state?.pending || state?.retry) continue;
      this.start(projectId);
      if (++active >= 4) break;
    }
  }

  private start(projectId: string): ProjectDelivery {
    let state = this.projects.get(projectId);
    if (!state) {
      state = { pending: null, retry: null, retryDelay: 1000 };
      this.projects.set(projectId, state);
    }
    if (state.pending || state.retry) return state;
    const delivery = state;
    const pending = Promise.resolve().then(() => this.deliver(projectId, delivery));
    delivery.pending = pending;
    void pending.then(() => {
      delivery.pending = null;
      if (!this.hasUnsent(projectId)) this.projects.delete(projectId);
      this.pump();
    }, (error: unknown) => {
      delivery.pending = null;
      delivery.failure = error;
      // Facts and explicit flushes respect their own project's overload backoff.
      delivery.retry = setTimeout(() => {
        delivery.retry = null;
        this.pump();
      }, delivery.retryDelay);
      delivery.retry.unref?.();
      delivery.retryDelay = Math.min(30_000, delivery.retryDelay * 2);
      this.pump();
      this.onError(error);
    });
    return delivery;
  }

  private async deliver(projectId: string, state: ProjectDelivery): Promise<void> {
    const batch = this.database.orm.select().from(factEvents)
      .where(and(eq(factEvents.cloudSynced, false), eq(factEvents.projectId, projectId)))
      .orderBy(asc(factEvents.offset)).limit(128).all();
    for (const event of batch) {
      await this.authority.appendProjectEvent({ eventId: event.eventId, projectId: event.projectId, scope: event.scope, entity: event.entity, entityId: event.entityId, revision: event.revision, operation: event.operation, payload: event.payload });
      this.database.orm.update(factEvents).set({ cloudSynced: true }).where(eq(factEvents.eventId, event.eventId)).run();
      state.retryDelay = 1000;
      state.failure = undefined;
    }
  }

  async flush(projectId?: string): Promise<void> {
    if (projectId !== undefined) {
      while (this.hasUnsent(projectId)) {
        this.pump();
        const state = this.projects.get(projectId);
        if (state?.retry) throw state.failure;
        if (state?.pending) {
          await state.pending;
        } else {
          // Wait only for capacity, not for unrelated projects to drain or succeed.
          await Promise.race([...this.projects.values()].flatMap((delivery) =>
            delivery.pending ? [delivery.pending.then(() => {}, () => {})] : []));
        }
      }
      return;
    }
    for (;;) {
      this.pump();
      for (const state of this.projects.values()) {
        if (state.retry) throw state.failure;
      }
      const pending = [...this.projects.values()].flatMap((state) => state.pending ? [state.pending] : []);
      if (pending.length === 0) return;
      await Promise.race(pending);
    }
  }
}
