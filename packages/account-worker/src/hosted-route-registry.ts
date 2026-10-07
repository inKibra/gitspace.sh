import { DurableObject } from 'cloudflare:workers';
import { hostedServiceRouteSchema, type HostedServiceRoute } from '@gitspace/protocol';

interface HostedRouteRow extends Record<string, SqlStorageValue> {
  tenant: string;
  route_json: string;
  lease_expires_at: string;
}

export interface ResolvedHostedRoute extends HostedServiceRoute {
  tenant: string;
}

export class HostedRouteRegistryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS active_route (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tenant TEXT NOT NULL,
          route_json TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL
        )
      `);
    });
  }

  lease(tenant: string, route: HostedServiceRoute): ResolvedHostedRoute {
    if (route.leaseExpiresAt <= new Date().toISOString()) throw new Error('Hosted route lease must expire in the future');
    const row = this.ctx.storage.sql.exec<HostedRouteRow>('SELECT tenant, route_json, lease_expires_at FROM active_route WHERE id=1').toArray()[0];
    if (row) {
      const current = hostedServiceRouteSchema.parse(JSON.parse(row.route_json));
      const sameOwner = row.tenant === tenant && current.machineId === route.machineId && current.workspaceId === route.workspaceId && current.serviceName === route.serviceName;
      if ((!sameOwner && row.lease_expires_at > new Date().toISOString()) || (sameOwner && route.generation < current.generation)) throw new Error('Hosted route lease owner or generation conflict');
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO active_route(id, tenant, route_json, lease_expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tenant=excluded.tenant, route_json=excluded.route_json, lease_expires_at=excluded.lease_expires_at`,
      tenant,
      JSON.stringify(route),
      route.leaseExpiresAt,
    );
    return { tenant, ...route };
  }

  get(now = new Date().toISOString()): ResolvedHostedRoute | null {
    const row = this.ctx.storage.sql.exec<HostedRouteRow>(
      'SELECT tenant, route_json, lease_expires_at FROM active_route WHERE id=1 AND lease_expires_at>?',
      now,
    ).toArray()[0];
    return row ? { tenant: row.tenant, ...hostedServiceRouteSchema.parse(JSON.parse(row.route_json)) } : null;
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
}
