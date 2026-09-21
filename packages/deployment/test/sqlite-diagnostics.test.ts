import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDeploymentPlan,
  DeploymentJournal,
  DeploymentSqliteConnection,
  withDeploymentSqliteContext,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function plan() {
  const result = await createDeploymentPlan({
    source: { projectId: 'gitspace', revision: 'lock-proof-release', dirty: false },
    target: { environmentId: 'lock-proof', kind: 'sandbox', expectedGeneration: 'previous' },
    candidateArtifacts: [
      { entrypoint: 'frontend', hash: `sha256:${'b'.repeat(64)}`, path: '/candidate/web', dependsOn: [] },
    ],
    currentHashes: {},
    authority: { kind: 'sandbox', environmentId: 'lock-proof' },
  });
  if (result.status === 'error') throw result.error;
  return result.value;
}

describe('deployment SQLite contention evidence', () => {
  it('identifies a blocked journal write and overlapping transaction, then succeeds after release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-sqlite-evidence-'));
    roots.push(root);
    const path = join(root, 'deployment.db');
    const journal = new DeploymentJournal(path);
    const holder = new DeploymentSqliteConnection(path);
    const selected = await plan();
    journal.begin(selected);
    const messages: string[] = [];
    const logging = spyOn(process.stderr, 'write').mockImplementation((message) => {
      messages.push(String(message));
      return true;
    });
    let thrown: unknown;
    try {
      holder.transaction('proof.holder', () => {
        holder.run('proof.holder.write', () =>
          holder.database
            .query('UPDATE deployment_runs SET error = ? WHERE id = ?')
            .run('private-bound-value', selected.id),
        );
        // Evict the holder's begin/write events without losing its active transaction.
        const read = holder.database.query('SELECT 1');
        for (let index = 0; index < 80; index += 1) holder.run('proof.read', () => read.get());
        try {
          withDeploymentSqliteContext(
            {
              deploymentId: selected.id,
              releaseSha: 'lock-proof-release',
              target: 'frontend',
              attempt: 1,
              phase: 'stage',
            },
            () => journal.transition(selected.id, 'staging'),
          );
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: 'SQLITE_BUSY', errno: 5 });
      });
      const events = messages.map((message) => JSON.parse(message));
      const failure = events.find(
        (event) => event.event === 'deployment_sqlite_failure' && event.operation === 'journal.run.transition',
      );
      expect(failure).toMatchObject({
        deploymentId: selected.id,
        releaseSha: 'lock-proof-release',
        target: 'frontend',
        attempt: 1,
        phase: 'staging',
        error: { code: 'SQLITE_BUSY', errno: 5 },
        pid: process.pid,
      });
      expect(failure.error.stack).toContain('sqlite-diagnostics.test.ts');
      expect(failure.databases).toContainEqual(
        expect.objectContaining({ path, device: String(statSync(path).dev), inode: String(statSync(path).ino) }),
      );
      const overlapping = failure.activeTransactions.find(
        (event: { operation: string }) => event.operation === 'proof.holder',
      );
      expect(overlapping).toMatchObject({ kind: 'transaction.begin', pid: process.pid });
      expect(overlapping.connectionId).not.toBe(failure.connectionId);
      expect(failure.recentEvents.length).toBeLessThanOrEqual(64);
      expect(failure.recentEvents).not.toContainEqual(expect.objectContaining({ operation: 'proof.holder.write' }));
      expect(JSON.stringify(failure)).not.toContain('private-bound-value');
      expect(journal.load(selected.id)?.state).toBe('planned');
      expect(journal.transition(selected.id, 'staging').state).toBe('staging');
    } finally {
      logging.mockRestore();
      holder.close();
      journal.close();
    }
  });

  it('does not replace the original SQLite exception when the diagnostic sink fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-sqlite-sink-'));
    roots.push(root);
    const path = join(root, 'database.db');
    const holder = new DeploymentSqliteConnection(path);
    holder.database.exec(
      "CREATE TABLE rows (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO rows VALUES (1, 'original')",
    );
    const waiter = new DeploymentSqliteConnection(path);
    const logging = spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('sink unavailable');
    });
    let original: unknown;
    try {
      holder.transaction('proof.holder', () => {
        holder.database.exec("UPDATE rows SET value = 'held' WHERE id = 1");
        try {
          waiter.run('proof.waiter', () => {
            try {
              waiter.database.exec("UPDATE rows SET value = 'blocked' WHERE id = 1");
            } catch (error) {
              original = error;
              throw error;
            }
          });
          throw new Error('Expected contention');
        } catch (error) {
          expect(error).toBe(original);
          expect(error).toMatchObject({ code: 'SQLITE_BUSY' });
        }
      });
    } finally {
      logging.mockRestore();
      waiter.close();
      holder.close();
    }
  });
});
