/**
 * Machine-side agent database.
 *
 * Only archived sessions are persisted here. All other session state is
 * ephemeral and derived from the live runtime snapshot plus in-process updates.
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getGitspaceDir } from '../core/config.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getAgentDir(): string {
  return join(getGitspaceDir(), '.agent');
}

function getAgentDbPath(): string {
  return join(getAgentDir(), 'agent.db');
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS archived_sessions (
        workspace_id TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        title        TEXT NOT NULL,
        archived_at  TEXT NOT NULL,
        PRIMARY KEY (workspace_id, session_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_archived_sessions_workspace
       ON archived_sessions(workspace_id)`,
    ],
  },
];

function applyMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    (db.query('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      for (const stmt of migration.statements) {
        db.exec(stmt);
      }
      db.query('INSERT INTO _migrations(version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _db: Database | null = null;

function getDb(): Database {
  if (!_db) {
    const dir = getAgentDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const db = new Database(getAgentDbPath());
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrations(db);
    _db = db;
  }
  return _db;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ArchivedSession {
  workspaceId: string;
  sessionId: string;
  title: string;
  archivedAt: string;
}

export function getArchivedSessions(workspaceId: string): ArchivedSession[] {
  const rows = getDb()
    .query(
      'SELECT workspace_id, session_id, title, archived_at FROM archived_sessions WHERE workspace_id = ?',
    )
    .all(workspaceId) as { workspace_id: string; session_id: string; title: string; archived_at: string }[];
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    title: r.title,
    archivedAt: r.archived_at,
  }));
}

export function getAllArchivedSessions(): ArchivedSession[] {
  const rows = getDb()
    .query('SELECT workspace_id, session_id, title, archived_at FROM archived_sessions')
    .all() as { workspace_id: string; session_id: string; title: string; archived_at: string }[];
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    title: r.title,
    archivedAt: r.archived_at,
  }));
}

export function upsertArchivedSession(session: ArchivedSession): void {
  getDb()
    .query(
      `INSERT OR REPLACE INTO archived_sessions(workspace_id, session_id, title, archived_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(session.workspaceId, session.sessionId, session.title, session.archivedAt);
}

export function deleteArchivedSession(workspaceId: string, sessionId: string): void {
  getDb()
    .query('DELETE FROM archived_sessions WHERE workspace_id = ? AND session_id = ?')
    .run(workspaceId, sessionId);
}

export function isSessionArchived(workspaceId: string, sessionId: string): boolean {
  return getDb()
    .query('SELECT 1 FROM archived_sessions WHERE workspace_id = ? AND session_id = ?')
    .get(workspaceId, sessionId) !== null;
}
