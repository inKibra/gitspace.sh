import type { Database } from 'bun:sqlite';

interface ControlMigration {
  version: number;
  statements: string[];
}

const CONTROL_MIGRATIONS: ControlMigration[] = [
  {
    version: 1,
    statements: [
      `
      CREATE TABLE IF NOT EXISTS control_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS cloud_workspaces (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_workspace_id TEXT NOT NULL,
        machine_id TEXT,
        machine_public_key TEXT,
        repo TEXT,
        branch TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS cloud_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT,
        event_type TEXT NOT NULL,
        message TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES cloud_workspaces(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS idx_cloud_workspaces_status
      ON cloud_workspaces(status)
      `,
      `
      CREATE INDEX IF NOT EXISTS idx_cloud_events_workspace_id
      ON cloud_events(workspace_id)
      `,
    ],
  },
  {
    version: 2,
    statements: [
      `
      CREATE TABLE IF NOT EXISTS cloud_bootstrap_tokens (
        token_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        owner_identity_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        machine_id TEXT,
        machine_public_key TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES cloud_workspaces(id) ON DELETE CASCADE
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS idx_cloud_bootstrap_tokens_workspace
      ON cloud_bootstrap_tokens(workspace_id)
      `,
      `
      CREATE INDEX IF NOT EXISTS idx_cloud_bootstrap_tokens_state
      ON cloud_bootstrap_tokens(state)
      `,
    ],
  },
  {
    version: 3,
    statements: [
      `
      CREATE TABLE IF NOT EXISTS cloud_register_permits (
        permit_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        permit_hash TEXT NOT NULL UNIQUE,
        machine_public_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        machine_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES cloud_workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (token_id) REFERENCES cloud_bootstrap_tokens(token_id) ON DELETE CASCADE
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS idx_cloud_register_permits_workspace
      ON cloud_register_permits(workspace_id)
      `,
      `
      CREATE INDEX IF NOT EXISTS idx_cloud_register_permits_expires
      ON cloud_register_permits(expires_at)
      `,
    ],
  },
  {
    version: 4,
    statements: [
      // ---- Vault metadata (vault salt, key check) ----
      `
      CREATE TABLE IF NOT EXISTS vault_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
      `,

      // ---- Persistent machine registry ----
      `
      CREATE TABLE IF NOT EXISTS vault_machines (
        machine_id TEXT PRIMARY KEY,
        owner_user_root_id TEXT NOT NULL,
        signing_key TEXT NOT NULL,
        key_exchange_key TEXT NOT NULL,
        label TEXT,
        registered_at TEXT NOT NULL,
        last_connected_at TEXT NOT NULL
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS idx_vault_machines_owner
      ON vault_machines(owner_user_root_id)
      `,
      `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_machines_signing_key
      ON vault_machines(signing_key)
      `,

      // ---- Encrypted machine unlock keys (sealed with vault key) ----
      `
      CREATE TABLE IF NOT EXISTS vault_machine_unlock_keys (
        machine_id TEXT PRIMARY KEY,
        encrypted_unlock_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (machine_id) REFERENCES vault_machines(machine_id) ON DELETE CASCADE
      )
      `,

      // ---- Access control list keyed by user root ID ----
      `
      CREATE TABLE IF NOT EXISTS vault_access_list (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_root_id TEXT NOT NULL,
        client_user_root_id TEXT NOT NULL,
        label TEXT,
        granted_at TEXT NOT NULL,
        UNIQUE(owner_user_root_id, client_user_root_id)
      )
      `,
      `
      CREATE INDEX IF NOT EXISTS idx_vault_access_list_owner
      ON vault_access_list(owner_user_root_id)
      `,
    ],
  },
];

function ensureMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

export function applyControlMigrations(db: Database): void {
  ensureMigrationsTable(db);

  const appliedRows = db
    .query('SELECT version FROM _migrations ORDER BY version')
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const migration of CONTROL_MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    const appliedAt = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const statement of migration.statements) {
        db.exec(statement);
      }

      db.query('INSERT INTO _migrations(version, applied_at) VALUES (?, ?)').run(
        migration.version,
        appliedAt
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
