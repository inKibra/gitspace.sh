import { DurableObject } from 'cloudflare:workers';
import {
  mcpAuditEventSchema,
  mcpConnectionStatusSchema,
  mcpConnectionDraftSchema,
  type McpAuditEvent,
  type McpConnection,
  type McpConnectionDraft,
  type McpConnectionStatus,
} from '@gitspace/protocol';

interface ConnectionRow extends Record<string, SqlStorageValue> {
  connection_id: string;
  principal_id: string;
  label: string;
  enabled: number;
  target_json: string;
  transport_json: string;
  timeout_ms: number;
  status: McpConnectionStatus;
  status_message: string | null;
  status_checked_at: string | null;
  server_fingerprint: string | null;
  server_version: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface AuditRow extends Record<string, SqlStorageValue> {
  event_id: string;
  principal_id: string;
  project_id: string | null;
  connection_id: string;
  machine_id: string | null;
  event_type: McpAuditEvent['type'];
  tool_name: string | null;
  outcome: McpAuditEvent['outcome'];
  message: string | null;
  created_at: string;
}

export class McpConnectionNotFoundError extends Error {
  constructor(readonly connectionId: string) {
    super(`MCP connection ${connectionId} does not exist`);
    this.name = 'McpConnectionNotFoundError';
  }
}

export class McpConnectionRevisionConflictError extends Error {
  constructor(readonly connectionId: string, readonly expected: number, readonly actual: number) {
    super(`MCP connection ${connectionId} revision conflict: expected ${expected}, actual ${actual}`);
    this.name = 'McpConnectionRevisionConflictError';
  }
}

export class McpConnectionValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'McpConnectionValidationError';
  }
}

