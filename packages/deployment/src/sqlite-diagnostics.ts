import { Database } from 'bun:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

interface DeploymentSqliteContext {
  deploymentId?: string;
  releaseSha?: string;
  target?: string;
  attempt?: number;
  phase?: string;
}

const contextStorage = new AsyncLocalStorage<DeploymentSqliteContext>();
const recentEvents: Record<string, unknown>[] = [];
const activeTransactions = new Map<string, Record<string, unknown>>();
let nextConnectionId = 0;
let nextTransactionId = 0;

export function withDeploymentSqliteContext<T>(context: DeploymentSqliteContext, action: () => T): T {
  return contextStorage.run({ ...contextStorage.getStore(), ...context }, action);
}

function bestEffort(action: () => void): void {
  try {
    action();
  } catch {
    /* Diagnostics must not affect deployment behavior. */
  }
}

function field(value: unknown, name: string): unknown {
  try {
    return value !== null && (typeof value === 'object' || typeof value === 'function')
      ? Reflect.get(value, name)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Bounded scalar error evidence only; never serialize arbitrary error properties. */
export function deploymentSqliteErrorDetails(error: unknown): Record<string, unknown> {
  const seen = new Set<unknown>();
  function details(value: unknown, depth: number): Record<string, unknown> {
    if (seen.has(value)) return { message: '[circular cause]' };
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of ['name', 'message', 'stack', 'code', 'errno', 'extendedCode']) {
      const item = field(value, key);
      if (typeof item === 'string') result[key] = item.slice(0, key === 'stack' ? 8192 : 2048);
      else if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    }
    if (typeof value === 'string') result.message = value.slice(0, 2048);
    const cause = field(value, 'cause');
    if (cause !== undefined) result.cause = depth < 3 ? details(cause, depth + 1) : { message: '[cause depth limit]' };
    return result;
  }
  return details(error, 0);
}

function remember(event: Record<string, unknown>): void {
  recentEvents.push(event);
  if (recentEvents.length > 64) recentEvents.shift();
}

function isLockError(error: unknown): boolean {
  for (const key of ['code', 'errno', 'extendedCode']) {
    const value = field(error, key);
    if (typeof value === 'number' && ((value & 255) === 5 || (value & 255) === 6)) return true;
    if (typeof value === 'string' && /^SQLITE_(BUSY|LOCKED)(?:_|$)/.test(value)) return true;
  }
  const message = field(error, 'message');
  return typeof message === 'string' && /database (?:is |table is )?locked|database is busy/i.test(message);
}

/** Explicit SQL boundaries, with process-local evidence (not external lock-owner identification). */
export class DeploymentSqliteConnection {
  readonly database: Database;
  private readonly connectionId = `${process.pid}:${++nextConnectionId}`;
  private readonly databases = new Map<string, Record<string, unknown>>();
  private readonly configuration: Record<string, unknown> = {};

  constructor(path: string, options?: ConstructorParameters<typeof Database>[1]) {
    this.registerDatabase('main', path);
    this.database = this.run('connection.open', () => new Database(path, options));
    this.captureConfiguration();
  }

  registerDatabase(name: string, path: string): void {
    bestEffort(() => {
      const filePath = path === ':memory:' || path === '' ? path : resolve(path);
      const metadata: Record<string, unknown> = { name, path: filePath };
      bestEffort(() => {
        const stat = statSync(filePath, { bigint: true });
        metadata.device = stat.dev.toString();
        metadata.inode = stat.ino.toString();
      });
      this.databases.set(name, metadata);
    });
  }

  captureConfiguration(): void {
    for (const [name, metadata] of this.databases) {
      this.registerDatabase(name, metadata.path as string);
      bestEffort(() => {
        const alias = `"${name.replaceAll('"', '""')}"`;
        this.configuration[name] = {
          journalMode: this.database.query(`PRAGMA ${alias}.journal_mode`).get(),
          busyTimeout: this.database.query('PRAGMA busy_timeout').get(),
        };
      });
    }
  }

  private event(operation: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      connectionId: this.connectionId,
      operation,
      kind,
      ...contextStorage.getStore(),
      ...extra,
    };
  }

  run<T>(operation: string, action: () => T): T {
    const started = performance.now();
    bestEffort(() => remember(this.event(operation, 'operation.begin')));
    try {
      const result = action();
      bestEffort(() => remember(this.event(operation, 'operation.end', { elapsedMs: performance.now() - started })));
      return result;
    } catch (error) {
      bestEffort(() => {
        const evidence = this.event(operation, 'operation.error', { elapsedMs: performance.now() - started });
        remember(evidence);
        // No SQL is issued here: configuration is cached at open/explicit refresh only.
        const payload = {
          event: 'deployment_sqlite_failure',
          ...evidence,
          databases: [...this.databases.values()],
          configuration: this.configuration,
          inTransaction: this.database?.inTransaction ?? null,
          error: deploymentSqliteErrorDetails(error),
          ...(isLockError(error)
            ? {
                evidenceScope:
                  'instrumented connections in this process only; not identification of an external lock owner',
                recentEvents: [...recentEvents],
                activeTransactions: [...activeTransactions.values()].slice(-64),
              }
            : {}),
        };
        process.stderr.write(`${JSON.stringify(payload)}\n`);
      });
      throw error;
    }
  }

  transaction<T>(operation: string, action: () => T): T {
    const transactionId = `${this.connectionId}:${++nextTransactionId}`;
    const started = performance.now();
    let bodyStarted = false;
    return this.run(operation, () => {
      try {
        const result = this.database.transaction(() => {
          bodyStarted = true;
          bestEffort(() => {
            const event = this.event(operation, 'transaction.begin', {
              transactionId,
              databases: [...this.databases.values()],
            });
            activeTransactions.set(transactionId, event);
            remember(event);
          });
          return action();
        })();
        bestEffort(() =>
          remember(
            this.event(operation, 'transaction.commit', {
              transactionId,
              elapsedMs: performance.now() - started,
            }),
          ),
        );
        return result;
      } catch (error) {
        if (bodyStarted)
          bestEffort(() =>
            remember(
              this.event(operation, 'transaction.rollback', {
                transactionId,
                elapsedMs: performance.now() - started,
                inTransaction: this.database.inTransaction,
              }),
            ),
          );
        throw error;
      } finally {
        activeTransactions.delete(transactionId);
      }
    });
  }

  close(): void {
    this.run('connection.close', () => this.database.close());
  }
}
