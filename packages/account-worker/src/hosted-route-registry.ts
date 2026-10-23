import { hostedServicePointerSchema, hostedServiceRouteSchema, hostedServiceUrlKind, type HostedRouteLease, type HostedServicePointer, type HostedServiceRoute } from '@gitspace/protocol';
import { BudgetedDurableObject } from './storage-quarantine.js';

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

export interface ResolvedHostedRoute extends HostedServiceRoute {
  tenant: string;
}

/** A workspace URL whose target is not up: answered as offline on that machine. */
export interface HostedRouteOffline {
  tenant: string;
  machine: string;
}

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
        )
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

  /** Ends a deleted or archived workspace's URL: its pointer goes and its route stops answering. */
  clear(tenant: string, workspaceId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM pointer WHERE id=1 AND tenant=? AND json_extract(pointer_json, '$.workspaceId')=?", tenant, workspaceId);
    this.ctx.storage.sql.exec(
      "UPDATE active_route SET lease_expires_at='1970-01-01T00:00:00.000Z' WHERE id=1 AND tenant=? AND json_extract(route_json, '$.workspaceId')=?",
      tenant,
      workspaceId,
    );
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
