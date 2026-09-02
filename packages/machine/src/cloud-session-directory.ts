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
  put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`>;
}

export class CloudCanonicalSessionWriter {
  private pending = Promise.resolve();

  constructor(
    private readonly authority: CanonicalSessionAuthority,
    private readonly blobs: CanonicalSessionBlobStore,
    private readonly onError: (error: unknown) => void,
  ) {}

  put(projectId: string, machineId: string, session: AgentSession, checkpoint = false): void {
    this.pending = this.pending
      .then(async () => {
        const current = await this.authority.getCanonicalSession(projectId, session.id);
        let sessionObjectKey = current?.sessionObjectKey ?? null;
        let sessionObjectHash = current?.sessionObjectHash ?? null;
        if (checkpoint) {
          try {
            const bytes = new Uint8Array(await readFile(session.sessionFile));
            const contentHash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
            const key = `projects/${projectId}/sessions/${session.id}/${contentHash}.jsonl`;
            sessionObjectHash = await this.blobs.put(key, bytes);
            sessionObjectKey = key;
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
          sessionFormatVersion: sessionObjectKey ? 'omp-jsonl-1' : null,
          activity: session.activity,
          expectedRevision: current?.revision ?? 0,
        });
      })
      .catch(this.onError);
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
