import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentSession } from '@gitspace/core';
import type { CanonicalSession } from '@gitspace/protocol';
import { atomicJson } from './machine-update.js';

export interface CanonicalSessionAuthority {
  getCanonicalSession(projectId: string, sessionId: string): Promise<CanonicalSession | null>;
  putCanonicalSession(
    projectId: string,
    session: Omit<CanonicalSession, 'revision' | 'createdAt' | 'updatedAt'> & { expectedRevision: number },
  ): Promise<CanonicalSession>;
}

export interface CanonicalSessionBlobStore {
  /** Receives plaintext; stores the encrypted, bounded checkpoint envelope. */
  put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`>;
}

export interface CanonicalPublicationScope {
  projectId: string;
  spaceId: string;
}

interface PublicationFailure {
  error: unknown;
}

interface FlushBarrier {
  remaining: number;
  failures: Map<string, PublicationFailure>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface SessionPublication {
  projectId: string;
  machineId: string;
  session: AgentSession;
  checkpoint: boolean;
  barriers: FlushBarrier[];
}

interface SessionPublications {
  key: string;
  active: SessionPublication | null;
  pending: SessionPublication[];
}

const MAX_CONCURRENT_PUBLICATIONS = 4;
const OUTBOX_RETRY_MIN_MS = 30_000;
const OUTBOX_RETRY_MAX_MS = 10 * 60_000;

const outboxSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    checkpoint: z.boolean(),
    token: z.string().min(1),
  })),
});
type OutboxEntry = z.infer<typeof outboxSchema>['entries'][number];
export type CanonicalPublicationIntent = Omit<OutboxEntry, 'token'>;

/**
 * Canonical publications owed to the cloud, kept on the machine's shared disk across generations.
 * Entries carry no session state: replay republishes whatever the local session holds at that time.
 */
export class CanonicalSessionOutbox {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async entries(): Promise<OutboxEntry[]> {
    try {
      return outboxSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))).entries;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      return [];
    }
  }

  /** Merges to one entry per session, keeping any checkpoint obligation; the fresh token outlives replays of older entries. */
  record(intents: readonly CanonicalPublicationIntent[]): Promise<void> {
    if (intents.length === 0) return Promise.resolve();
    return this.update((entries) => {
      const merged = new Map(entries.map((entry) => [JSON.stringify([entry.projectId, entry.sessionId]), entry]));
      for (const { projectId, sessionId, checkpoint } of intents) {
        const key = JSON.stringify([projectId, sessionId]);
        merged.set(key, { projectId, sessionId, checkpoint: checkpoint || merged.get(key)?.checkpoint === true, token: crypto.randomUUID() });
      }
      return [...merged.values()];
    });
  }

  /** Removes exactly this entry; a newer record for the same session has another token and survives. */
  remove(entry: OutboxEntry): Promise<void> {
    return this.update((entries) => {
      const kept = entries.filter((candidate) => candidate.token !== entry.token);
      return kept.length === entries.length ? null : kept;
    });
  }

  private update(change: (entries: OutboxEntry[]) => OutboxEntry[] | null): Promise<void> {
    const next = this.mutation.then(async () => {
      const changed = change(await this.entries());
      if (changed) await atomicJson(this.path, { version: 1, entries: changed });
    });
    this.mutation = next.catch(() => undefined);
    return next;
  }
}

export class CloudCanonicalSessionWriter {
  private readonly sessions = new Map<string, SessionPublications>();
  private readonly ready = new Set<SessionPublications>();
  private readonly replays = new Map<string, Promise<void>>();
  private running = 0;
  private readonly failures = new Map<string, PublicationFailure>();
  private backgroundReplay: Promise<void> | null = null;
  private replayRetryAt = 0;
  private replayRetryDelay = OUTBOX_RETRY_MIN_MS;

  constructor(
    private readonly authority: CanonicalSessionAuthority,
    private readonly blobs: CanonicalSessionBlobStore,
    private readonly onError: (error: unknown) => void,
    private readonly outbox: CanonicalSessionOutbox,
  ) {}

  get(projectId: string, sessionId: string): Promise<CanonicalSession | null> {
    return this.authority.getCanonicalSession(projectId, sessionId);
  }

  put(projectId: string, machineId: string, session: AgentSession, checkpoint = false): void {
    const key = JSON.stringify([projectId, session.id]);
    let publications = this.sessions.get(key);
    if (!publications) {
      publications = { key, active: null, pending: [] };
      this.sessions.set(key, publications);
    }
    const latest = publications.pending.at(-1);
    // Only replace unobserved status. Checkpoints and explicit flushes seal their position.
    if (latest && !latest.checkpoint && latest.barriers.length === 0) {
      latest.machineId = machineId;
      latest.session = session;
      latest.checkpoint = checkpoint;
    } else {
      publications.pending.push({ projectId, machineId, session, checkpoint, barriers: [] });
    }
    if (!publications.active) this.ready.add(publications);
    this.drain();
  }

  /** Enqueues like put() and settles with that publication; the replay that observes a failure keeps it in the outbox. */
  private putObserved(projectId: string, machineId: string, session: AgentSession, checkpoint: boolean): Promise<void> {
    this.put(projectId, machineId, session, checkpoint);
    const publications = this.sessions.get(JSON.stringify([projectId, session.id]))!;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const preceding = publications.active ? [publications.active, ...publications.pending] : publications.pending;
    const barrier: FlushBarrier = { remaining: preceding.length, failures: new Map(), resolve, reject };
    for (const publication of preceding) publication.barriers.push(barrier);
    return promise;
  }

  private drain(): void {
    while (this.running < MAX_CONCURRENT_PUBLICATIONS && this.ready.size > 0) {
      const publications = this.ready.values().next().value!;
      this.ready.delete(publications);
      const publication = publications.pending.shift()!;
      publications.active = publication;
      this.running++;
      void this.publish(publication).catch((error: unknown) => {
        const failure = { error };
        const key = JSON.stringify([publication.projectId, publication.session.spaceId]);
        this.failures.set(key, failure);
        for (const barrier of publication.barriers) barrier.failures.set(key, failure);
        this.onError(error);
      }).finally(() => {
        publications.active = null;
        this.running--;
        for (const barrier of publication.barriers) {
          if (--barrier.remaining > 0) continue;
          for (const [key, failure] of barrier.failures) {
            if (this.failures.get(key) === failure) this.failures.delete(key);
          }
          const failure = barrier.failures.values().next().value;
          if (failure) {
            barrier.reject(failure.error);
          } else {
            barrier.resolve();
          }
        }
        if (publications.pending.length > 0) this.ready.add(publications);
        else this.sessions.delete(publications.key);
        this.drain();
      });
    }
  }

  private async publish({ projectId, machineId, session, checkpoint }: SessionPublication): Promise<void> {
    const current = await this.authority.getCanonicalSession(projectId, session.id);
    let sessionObjectKey = current?.sessionObjectKey ?? null;
    let sessionObjectHash = current?.sessionObjectHash ?? null;
    let sessionFormatVersion = current?.sessionFormatVersion ?? null;
    if (checkpoint) {
      try {
        const bytes = await readFile(session.sessionFile);
        const contentHash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
        // Encryption uses fresh nonces; never overwrite an immutable checkpoint.
        const key = `projects/${projectId}/sessions/${session.id}/${contentHash}-${crypto.randomUUID()}.checkpoint`;
        sessionObjectHash = await this.blobs.put(key, bytes);
        sessionObjectKey = key;
        sessionFormatVersion = 'omp-checkpoint-1';
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
    await this.authority.putCanonicalSession(projectId, {
      id: session.id,
      workspaceId: session.spaceId,
      ompSessionId: session.ompSessionId,
      machineId,
      state: session.state,
      sessionObjectKey,
      sessionObjectHash,
      sessionFormatVersion,
      activity: session.activity,
      health: session.health,
      expectedRevision: current?.revision ?? 0,
    });
  }

  /** Waits for already queued work in this workspace, or all machine work when omitted. */
  flush(scope?: CanonicalPublicationScope): Promise<void> {
    const scopeKey = scope ? JSON.stringify([scope.projectId, scope.spaceId]) : null;
    const failures = new Map([...this.failures].filter(([key]) => scopeKey === null || key === scopeKey));
    const selected: SessionPublication[] = [];
    for (const publications of this.sessions.values()) {
      for (const publication of publications.active ? [publications.active, ...publications.pending] : publications.pending) {
        if (!scope || (publication.projectId === scope.projectId && publication.session.spaceId === scope.spaceId)) {
          selected.push(publication);
        }
      }
    }
    if (selected.length === 0) {
      for (const [key, failure] of failures) {
        if (this.failures.get(key) === failure) this.failures.delete(key);
      }
      const failure = failures.values().next().value;
      return failure ? Promise.reject(failure.error) : Promise.resolve();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const barrier: FlushBarrier = { remaining: selected.length, failures, resolve, reject };
    for (const publication of selected) publication.barriers.push(barrier);
    return promise;
  }

  /**
   * A same-machine replacement leaves every queued publication in the durable outbox for its successor,
   * because local session state is already durable; every other stop still waits for the cloud.
   */
  settle(mode: 'release' | 'replace'): Promise<void> {
    if (mode === 'release') return this.flush();
    return this.outbox.record([...this.sessions.values()].flatMap(({ active, pending }) => (active ? [active, ...pending] : pending)
      .map(({ projectId, session, checkpoint }) => ({ projectId, sessionId: session.id, checkpoint }))));
  }

  /**
   * Republishes outbox entries (only these sessions when given) from current local session state. An entry is
   * removed only after its publication succeeds; one whose session is gone locally has nothing left to publish.
   */
  async replay(machineId: string, sessions: (sessionId: string) => AgentSession | null, sessionIds?: readonly string[]): Promise<void> {
    const entries = (await this.outbox.entries()).filter((entry) => !sessionIds || sessionIds.includes(entry.sessionId));
    const results = await Promise.allSettled(entries.map((entry) => {
      let replay = this.replays.get(entry.token);
      if (!replay) {
        const session = sessions(entry.sessionId);
        replay = (session ? this.putObserved(entry.projectId, machineId, session, entry.checkpoint) : Promise.resolve())
          .then(() => this.outbox.remove(entry))
          .finally(() => this.replays.delete(entry.token));
        this.replays.set(entry.token, replay);
      }
      return replay;
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  /** Replays in the background unless a replay is running or a failed one is backing off from repeating large uploads. */
  replayInBackground(machineId: string, sessions: (sessionId: string) => AgentSession | null): void {
    if (this.backgroundReplay || Date.now() < this.replayRetryAt) return;
    this.backgroundReplay = this.replay(machineId, sessions).then(() => {
      this.replayRetryDelay = OUTBOX_RETRY_MIN_MS;
    }, (error: unknown) => {
      this.replayRetryAt = Date.now() + this.replayRetryDelay;
      this.replayRetryDelay = Math.min(this.replayRetryDelay * 2, OUTBOX_RETRY_MAX_MS);
      this.onError(error);
    }).finally(() => {
      this.backgroundReplay = null;
    });
  }
}
