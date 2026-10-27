import { RuntimeBrowserAuthorityCertificateBodySchema, signRuntimeBrowserAuthorityCertificate, type RuntimeBrowserAuthorityCertificateBody } from '@gitspace/protocol-runtime';
import { runtimeBrowserKey, runtimeBrowserPublicKey } from './runtime-browser.js';
import { ServiceAssertionBodySchema, signServiceAssertion, type ServiceAssertionBody } from '@gitspace/protocol/service-access';
import { z } from 'zod';
import { tenantPlatformJson } from './tenant-platform.js';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { notifyBrowsers } from './live-notices.js';
import { BudgetedDurableObject, StorageIncidentReportSchema, StorageIncidentSchema, type StorageIncident, type StorageIncidentReport } from './storage-quarantine.js';
import { FiledIssueListInputSchema, FiledIssueResolveInputSchema, FiledIssueSchema, type FiledIssue, type FiledIssueListInput, type FiledIssueResolveInput } from '@gitspace/protocol-runtime/workspace-controls';

/** Storage incidents the account keeps, oldest first: past this, the oldest resolved ones are dropped. An object has at
 * most one active incident, and active ones are always kept. */
const STORAGE_INCIDENT_LIMIT = 50;
/** Resolved storage incidents stay listed this long. */
const STORAGE_INCIDENT_HISTORY_MS = 7 * 24 * 60 * 60_000;
/** After an incident is cleared (resumed or dismissed), the object's alerts stay silent this long (a quarantine still shows). */
const STORAGE_ALERT_SNOOZE_MS = 6 * 60 * 60_000;
/** Filed issues the account keeps: filing past this evicts the oldest resolved one, and is refused when all are open. */
const FILED_ISSUE_LIMIT = 500;

// A successful platform observation is authoritative for at most 60 seconds.
// Refresh on use after 15 seconds; outage retries coalesce and wait 5 seconds.
// The original observation time survives reconstruction and is never extended
// by a failed refresh. A new tenant has no authorization until platform confirms it.
const AUTHORITY_REFRESH_MS = 15_000;
const AUTHORITY_MAX_STALE_MS = 60_000;
const AUTHORITY_RETRY_MS = 5_000;
const authoritySchema = z.object({
  accountId: z.string(), tenantId: z.string(), platformUrl: z.string(),
  checkedAt: z.number().finite(), retryAt: z.number().finite(),
  status: z.string().min(1).nullable(),
});
const platformControlSchema = z.object({ control: z.object({ status: z.string().min(1) }) });
export type AccountAuthorization =
  | { status: 'active'; checkedAt: number; refreshAt: number; expiresAt: number }
  | { status: 'blocked' }
  | { status: 'unavailable' };

export interface AccountRecord {
  userId: string;
  handle: string;
  status: 'active' | 'suspended' | 'quarantined';
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  tenantHostname: string;
  tenantRelease: string | null;
  tenantProvisionedAt: number | null;
  lastError: string | null;
}
export class AccountStateDO extends BudgetedDurableObject {
 private authorityCheck: Promise<AccountAuthorization> | null = null;

 async authorization(userId: string): Promise<AccountAuthorization> {
   if (userId !== this.env.ACCOUNT_ID) return { status: 'blocked' };
   if (this.authorityCheck) return this.authorityCheck;
   this.authorityCheck = this.readAuthority();
   try { return await this.authorityCheck; }
   finally { this.authorityCheck = null; }
 }

 private async readAuthority(): Promise<AccountAuthorization> {
   const now = Date.now();
   const parsed = authoritySchema.safeParse(await this.ctx.storage.get('platform-authority'));
   let cached = parsed.success && parsed.data.accountId === this.env.ACCOUNT_ID
     && parsed.data.tenantId === this.env.TENANT_ID && parsed.data.platformUrl === this.env.PLATFORM_URL
     && parsed.data.checkedAt <= now && parsed.data.retryAt <= now + AUTHORITY_REFRESH_MS
     ? parsed.data : null;
   if (!cached || now >= cached.retryAt) {
     try {
       const state = platformControlSchema.parse(await tenantPlatformJson<unknown>(this.env, '/state', { signal: AbortSignal.timeout(2_000) }));
       cached = { accountId: this.env.ACCOUNT_ID, tenantId: this.env.TENANT_ID, platformUrl: this.env.PLATFORM_URL, checkedAt: now, retryAt: now + AUTHORITY_REFRESH_MS, status: state.control.status };
     } catch {
       cached = {
         accountId: this.env.ACCOUNT_ID, tenantId: this.env.TENANT_ID, platformUrl: this.env.PLATFORM_URL,
         checkedAt: cached?.checkedAt ?? now, retryAt: Date.now() + AUTHORITY_RETRY_MS, status: cached?.status ?? null,
       };
     }
     await this.ctx.storage.put('platform-authority', cached);
   }
   const expiresAt = cached.checkedAt + AUTHORITY_MAX_STALE_MS;
   if (cached.status === null || Date.now() >= expiresAt) return { status: 'unavailable' };
   return cached.status === 'active'
     ? { status: 'active', checkedAt: cached.checkedAt, refreshAt: Math.min(cached.retryAt, expiresAt), expiresAt }
     : { status: 'blocked' };
 }

