import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { GitSpaceDatabase } from './database.js';
import { factEvents, type FactEvent } from './schema.js';

export const FACT_EVENT_PAGE_SIZE = 128;

export interface AppendFactEvent {
  projectId: string;
  scope: FactEvent['scope'];
  entity: string;
  entityId: string;
  revision: number;
  operation: FactEvent['operation'];
  payload?: Record<string, unknown>;
}

export class FactEventStore {
  private readonly waiters = new Set<() => void>();

  constructor(private readonly database: GitSpaceDatabase) {}

  append(input: AppendFactEvent): FactEvent {
    const event = this.database.orm.insert(factEvents).values({
      ...input,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    }).returning().get();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    return event;
  }

  latestOffset(projectId: string): number {
    return this.database.orm.select({ value: sql<number>`COALESCE(MAX(${factEvents.offset}), 0)` })
      .from(factEvents).where(eq(factEvents.projectId, projectId)).get()?.value ?? 0;
  }

  listAfter(projectId: string, afterOffset: number, limit = FACT_EVENT_PAGE_SIZE): FactEvent[] {
    const boundedLimit = Math.max(1, Math.min(FACT_EVENT_PAGE_SIZE, Math.trunc(limit)));
    return this.database.orm.select().from(factEvents).where(and(
      eq(factEvents.projectId, projectId),
      gt(factEvents.offset, Math.max(0, Math.trunc(afterOffset))),
    )).orderBy(asc(factEvents.offset)).limit(boundedLimit).all();
  }

  async *stream(projectId: string, afterOffset: number, signal?: AbortSignal): AsyncGenerator<FactEvent> {
    let cursor = Math.max(0, Math.trunc(afterOffset));
    while (!signal?.aborted) {
      const page = this.listAfter(projectId, cursor);
      if (page.length > 0) {
        for (const event of page) {
          if (signal?.aborted) return;
          cursor = event.offset;
          yield event;
        }
        continue;
      }
      await this.wait(signal);
    }
  }

  private wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = (): void => {
        signal?.removeEventListener('abort', wake);
        this.waiters.delete(wake);
        resolve();
      };
      this.waiters.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }
}
