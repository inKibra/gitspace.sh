import { z } from 'zod';
import { hostedServicePointerSchema, hostedServiceRouteSchema, hostedServiceUrlKind, type HostedRouteLease, type HostedServicePointer, type HostedServiceRoute } from '@gitspace/protocol';
import { HostedIngressCredentialSchema, ServiceIngressRouteSchema, serviceIngressMatches, type HostedIngressCredential, type IssuedServiceToken, type ServiceIngressRoute } from '@gitspace/protocol-environment';
import { BudgetedDurableObject } from './storage-quarantine.js';
import { ManagedKeySchema, verifyingKeys, type ManagedIngressCredential, type ManagedKey, type ManagedRefreshRecord, type ManagedTokenRecord } from './service-tokens.js';

interface HostedRouteRow extends Record<string, SqlStorageValue> {
  tenant: string;
  route_json: string;
  lease_expires_at: string;
}

interface HostedPointerRow extends Record<string, SqlStorageValue> {
  tenant: string;
  project_id: string;
  pointer_json: string;
}

interface HostedIngressRow extends Record<string, SqlStorageValue> {
  tenant: string;
  workspace_id: string;
  routes_json: string;
  credentials_json: string;
}

interface ManagedRow extends Record<string, SqlStorageValue> {
  tenant: string;
  workspace_id: string;
  service: string;
  port: string;
  issuer: string;
  keys_json: string;
}

interface ManagedTokenRow extends Record<string, SqlStorageValue> {
  jti: string;
  subject: string;
  issued_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  family: string | null;
}

interface ManagedRefreshRow extends Record<string, SqlStorageValue> {
  family: string;
  subject: string;
  expires_at: string;
  spent_at: string | null;
}

export interface ResolvedHostedRoute extends HostedServiceRoute {
  tenant: string;
}

/** A workspace URL whose target is not up: answered as offline on that machine. */
export interface HostedRouteOffline {
  tenant: string;
  machine: string;
}

const [OidcCredentialSchema, JwtCredentialSchema] = HostedIngressCredentialSchema.options;
/** A registered credential as kept: a bearer keeps its current hash and, through one rotation, the previous one. */
const StoredIngressCredentialSchema = z.discriminatedUnion('kind', [
  OidcCredentialSchema,
  JwtCredentialSchema,
  z.object({ kind: z.literal('bearer'), secret: z.string(), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(2) }).strict(),
]);
/** A credential the edge tries: one a script registered, or the URL's service tokens on routes that set `tokens: true`. */
export type StoredIngressCredential = z.infer<typeof StoredIngressCredentialSchema> | ManagedIngressCredential;

/** The signed callers a workspace URL admits on a request's method and path. */
export interface HostedIngress {
  tenant: string;
  workspaceId: string;
  credentials: StoredIngressCredential[];
}

/** What a hostname answers: its live route, else the machine it is offline on. */
export interface HostedRouteTarget {
  route: ResolvedHostedRoute | null;
  offline: HostedRouteOffline | null;
}

export interface HostedRouteResolution extends HostedRouteTarget {
  ingress: HostedIngress | null;
}

export type HostedIngressAdmission = { admitted: true; at: string } | { admitted: false; at: string; reason: string };

/** A refresh token's binding, for signing the access token that replaces it. */
export interface ManagedRefreshGrant {
  tenant: string;
  workspaceId: string;
  service: string;
  port: string;
  subject: string;
  family: string;
}

/** A token's last use is written at most this often. */
const LAST_USE_RESOLUTION_MS = 60_000;
const ISSUED_TOKEN_LIST_LIMIT = 200;

function targets(pointer: HostedServicePointer, route: HostedServiceRoute): boolean {
  return pointer.workspaceId === route.workspaceId && pointer.machineId === route.machineId && pointer.serviceName === route.serviceName && pointer.source === route.source && pointer.portName === route.portName;
}

