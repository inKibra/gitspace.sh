import { SERVICE_ASSERTION_HEADER, ServiceCallerSchema, stripGitSpaceCredentials, type ServiceCaller } from '@gitspace/protocol/service-access';
import { forwardTunnelRequest, INTERNAL_SIGNED_TARGET, INTERNAL_SERVICE_SESSION } from './relay-request.js';
import { ServiceSessionSchema, type ServiceSession } from './service-sessions.js';

export function isHostedServiceHostname(env: Pick<Env, 'TENANT_ID'>, hostname: string): boolean {
  return hostname.endsWith(`--${env.TENANT_ID}-srv.gssh.dev`);
}

/** Internal callers supply identity established by their owner, never request headers. */
export async function fetchInternalService(env: Env, rawCaller: ServiceCaller, request: Request, session?: ServiceSession): Promise<Response> {
  const caller = ServiceCallerSchema.parse(rawCaller);
  const url = new URL(request.url);
  if (caller.accountId !== env.ACCOUNT_ID || !isHostedServiceHostname(env, url.hostname) || !['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password) return new Response('Service access denied', { status: 403 });
  const route = await env.HOSTED_ROUTES.getByName(url.hostname).get();
  if (!route || route.tenant !== env.ACCOUNT_ID || Date.parse(route.leaseExpiresAt) <= Date.now()) return new Response('Service route unavailable', { status: 404 });
  if (caller.kind === 'cloud' && caller.workspaceId !== route.workspaceId) return new Response('Service workspace mismatch', { status: 403 });
  const target = `${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_SERVICE_SESSION);
  if (session) {
    const metadata = ServiceSessionSchema.parse(session);
    if (caller.kind !== 'device' || metadata.deviceId !== caller.deviceId || metadata.hostname !== url.hostname || metadata.expiresAt <= Date.now()) return new Response('Service session mismatch', { status: 403 });
    headers.set(INTERNAL_SERVICE_SESSION, JSON.stringify(metadata));
  }
  stripGitSpaceCredentials(headers);
  headers.delete('x-gitspace-device');
  headers.delete('x-gitspace-machine-grant');
  headers.delete('x-gitspace-websocket-probe');
  headers.set('x-forwarded-host', url.hostname);
  headers.set(INTERNAL_SIGNED_TARGET, target);
  headers.set(SERVICE_ASSERTION_HEADER, await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).signServiceRequest({ version: 1, accountId: env.ACCOUNT_ID, hostname: url.hostname, machineId: route.machineId, caller, method: request.method, target, issuedAt: Date.now(), expiresAt: Date.now() + 30_000, nonce: crypto.randomUUID() }));
  url.pathname = `/tunnel/${encodeURIComponent(route.machineId)}${url.pathname}`;
  return forwardTunnelRequest(new Request(url, { method: request.method, headers, body: request.body, redirect: 'manual', signal: request.signal }), env, { machineId: route.machineId, path: target });
}