 constructor(ctx: DurableObjectState, env: Env) {
   super(ctx, env);
   this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS account_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), created_at INTEGER NOT NULL)');
   this.ctx.storage.sql.exec('INSERT OR IGNORE INTO account_identity(singleton,created_at) VALUES(1,?)', Date.now());
   this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS filed_issues (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, state TEXT NOT NULL, filed_at TEXT NOT NULL, row TEXT NOT NULL)');
   this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS filed_issues_by_time ON filed_issues(state, filed_at)');
 }
 get(userId: string): AccountRecord | null {
   if (userId !== this.env.ACCOUNT_ID) return null;
   const createdAt = this.ctx.storage.sql.exec<{ created_at: number }>('SELECT created_at FROM account_identity WHERE singleton=1').one().created_at;
   return { userId, handle: this.env.TENANT_ID, status: 'active', reason: null, createdAt, updatedAt: createdAt, tenantHostname: new URL(this.env.RELAY_URL).hostname, tenantRelease: null, tenantProvisionedAt: createdAt, lastError: null };
 }
 getByHandle(handle: string): AccountRecord | null { return handle === this.env.TENANT_ID ? this.get(this.env.ACCOUNT_ID) : null; }
 async browserTrust() {
   return { accountId: this.env.ACCOUNT_ID, ...await runtimeBrowserPublicKey(this.ctx.storage) };
 }
 async signServiceRequest(raw: ServiceAssertionBody) {
   const body = ServiceAssertionBodySchema.parse(raw);
   const now = Date.now();
   if (body.accountId !== this.env.ACCOUNT_ID || body.caller.accountId !== this.env.ACCOUNT_ID || body.issuedAt > now + 5000 || body.expiresAt <= now || body.expiresAt - body.issuedAt > 60_000) throw new Error('Invalid service assertion');
   return signServiceAssertion(body, (await runtimeBrowserKey(this.ctx.storage)).privateKey);
 }
 async certifyBrowserAuthority(raw: RuntimeBrowserAuthorityCertificateBody) {
   const body = RuntimeBrowserAuthorityCertificateBodySchema.parse(raw);
   const now = Date.now();
   if (body.accountId !== this.env.ACCOUNT_ID || Date.parse(body.issuedAt) > now + 5000 || Date.parse(body.expiresAt) <= now || Date.parse(body.expiresAt) > now + 24 * 60 * 60_000) throw new Error('Invalid workspace browser authority');
   return signRuntimeBrowserAuthorityCertificate(body, (await runtimeBrowserKey(this.ctx.storage)).privateKey);
  }

  /** Records a storage incident as the object's active one: it replaces an active alert, and an active quarantine is not
   * replaced by an alert. Alerts of an object whose incident was cleared within `STORAGE_ALERT_SNOOZE_MS` are dropped. */
  async recordStorageIncident(raw: StorageIncidentReport): Promise<void> {
    const incident = StorageIncidentReportSchema.parse(raw);
    const incidents = await this.listStorageIncidents();
    const active = incidents.find(item => item.objectId === incident.objectId && item.resolvedAt === null);
    if (active?.kind === 'quarantine' && incident.kind === 'alert') return;
    if (incident.kind === 'alert' && ((await this.storageAlertSnoozes())[incident.objectId] ?? 0) > Date.now()) return;
    await this.saveStorageIncidents([...incidents.filter(item => item !== active), { ...incident, name: incident.name ?? active?.name ?? null, resolvedAt: null }]);
  }

  /** The active storage incidents and those resolved within `STORAGE_INCIDENT_HISTORY_MS`, oldest first. */
  async listStorageIncidents(): Promise<StorageIncident[]> {
    const parsed = z.array(StorageIncidentSchema).safeParse(await this.ctx.storage.get('storage-incidents'));
    const since = Date.now() - STORAGE_INCIDENT_HISTORY_MS;
    return parsed.success ? parsed.data.filter(item => item.resolvedAt === null || Date.parse(item.resolvedAt) > since) : [];
  }

  /**
   * Resolves the object's active incident. `healthy`: the watchdog found the object back under every alert threshold,
   * which resolves an alert; a quarantine stays until the object is resumed. `cleared`: the object was resumed or its
   * alert dismissed, which resolves either kind; its alerts then stay silent for `STORAGE_ALERT_SNOOZE_MS`.
   */
  async resolveStorageIncident(objectId: string, cause: 'healthy' | 'cleared'): Promise<void> {
    const now = Date.now();
    if (cause === 'cleared') {
      const snoozes = Object.fromEntries(Object.entries(await this.storageAlertSnoozes()).filter(([, until]) => until > now));
      await this.ctx.storage.put('storage-alert-snoozes', { ...snoozes, [objectId]: now + STORAGE_ALERT_SNOOZE_MS });
    }
    const incidents = await this.listStorageIncidents();
    const active = incidents.find(item => item.objectId === objectId && item.resolvedAt === null);
    if (!active || (cause === 'healthy' && active.kind === 'quarantine')) return;
    await this.saveStorageIncidents(incidents.map(item => item === active ? { ...item, resolvedAt: new Date(now).toISOString() } : item));
  }

  /** Stores the incidents, dropping the oldest resolved ones past `STORAGE_INCIDENT_LIMIT`, and tells the browsers. */
  private async saveStorageIncidents(incidents: StorageIncident[]): Promise<void> {
    const evicted = new Set(incidents.filter(item => item.resolvedAt !== null).slice(0, Math.max(0, incidents.length - STORAGE_INCIDENT_LIMIT)));
    await this.ctx.storage.put('storage-incidents', incidents.filter(item => !evicted.has(item)));
    await notifyBrowsers(this.env, [{ ...accountLiveKey('storage-incidents'), version: Date.now() }]);
  }

  private async storageAlertSnoozes(): Promise<Record<string, number>> {
    const parsed = z.record(z.string(), z.number()).safeParse(await this.ctx.storage.get('storage-alert-snoozes'));
    return parsed.success ? parsed.data : {};
  }

  /** Stores one filed issue by its id: filing it again rewrites the same row and reopens it. An id another workspace
   * filed is refused rather than overwritten. */
  fileIssue(raw: Omit<FiledIssue, 'state' | 'resolution'>): FiledIssue {
    const issue = FiledIssueSchema.parse({ ...raw, state: 'open', resolution: null });
    const sql = this.ctx.storage.sql;
    const existing = sql.exec<{ project_id: string; workspace_id: string }>('SELECT project_id, workspace_id FROM filed_issues WHERE id=?', issue.id).toArray()[0];
    if (existing && (existing.project_id !== issue.projectId || existing.workspace_id !== issue.workspaceId)) throw new Error('A different workspace filed an issue with this id');
    if (!existing && sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM filed_issues').one().count >= FILED_ISSUE_LIMIT) {
      const oldest = sql.exec<{ id: string }>('SELECT id FROM filed_issues WHERE state=\'resolved\' ORDER BY filed_at LIMIT 1').toArray()[0];
      if (!oldest) throw new Error(`GitSpace keeps at most ${FILED_ISSUE_LIMIT} filed issues; resolve some first`);
      sql.exec('DELETE FROM filed_issues WHERE id=?', oldest.id);
    }
    sql.exec('INSERT INTO filed_issues(id,project_id,workspace_id,state,filed_at,row) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, filed_at=excluded.filed_at, row=excluded.row',
      issue.id, issue.projectId, issue.workspaceId, issue.state, issue.filedAt, JSON.stringify(issue));
    return issue;
  }

  listFiledIssues(raw: FiledIssueListInput = {}): FiledIssue[] {
    const input = FiledIssueListInputSchema.parse(raw);
    const rows = this.ctx.storage.sql.exec<{ row: string }>(
      'SELECT row FROM filed_issues WHERE (?1 IS NULL OR state=?1) AND (?2 IS NULL OR filed_at<?2) ORDER BY filed_at DESC, id DESC LIMIT ?3',
      input.state ?? null, input.before ?? null, input.limit,
    ).toArray();
    return rows.map(row => FiledIssueSchema.parse(JSON.parse(row.row)));
  }

  /** Marks a filed issue resolved here only: the workspace's own issue is not changed. */
  resolveFiledIssue(raw: FiledIssueResolveInput): FiledIssue {
    const input = FiledIssueResolveInputSchema.parse(raw);
    const stored = this.ctx.storage.sql.exec<{ row: string }>('SELECT row FROM filed_issues WHERE id=?', input.id).toArray()[0];
    if (!stored) throw new Error(`No filed issue ${input.id}`);
    const issue = FiledIssueSchema.parse({ ...FiledIssueSchema.parse(JSON.parse(stored.row)), state: 'resolved', resolution: { at: new Date().toISOString(), commit: input.commit, note: input.note } });
    this.ctx.storage.sql.exec('UPDATE filed_issues SET state=?, row=? WHERE id=?', issue.state, JSON.stringify(issue), issue.id);
    return issue;
  }
}