function connection(row: ConnectionRow): McpConnection {
  return {
    id: row.connection_id,
    principalId: row.principal_id,
    label: row.label,
    enabled: row.enabled === 1,
    target: JSON.parse(row.target_json) as McpConnection['target'],
    transport: JSON.parse(row.transport_json) as McpConnection['transport'],
    timeoutMs: row.timeout_ms,
    status: row.status,
    statusMessage: row.status_message,
    statusCheckedAt: row.status_checked_at,
    serverFingerprint: row.server_fingerprint,
    serverVersion: row.server_version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditEvent(row: AuditRow): McpAuditEvent {
  return {
    id: row.event_id,
    principalId: row.principal_id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    machineId: row.machine_id,
    type: row.event_type,
    toolName: row.tool_name,
    outcome: row.outcome,
    message: row.message,
    createdAt: row.created_at,
  };
}

function validateDraft(input: unknown): McpConnectionDraft {
  const parsed = mcpConnectionDraftSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new McpConnectionValidationError(issue?.path.join('.') || 'connection', issue?.message ?? 'MCP connection is invalid');
}

function safeAuditMessage(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/\b(?:authorization|proxy-authorization|x-api-key|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/([?&](?:access_token|api_key|token|secret)=)[^&#\s]*/giu, '$1[redacted]')
    .replace(/\b(?:authorization|proxy-authorization|x-api-key|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/giu, '[credential]=[redacted]')
}

export class UserMcpConnectionsDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS mcp_connections(
          connection_id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          label TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          target_json TEXT NOT NULL,
          transport_json TEXT NOT NULL,
          timeout_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          status_message TEXT,
          status_checked_at TEXT,
          server_fingerprint TEXT,
          server_version TEXT,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_audit_events(
          event_id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          project_id TEXT,
          connection_id TEXT NOT NULL,
          machine_id TEXT,
          event_type TEXT NOT NULL,
          tool_name TEXT,
          outcome TEXT,
          message TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mcp_audit_created ON mcp_audit_events(created_at, event_id)
      `);
    });
  }

  list(principalId: string): McpConnection[] {
    return this.ctx.storage.sql.exec<ConnectionRow>(
      'SELECT * FROM mcp_connections WHERE principal_id=? ORDER BY label,connection_id',
      principalId,
    ).toArray().map(connection);
  }

  get(principalId: string, connectionId: string): McpConnection | null {
    const row = this.ctx.storage.sql.exec<ConnectionRow>(
      'SELECT * FROM mcp_connections WHERE principal_id=? AND connection_id=?',
      principalId,
      connectionId,
    ).toArray()[0];
    return row ? connection(row) : null;
  }

  create(principalId: string, candidate: McpConnectionDraft): McpConnection {
    const draft = validateDraft(candidate);
    if (this.get(principalId, draft.id)) throw new McpConnectionRevisionConflictError(draft.id, 0, 1);
    const now = new Date().toISOString();
    const status: McpConnectionStatus = draft.enabled ? 'offline' : 'disabled';
    this.ctx.storage.sql.exec(
      'INSERT INTO mcp_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      draft.id,
      principalId,
      draft.label,
      draft.enabled ? 1 : 0,
      JSON.stringify(draft.target),
      JSON.stringify(draft.transport),
      draft.timeoutMs,
      status,
      draft.enabled ? 'Not yet connected' : null,
      draft.enabled ? now : null,
      null,
      null,
      1,
      now,
      now,
    );
    return this.get(principalId, draft.id)!;
  }

  update(principalId: string, connectionId: string, expectedRevision: number, candidate: McpConnectionDraft): McpConnection {
    const draft = validateDraft(candidate);
    if (draft.id !== connectionId) throw new McpConnectionValidationError('id', 'MCP connection id cannot be changed');
    const current = this.get(principalId, connectionId);
    if (!current) throw new McpConnectionNotFoundError(connectionId);
    if (current.revision !== expectedRevision) {
      throw new McpConnectionRevisionConflictError(connectionId, expectedRevision, current.revision);
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE mcp_connections SET label=?,enabled=?,target_json=?,transport_json=?,timeout_ms=?,
       status=?,status_message=?,status_checked_at=?,server_fingerprint=NULL,server_version=NULL,
       revision=revision+1,updated_at=? WHERE principal_id=? AND connection_id=? AND revision=?`,
      draft.label,
      draft.enabled ? 1 : 0,
      JSON.stringify(draft.target),
      JSON.stringify(draft.transport),
      draft.timeoutMs,
      draft.enabled ? 'offline' : 'disabled',
      draft.enabled ? 'Configuration changed; reconnect required' : null,
      draft.enabled ? now : null,
      now,
      principalId,
      connectionId,
      expectedRevision,
    );
    return this.get(principalId, connectionId)!;
  }

  delete(principalId: string, connectionId: string, expectedRevision: number): boolean {
    const current = this.get(principalId, connectionId);
    if (!current) throw new McpConnectionNotFoundError(connectionId);
    if (current.revision !== expectedRevision) {
      throw new McpConnectionRevisionConflictError(connectionId, expectedRevision, current.revision);
    }
    this.ctx.storage.sql.exec(
      'DELETE FROM mcp_connections WHERE principal_id=? AND connection_id=? AND revision=?',
      principalId,
      connectionId,
      expectedRevision,
    );
    return true;
  }

  recordStatus(input: {
    principalId: string;
    connectionId: string;
    observedRevision: number;
    status: McpConnectionStatus;
    message?: string | null;
    serverFingerprint?: string | null;
    serverVersion?: string | null;
  }): McpConnection {
    const current = this.get(input.principalId, input.connectionId);
    if (!current) throw new McpConnectionNotFoundError(input.connectionId);
    if (current.revision !== input.observedRevision) {
      throw new McpConnectionRevisionConflictError(input.connectionId, input.observedRevision, current.revision);
    }
    const now = new Date().toISOString();
    const status = mcpConnectionStatusSchema.parse(input.status);
    this.ctx.storage.sql.exec(
      `UPDATE mcp_connections SET status=?,status_message=?,status_checked_at=?,server_fingerprint=?,server_version=?,
       revision=revision+1,updated_at=? WHERE principal_id=? AND connection_id=? AND revision=?`,
      current.enabled ? status : 'disabled',
      safeAuditMessage(input.message),
      now,
      input.serverFingerprint?.slice(0, 512) ?? null,
      input.serverVersion?.slice(0, 256) ?? null,
      now,
      input.principalId,
      input.connectionId,
      input.observedRevision,
    );
    return this.get(input.principalId, input.connectionId)!;
  }

  appendAudit(candidate: Omit<McpAuditEvent, 'id' | 'createdAt'>): McpAuditEvent {
    const parsed = mcpAuditEventSchema.omit({ id: true, createdAt: true }).parse(candidate);
    const event: McpAuditEvent = {
      ...parsed,
      id: crypto.randomUUID(),
      message: safeAuditMessage(parsed.message),
      createdAt: new Date().toISOString(),
    };
    this.ctx.storage.sql.exec(
      'INSERT INTO mcp_audit_events VALUES(?,?,?,?,?,?,?,?,?,?)',
      event.id,
      event.principalId,
      event.projectId,
      event.connectionId,
      event.machineId,
      event.type,
      event.toolName,
      event.outcome,
      event.message,
      event.createdAt,
    );
    return event;
  }

  listAudit(principalId: string, after: string | null, limit = 200): McpAuditEvent[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.ctx.storage.sql.exec<AuditRow>(
      `SELECT * FROM mcp_audit_events WHERE principal_id=? AND (? IS NULL OR created_at>?)
       ORDER BY created_at,event_id LIMIT ?`,
      principalId,
      after,
      after,
      boundedLimit,
    ).toArray().map(auditEvent);
  }
}
