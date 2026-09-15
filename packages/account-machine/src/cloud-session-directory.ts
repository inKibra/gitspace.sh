import { readFile } from 'node:fs/promises';
import type { AgentSession } from '@gitspace/core';
import type { CanonicalSession } from '@gitspace/protocol';

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

interface PublicationFailure {
  error: unknown;
}

interface FlushBarrier {
  remaining: number;
  failure: PublicationFailure | null;
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
  barriers: Set<FlushBarrier>;
}

const MAX_CONCURRENT_PUBLICATIONS = 4;

export class CloudCanonicalSessionWriter {
  private readonly sessions = new Map<string, SessionPublications>();
  private readonly ready = new Set<SessionPublications>();
  private running = 0;
  private failure: PublicationFailure | null = null;

  constructor(
    private readonly authority: CanonicalSessionAuthority,
    private readonly blobs: CanonicalSessionBlobStore,
    private readonly onError: (error: unknown) => void,
  ) {}

  get(projectId: string, sessionId: string): Promise<CanonicalSession | null> {
    return this.authority.getCanonicalSession(projectId, sessionId);
  }

  put(projectId: string, machineId: string, session: AgentSession, checkpoint = false): void {
    const key = JSON.stringify([projectId, session.id]);
    let publications = this.sessions.get(key);
    if (!publications) {
      publications = { key, active: null, pending: [], barriers: new Set() };
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

  private drain(): void {
    while (this.running < MAX_CONCURRENT_PUBLICATIONS && this.ready.size > 0) {
      const publications = this.ready.values().next().value!;
      this.ready.delete(publications);
      const publication = publications.pending.shift()!;
      publications.active = publication;
      this.running++;
      void this.publish(publication).catch((error: unknown) => {
        const failure = { error };
        this.failure = failure;
        for (const barrier of publications.barriers) barrier.failure = failure;
        this.onError(error);
      }).finally(() => {
        publications.active = null;
        this.running--;
        for (const barrier of publication.barriers) {
          publications.barriers.delete(barrier);
          if (--barrier.remaining > 0) continue;
          if (barrier.failure) {
            if (this.failure === barrier.failure) this.failure = null;
            barrier.reject(barrier.failure.error);
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

  flush(): Promise<void> {
    const failure = this.failure;
    if (this.sessions.size === 0) {
      this.failure = null;
      return failure ? Promise.reject(failure.error) : Promise.resolve();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const barrier: FlushBarrier = { remaining: this.sessions.size, failure, resolve, reject };
    for (const publications of this.sessions.values()) {
      const last = publications.pending.at(-1) ?? publications.active!;
      last.barriers.push(barrier);
      publications.barriers.add(barrier);
    }
    return promise;
  }
}