/** One hostname. A machine URL is leased by its one machine; a workspace URL by the machine its stored pointer names. */
export class HostedRouteRegistryDO extends BudgetedDurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS active_route (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tenant TEXT NOT NULL,
          route_json TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pointer (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tenant TEXT NOT NULL,
          project_id TEXT NOT NULL,
          pointer_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ingress (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tenant TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          routes_json TEXT NOT NULL,
          credentials_json TEXT NOT NULL,
          registered_at TEXT NOT NULL,
          admitted INTEGER NOT NULL DEFAULT 0,
          rejected INTEGER NOT NULL DEFAULT 0,
          last_admitted_at TEXT,
          last_failure_json TEXT
        );
        CREATE TABLE IF NOT EXISTS managed (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tenant TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          service TEXT NOT NULL,
          port TEXT NOT NULL,
          issuer TEXT NOT NULL,
          keys_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS managed_tokens (
          jti TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT,
          family TEXT
        );
        CREATE INDEX IF NOT EXISTS managed_tokens_expiry ON managed_tokens(expires_at);
        CREATE INDEX IF NOT EXISTS managed_tokens_family ON managed_tokens(family);
        CREATE TABLE IF NOT EXISTS managed_refresh (
          hash TEXT PRIMARY KEY,
          family TEXT NOT NULL,
          subject TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          spent_at TEXT
        );
        CREATE INDEX IF NOT EXISTS managed_refresh_expiry ON managed_refresh(expires_at);
        CREATE INDEX IF NOT EXISTS managed_refresh_family ON managed_refresh(family)
      `);
    });
  }

  /** A workspace URL without a pointer is claimed by the first declared service to lease it; an ad hoc process needs a pin. */
  lease(tenant: string, projectId: string, route: HostedServiceRoute, machineLabel: string): HostedRouteLease {
    const now = new Date().toISOString();
    if (route.leaseExpiresAt <= now) throw new Error('Hosted route lease must expire in the future');
    if (hostedServiceUrlKind(route.hostname) === 'machine') {
      this.writeRoute(tenant, route, true);
      return { route, pointer: null };
    }
    const stored = this.storedPointer();
    if (stored && stored.tenant !== tenant) throw new Error('Hosted route lease owner or generation conflict');
    if (stored && !targets(stored.pointer, route)) return { route: null, pointer: stored.pointer };
    if (!stored && route.source !== 'declared') return { route: null, pointer: null };
    const pointer = stored?.pointer ?? this.writePointer(tenant, projectId, {
      hostname: route.hostname, workspaceId: route.workspaceId, machineId: route.machineId, machineLabel,
      serviceName: route.serviceName, source: route.source, portName: route.portName, setAt: now, setBy: 'start',
    });
    this.writeRoute(tenant, route, false);
    return { route, pointer };
  }

  /** Points a workspace URL at this route's machine, service and port, and leases it, in one step. */
  pin(tenant: string, projectId: string, route: HostedServiceRoute, pointer: HostedServicePointer): HostedRouteLease {
    if (hostedServiceUrlKind(route.hostname) !== 'workspace' || pointer.hostname !== route.hostname || !targets(pointer, route)) throw new Error('A pin names one workspace URL and the route it points at');
    if (route.leaseExpiresAt <= new Date().toISOString()) throw new Error('Hosted route lease must expire in the future');
    const stored = this.storedPointer();
    if (stored && stored.tenant !== tenant) throw new Error('Hosted route lease owner or generation conflict');
    this.writePointer(tenant, projectId, pointer);
    this.writeRoute(tenant, route, false);
    return { route, pointer };
  }

  get(now = new Date().toISOString()): ResolvedHostedRoute | null {
    const row = this.ctx.storage.sql.exec<HostedRouteRow>(
      'SELECT tenant, route_json, lease_expires_at FROM active_route WHERE id=1 AND lease_expires_at>?',
      now,
    ).toArray()[0];
    return row ? { tenant: row.tenant, ...hostedServiceRouteSchema.parse(JSON.parse(row.route_json)) } : null;
  }

  /** The machine a workspace URL points at when its route is not up; null when it is up or points nowhere. */
  offline(now = new Date().toISOString()): HostedRouteOffline | null {
    const stored = this.storedPointer();
    if (!stored) return null;
    const live = this.get(now);
    return live && targets(stored.pointer, live) ? null : { tenant: stored.tenant, machine: stored.pointer.machineLabel };
  }

  /**
   * One read per request: the target, and the signed callers when the request falls under a declared route of the
   * workspace the URL serves. On a route that sets `tokens: true` they include the URL's service tokens (`managed`).
   */
  resolve(method: string, pathname: string, now = new Date().toISOString()): HostedRouteResolution {
    const route = this.get(now);
    const offline = this.offline(now);
    const row = this.ctx.storage.sql.exec<HostedIngressRow>('SELECT tenant, workspace_id, routes_json, credentials_json FROM ingress WHERE id=1').toArray()[0];
    const routes = row ? z.array(ServiceIngressRouteSchema).parse(JSON.parse(row.routes_json)) : [];
    if (!row || !serviceIngressMatches(routes, method, pathname)) return { route, offline, ingress: null };
    const stored = this.storedPointer();
    if (stored && (stored.tenant !== row.tenant || stored.pointer.workspaceId !== row.workspace_id)) return { route, offline, ingress: null };
    const credentials: StoredIngressCredential[] = z.array(StoredIngressCredentialSchema).parse(JSON.parse(row.credentials_json));
    const managed = serviceIngressMatches(routes.filter(entry => entry.tokens), method, pathname) ? this.managedRow(row.tenant, row.workspace_id) : null;
    if (managed) credentials.push({ kind: 'managed', issuer: managed.issuer, keys: verifyingKeys(z.array(ManagedKeySchema).parse(JSON.parse(managed.keys_json)), now) });
    return { route, offline, ingress: { tenant: row.tenant, workspaceId: row.workspace_id, credentials } };
  }

  /**
   * Replaces a workspace URL's declared routes and credentials, keeping its counts and its service tokens. A bearer
   * registered again under its secret with a new hash keeps the old one for rotation. `credentials` null keeps the
   * URL's registered credentials (a run that wrote no `ingress.json`).
   */
  registerIngress(tenant: string, workspaceId: string, routes: ServiceIngressRoute[], credentials: HostedIngressCredential[] | null, registeredAt: string): void {
    const stored = this.storedPointer();
    const row = this.ctx.storage.sql.exec<HostedIngressRow>('SELECT tenant, workspace_id, routes_json, credentials_json FROM ingress WHERE id=1').toArray()[0];
    if ((stored && (stored.tenant !== tenant || stored.pointer.workspaceId !== workspaceId)) || (row && (row.tenant !== tenant || row.workspace_id !== workspaceId))) throw new Error('Signed callers belong to the workspace this URL serves');
    const previous = row ? z.array(StoredIngressCredentialSchema).parse(JSON.parse(row.credentials_json)) : [];
    const kept = credentials === null ? previous : credentials.map((credential): z.infer<typeof StoredIngressCredentialSchema> => {
      if (credential.kind !== 'bearer') return credential;
      const before = previous.find((entry): entry is Extract<z.infer<typeof StoredIngressCredentialSchema>, { kind: 'bearer' }> => entry.kind === 'bearer' && entry.secret === credential.secret);
      const hashes = !before ? [credential.sha256] : before.hashes[0] === credential.sha256 ? before.hashes : [credential.sha256, before.hashes[0]];
      return { kind: 'bearer', secret: credential.secret, hashes };
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO ingress(id, tenant, workspace_id, routes_json, credentials_json, registered_at) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET routes_json=excluded.routes_json, credentials_json=excluded.credentials_json, registered_at=excluded.registered_at`,
      tenant,
      workspaceId,
      JSON.stringify(routes),
      JSON.stringify(kept),
      registeredAt,
    );
  }

  /** Ends the URL's signed callers, its service tokens with them. */
  clearIngress(tenant: string, workspaceId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM ingress WHERE id=1 AND tenant=? AND workspace_id=?', tenant, workspaceId);
    this.clearManaged(tenant, workspaceId);
  }

  /**
   * The URL admits the tokens of a workspace service's managed key, kept apart from script credentials so a script's
   * registration never replaces it. A URL that now serves another service or port starts with no issued tokens.
   */
  registerManaged(tenant: string, workspaceId: string, service: string, port: string, issuer: string, keys: ManagedKey[]): void {
    const stored = this.storedPointer();
    if (stored && (stored.tenant !== tenant || stored.pointer.workspaceId !== workspaceId)) throw new Error('Service tokens belong to the workspace this URL serves');
    const row = this.ctx.storage.sql.exec<ManagedRow>('SELECT tenant, workspace_id, service, port, issuer, keys_json FROM managed WHERE id=1').toArray()[0];
    if (row && row.tenant === tenant && row.workspace_id === workspaceId && row.service === service && row.port === port && row.issuer === issuer) {
      this.writeManagedKeys(row, keys);
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.clearManagedTables();
      this.ctx.storage.sql.exec('INSERT INTO managed(id, tenant, workspace_id, service, port, issuer, keys_json) VALUES (1, ?, ?, ?, ?, ?, ?)', tenant, workspaceId, service, port, issuer, JSON.stringify(keys));
    });
  }

  /** The URL no longer admits service tokens; its issued and refresh tokens go. */
  clearManaged(tenant: string, workspaceId: string): void {
    if (this.managedRow(tenant, workspaceId)) this.ctx.storage.transactionSync(() => this.clearManagedTables());
  }

  /** The service's keys after a rotation in the vault. */
  updateManagedKeys(tenant: string, workspaceId: string, keys: ManagedKey[]): void {
    const row = this.managedRow(tenant, workspaceId);
    if (!row) throw new Error('This workspace URL does not admit service tokens');
    this.writeManagedKeys(row, keys);
  }

  /** Lists a newly signed token (and the refresh token issued with it), with the keys it was signed under. */
  issueManaged(tenant: string, workspaceId: string, keys: ManagedKey[], token: ManagedTokenRecord, refresh: ManagedRefreshRecord | null): void {
    const row = this.managedRow(tenant, workspaceId);
    if (!row) throw new Error('This workspace URL does not admit service tokens; run workspace/materialize after approving its token routes');
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.writeManagedKeys(row, keys);
      this.ctx.storage.sql.exec('DELETE FROM managed_tokens WHERE expires_at <= ?', now);
      this.ctx.storage.sql.exec('DELETE FROM managed_refresh WHERE expires_at <= ?', now);
      this.ctx.storage.sql.exec('INSERT INTO managed_tokens(jti, subject, issued_at, expires_at, family) VALUES (?, ?, ?, ?, ?)', token.jti, token.subject, token.issuedAt, token.expiresAt, token.family);
      if (refresh) this.ctx.storage.sql.exec('INSERT INTO managed_refresh(hash, family, subject, expires_at) VALUES (?, ?, ?, ?)', refresh.hash, refresh.family, refresh.subject, refresh.expiresAt);
    });
  }

  /**
   * Whether a token whose signature the edge verified is still good: listed for this URL, unrevoked and unexpired.
   * Records its use.
   */
  useManagedToken(jti: string, at: string): boolean {
    const token = this.ctx.storage.sql.exec<ManagedTokenRow>('SELECT jti, subject, issued_at, expires_at, last_used_at, revoked_at, family FROM managed_tokens WHERE jti=?', jti).toArray()[0];
    if (!token || token.revoked_at !== null || token.expires_at <= at) return false;
    if (token.last_used_at === null || Date.parse(at) - Date.parse(token.last_used_at) >= LAST_USE_RESOLUTION_MS) this.ctx.storage.sql.exec('UPDATE managed_tokens SET last_used_at=? WHERE jti=?', at, jti);
    return true;
  }

  /**
   * What a refresh token is bound to, when it is unspent and unexpired. Presenting a spent one revokes its chain: every
   * access and refresh token issued in it.
   */
  redeemRefresh(hash: string): ManagedRefreshGrant | null {
    const managed = this.ctx.storage.sql.exec<ManagedRow>('SELECT tenant, workspace_id, service, port, issuer, keys_json FROM managed WHERE id=1').toArray()[0];
    const refresh = this.ctx.storage.sql.exec<ManagedRefreshRow>('SELECT family, subject, expires_at, spent_at FROM managed_refresh WHERE hash=?', hash).toArray()[0];
    if (!managed || !refresh) return null;
    if (refresh.spent_at !== null) {
      this.revokeFamily(refresh.family, new Date().toISOString());
      return null;
    }
    if (refresh.expires_at <= new Date().toISOString()) return null;
    return { tenant: managed.tenant, workspaceId: managed.workspace_id, service: managed.service, port: managed.port, subject: refresh.subject, family: refresh.family };
  }

  /**
   * Spends a refresh token and lists its replacements, at once. False when it was spent meanwhile (its chain is then
   * revoked) or is no longer good; the replacements are then not listed, so the edge refuses them.
   */
  exchangeRefresh(hash: string, keys: ManagedKey[], token: ManagedTokenRecord, refresh: ManagedRefreshRecord): boolean {
    const row = this.ctx.storage.sql.exec<ManagedRow>('SELECT tenant, workspace_id, service, port, issuer, keys_json FROM managed WHERE id=1').toArray()[0];
    if (!row) return false;
    const now = new Date().toISOString();
    return this.ctx.storage.transactionSync(() => {
      const spent = this.ctx.storage.sql.exec<{ family: string }>('UPDATE managed_refresh SET spent_at=? WHERE hash=? AND spent_at IS NULL AND expires_at>? RETURNING family', now, hash, now).toArray()[0];
      if (!spent) {
        const known = this.ctx.storage.sql.exec<{ family: string }>('SELECT family FROM managed_refresh WHERE hash=? AND spent_at IS NOT NULL', hash).toArray()[0];
        if (known) this.revokeFamily(known.family, now);
        return false;
      }
      this.writeManagedKeys(row, keys);
      this.ctx.storage.sql.exec('INSERT INTO managed_tokens(jti, subject, issued_at, expires_at, family) VALUES (?, ?, ?, ?, ?)', token.jti, token.subject, token.issuedAt, token.expiresAt, token.family);
      this.ctx.storage.sql.exec('INSERT INTO managed_refresh(hash, family, subject, expires_at) VALUES (?, ?, ?, ?)', refresh.hash, refresh.family, refresh.subject, refresh.expiresAt);
      return true;
    });
  }

  /** The URL's unexpired issued tokens, newest first. */
  managedTokens(tenant: string, workspaceId: string): Array<Omit<IssuedServiceToken, 'url'>> {
    if (!this.managedRow(tenant, workspaceId)) return [];
    return this.ctx.storage.sql.exec<ManagedTokenRow>(
      'SELECT jti, subject, issued_at, expires_at, last_used_at, revoked_at, family FROM managed_tokens WHERE expires_at>? ORDER BY issued_at DESC LIMIT ?',
      new Date().toISOString(), ISSUED_TOKEN_LIST_LIMIT,
    ).toArray().map(row => ({ id: row.jti, subject: row.subject, issuedAt: row.issued_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at, refreshable: row.family !== null }));
  }

  /** Revokes one issued token and, when it belongs to a refresh chain, the whole chain. */
  revokeManaged(tenant: string, workspaceId: string, jti: string): boolean {
    if (!this.managedRow(tenant, workspaceId)) return false;
    const token = this.ctx.storage.sql.exec<{ family: string | null }>('SELECT family FROM managed_tokens WHERE jti=?', jti).toArray()[0];
    if (!token) return false;
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE managed_tokens SET revoked_at=? WHERE jti=? AND revoked_at IS NULL', now, jti);
      if (token.family !== null) this.revokeFamily(token.family, now);
    });
    return true;
  }

  recordIngressAdmission(admission: HostedIngressAdmission): void {
    if (admission.admitted) this.ctx.storage.sql.exec('UPDATE ingress SET admitted=admitted+1, last_admitted_at=? WHERE id=1', admission.at);
    else this.ctx.storage.sql.exec('UPDATE ingress SET rejected=rejected+1, last_failure_json=? WHERE id=1', JSON.stringify({ at: admission.at, reason: admission.reason }));
  }

  release(tenant: string, machineId: string, generation: number): boolean {
    return this.ctx.storage.sql.exec(
      `UPDATE active_route SET lease_expires_at='1970-01-01T00:00:00.000Z'
       WHERE id=1 AND tenant=? AND json_extract(route_json, '$.machineId')=? AND json_extract(route_json, '$.generation')=? AND lease_expires_at>?
       RETURNING id`,
      tenant,
      machineId,
      generation,
      new Date().toISOString(),
    ).toArray().length > 0;
  }

  /** Ends a deleted or archived workspace's URL: its pointer and signed callers go and its route stops answering. */
  clear(tenant: string, workspaceId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM pointer WHERE id=1 AND tenant=? AND json_extract(pointer_json, '$.workspaceId')=?", tenant, workspaceId);
    this.ctx.storage.sql.exec(
      "UPDATE active_route SET lease_expires_at='1970-01-01T00:00:00.000Z' WHERE id=1 AND tenant=? AND json_extract(route_json, '$.workspaceId')=?",
      tenant,
      workspaceId,
    );
    this.clearIngress(tenant, workspaceId);
  }

  private managedRow(tenant: string, workspaceId: string): ManagedRow | undefined {
    return this.ctx.storage.sql.exec<ManagedRow>('SELECT tenant, workspace_id, service, port, issuer, keys_json FROM managed WHERE id=1 AND tenant=? AND workspace_id=?', tenant, workspaceId).toArray()[0];
  }

  private writeManagedKeys(row: ManagedRow, keys: ManagedKey[]): void {
    const json = JSON.stringify(keys);
    if (json !== row.keys_json) this.ctx.storage.sql.exec('UPDATE managed SET keys_json=? WHERE id=1', json);
  }

  private revokeFamily(family: string, at: string): void {
    this.ctx.storage.sql.exec('UPDATE managed_tokens SET revoked_at=? WHERE family=? AND revoked_at IS NULL', at, family);
    this.ctx.storage.sql.exec('UPDATE managed_refresh SET spent_at=? WHERE family=? AND spent_at IS NULL', at, family);
  }

  private clearManagedTables(): void {
    this.ctx.storage.sql.exec('DELETE FROM managed');
    this.ctx.storage.sql.exec('DELETE FROM managed_tokens');
    this.ctx.storage.sql.exec('DELETE FROM managed_refresh');
  }

  private storedPointer(): { tenant: string; pointer: HostedServicePointer } | null {
    const row = this.ctx.storage.sql.exec<HostedPointerRow>('SELECT tenant, project_id, pointer_json FROM pointer WHERE id=1').toArray()[0];
    return row ? { tenant: row.tenant, pointer: hostedServicePointerSchema.parse(JSON.parse(row.pointer_json)) } : null;
  }

  private writePointer(tenant: string, projectId: string, pointer: HostedServicePointer): HostedServicePointer {
    this.ctx.storage.sql.exec(
      `INSERT INTO pointer(id, tenant, project_id, pointer_json) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tenant=excluded.tenant, project_id=excluded.project_id, pointer_json=excluded.pointer_json`,
      tenant,
      projectId,
      JSON.stringify(pointer),
    );
    return pointer;
  }

  /** A machine URL keeps its first live owner; a workspace URL's owner is its pointer's. Either way a same-owner lease cannot go back a generation. */
  private writeRoute(tenant: string, route: HostedServiceRoute, ownerFenced: boolean): void {
    const row = this.ctx.storage.sql.exec<HostedRouteRow>('SELECT tenant, route_json, lease_expires_at FROM active_route WHERE id=1').toArray()[0];
    if (row) {
      const current = hostedServiceRouteSchema.parse(JSON.parse(row.route_json));
      const sameOwner = row.tenant === tenant && current.machineId === route.machineId && current.workspaceId === route.workspaceId && current.serviceName === route.serviceName && current.source === route.source;
      if ((ownerFenced && !sameOwner && row.lease_expires_at > new Date().toISOString()) || (sameOwner && route.generation < current.generation)) throw new Error('Hosted route lease owner or generation conflict');
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO active_route(id, tenant, route_json, lease_expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tenant=excluded.tenant, route_json=excluded.route_json, lease_expires_at=excluded.lease_expires_at`,
      tenant,
      JSON.stringify(route),
      route.leaseExpiresAt,
    );
  }
}
