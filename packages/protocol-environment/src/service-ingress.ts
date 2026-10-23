import { z } from 'zod';
import { EnvironmentError } from './errors.js';

/**
 * Signed callers: `.gitspace/services.json` declares per service the method and path patterns a caller with a registered
 * credential may reach on the service's workspace URLs (approved by content hash like a lifecycle script), and an approved
 * `cloud/provision` or `workspace/materialize` script registers the credentials by writing `ingress.json`.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=:@%-]+$/u;
export const SERVICE_INGRESS_ROUTE_LIMIT = 64;
export const INGRESS_FILE_LIMIT = 65_536;
/** The id of the one `ingress` lifecycle execution: every service's declared routes. */
export const SERVICE_INGRESS_EXECUTION_ID = 'ingress';

/** `*` is any method; a WebSocket upgrade is a `GET`. */
export const ServiceIngressMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*']);
export type ServiceIngressMethod = z.infer<typeof ServiceIngressMethodSchema>;

function pathSegmentValid(segment: string, last: boolean): boolean {
  if (last && (segment === '' || segment === '*')) return true;
  return SEGMENT.test(segment) && segment !== '.' && segment !== '..';
}

/** An exact path (`/a/b`) or a prefix (`/a/*`: `/a/` and every path under it; `/*` is every path). `/__gitspace` paths stay GitSpace's. */
export const ServiceIngressPathSchema = z.string().min(1).max(512).refine((path) => {
  if (!path.startsWith('/') || path.startsWith('/__gitspace')) return false;
  const segments = path.slice(1).split('/');
  return segments.every((segment, index) => pathSegmentValid(segment, index === segments.length - 1));
}, { message: 'Use an exact path like /a/b or a prefix like /a/* (no .., empty segments, other wildcards, or /__gitspace paths)' });

const serviceNameSchema = z.string().regex(NAME);
const portNameSchema = z.string().regex(NAME);

/** One route as `services.json` declares it; `port` names an `http` port and defaults to the service's first. */
export const ServiceIngressDeclarationSchema = z.object({
  method: ServiceIngressMethodSchema,
  path: ServiceIngressPathSchema,
  port: portNameSchema.optional(),
}).strict();
export const ServiceIngressRouteSchema = z.object({ method: ServiceIngressMethodSchema, path: ServiceIngressPathSchema }).strict();
export type ServiceIngressRoute = z.infer<typeof ServiceIngressRouteSchema>;
/** The routes of one `http` port, so of one workspace URL. */
export const ServiceIngressGroupSchema = z.object({
  service: serviceNameSchema,
  port: portNameSchema,
  routes: z.array(ServiceIngressRouteSchema).min(1).max(SERVICE_INGRESS_ROUTE_LIMIT),
}).strict();
export type ServiceIngressGroup = z.infer<typeof ServiceIngressGroupSchema>;

/** Whether a request's method and path fall under one of the routes. */
export function serviceIngressMatches(routes: readonly ServiceIngressRoute[], method: string, pathname: string): boolean {
  if (pathname.startsWith('/__gitspace/')) return false;
  return routes.some((route) => (route.method === '*' || route.method === method)
    && (route.path.endsWith('/*') ? pathname.startsWith(route.path.slice(0, -1)) : pathname === route.path));
}

/** One service's declared routes grouped by `http` port, sorted, so equal declarations give equal content. */
export function resolveServiceIngress(service: { name: string; ports: readonly { name: string; protocol: 'http' | 'tcp' }[] }, raw: unknown): ServiceIngressGroup[] {
  const parsed = z.array(ServiceIngressDeclarationSchema).max(SERVICE_INGRESS_ROUTE_LIMIT).safeParse(raw);
  if (!parsed.success) throw new EnvironmentError('InvalidConfiguration', `Service ${service.name} ingress must be at most ${SERVICE_INGRESS_ROUTE_LIMIT} routes of {method, path, port?}`, { service: service.name, detail: parsed.error.message });
  const http = service.ports.filter((port) => port.protocol === 'http').map((port) => port.name);
  const groups = new Map<string, Map<string, ServiceIngressRoute>>();
  for (const declaration of parsed.data) {
    const port = declaration.port ?? http[0];
    if (port === undefined || !http.includes(port)) throw new EnvironmentError('InvalidConfiguration', `Service ${service.name} ingress needs an http port${declaration.port ? ` named ${declaration.port}` : ''}`, { service: service.name });
    const routes = groups.get(port) ?? new Map<string, ServiceIngressRoute>();
    routes.set(`${declaration.path} ${declaration.method}`, { method: declaration.method, path: declaration.path });
    groups.set(port, routes);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([port, routes]) => ({
    service: service.name, port,
    routes: [...routes].sort(([left], [right]) => left.localeCompare(right)).map(([, route]) => route),
  }));
}

const ServicesIngressSourceSchema = z.looseObject({
  services: z.array(z.looseObject({
    name: serviceNameSchema,
    ports: z.array(z.looseObject({ name: portNameSchema, protocol: z.enum(['http', 'tcp']).optional() })).optional(),
    ingress: z.unknown().optional(),
  })),
});

/** The canonical content of every service's ingress in `services.json` (null when none declares any): what approval hashes. */
export function serviceIngressContent(source: string | null): string | null {
  if (source === null) return null;
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new EnvironmentError('InvalidConfiguration', '.gitspace/services.json is not valid JSON'); }
  const parsed = ServicesIngressSourceSchema.safeParse(value);
  if (!parsed.success) {
    const declaresIngress = typeof value === 'object' && value !== null && 'services' in value && Array.isArray(value.services)
      && value.services.some((service: unknown) => typeof service === 'object' && service !== null && 'ingress' in service);
    if (declaresIngress) throw new EnvironmentError('InvalidConfiguration', '.gitspace/services.json ingress needs services with valid names and ports', { detail: parsed.error.message });
    return null;
  }
  const declaring = parsed.data.services.filter((service) => service.ingress !== undefined);
  if (new Set(declaring.map((service) => service.name)).size !== declaring.length) throw new EnvironmentError('InvalidConfiguration', '.gitspace/services.json repeats a service name');
  const groups = declaring
    .flatMap((service) => resolveServiceIngress({ name: service.name, ports: (service.ports ?? []).map((port) => ({ name: port.name, protocol: port.protocol ?? 'http' })) }, service.ingress))
    .sort((left, right) => left.service.localeCompare(right.service) || left.port.localeCompare(right.port));
  return groups.length ? JSON.stringify(groups, null, 2) : null;
}

export function parseServiceIngressContent(content: string): ServiceIngressGroup[] {
  const parsed = z.array(ServiceIngressGroupSchema).safeParse(JSON.parse(content));
  if (!parsed.success) throw new EnvironmentError('InvalidConfiguration', 'Ingress content is not canonical service ingress', { detail: parsed.error.message });
  return parsed.data;
}

/** An OIDC issuer or its keys: HTTPS on a public DNS name, never an IP literal, localhost, or a GitSpace host. */
export function ingressUrlAllowed(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/u, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !host.includes('.')) return false;
  if (host.startsWith('[') || /^\d+(?:\.\d+){3}$/u.test(host)) return false;
  return !['localhost', 'gssh.dev', 'gitspace.sh'].some((reserved) => host === reserved || host.endsWith(`.${reserved}`));
}

const base64urlSchema = z.string().min(1).max(1_024).regex(/^[A-Za-z0-9_-]+$/u);
const jwkCommon = { kid: z.string().min(1).max(256).optional(), use: z.literal('sig').optional() };
/** Public verification keys only: a private member (`d`, `p`, `k`…) fails the strict shape. */
export const IngressJwkSchema = z.discriminatedUnion('kty', [
  z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: base64urlSchema, alg: z.literal('EdDSA').optional(), ...jwkCommon }).strict(),
  z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: base64urlSchema, y: base64urlSchema, alg: z.literal('ES256').optional(), ...jwkCommon }).strict(),
  z.object({ kty: z.literal('RSA'), n: base64urlSchema, e: base64urlSchema, alg: z.literal('RS256').optional(), ...jwkCommon }).strict(),
]);
export const IngressJwksSchema = z.object({ keys: z.array(IngressJwkSchema).min(1).max(16) }).strict();
export type IngressJwks = z.infer<typeof IngressJwksSchema>;

const oidcIssuerSchema = z.string().max(2_048).refine(ingressUrlAllowed, { message: 'An OIDC issuer is an https URL on a public DNS name' });
const jwtIssuerSchema = z.string().min(1).max(2_048);
/** `sub` patterns; `*` matches any run of characters. */
const subjectsSchema = z.array(z.string().min(1).max(256)).min(1).max(32);
const secretNameSchema = z.string().max(128).regex(/^[A-Z][A-Z0-9_]*$/u);

/** One credential as a script writes it to `ingress.json`; a bearer names a project secret, never its value. */
export const IngressFileCredentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('oidc'), service: serviceNameSchema, port: portNameSchema.optional(), issuer: oidcIssuerSchema, subjects: subjectsSchema, forwardAuthorization: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('jwt'), service: serviceNameSchema, port: portNameSchema.optional(), issuer: jwtIssuerSchema, keys: IngressJwksSchema, subjects: subjectsSchema, forwardAuthorization: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('bearer'), service: serviceNameSchema, port: portNameSchema.optional(), secret: secretNameSchema }).strict(),
]);
export type IngressFileCredential = z.infer<typeof IngressFileCredentialSchema>;
export const IngressFileSchema = z.object({ credentials: z.array(IngressFileCredentialSchema).max(32) }).strict();
export type IngressFile = z.infer<typeof IngressFileSchema>;

export function parseIngressFile(source: string): IngressFile {
  if (source.length > INGRESS_FILE_LIMIT) throw new EnvironmentError('InvalidConfiguration', 'ingress.json exceeds 64 KiB');
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new EnvironmentError('InvalidConfiguration', 'ingress.json is not valid JSON'); }
  const parsed = IngressFileSchema.safeParse(value);
  if (!parsed.success) throw new EnvironmentError('InvalidConfiguration', 'ingress.json must be {credentials: [...]} of oidc, jwt or bearer credentials', { detail: parsed.error.message });
  return parsed.data;
}

/** A credential as the machine registers it: a bearer carries the SHA-256 of the secret, never the secret. */
export const HostedIngressCredentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('oidc'), issuer: oidcIssuerSchema, subjects: subjectsSchema, forwardAuthorization: z.boolean() }).strict(),
  z.object({ kind: z.literal('jwt'), issuer: jwtIssuerSchema, keys: IngressJwksSchema, subjects: subjectsSchema, forwardAuthorization: z.boolean() }).strict(),
  z.object({ kind: z.literal('bearer'), secret: secretNameSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
]);
export type HostedIngressCredential = z.infer<typeof HostedIngressCredentialSchema>;

/** `project.routes.ingress`: replaces a workspace's signed-caller registrations, one per workspace URL with declared routes. */
export const HostedIngressRegistrationSchema = z.object({
  projectId: z.string().min(1).max(160),
  workspaceId: z.string().min(1).max(160),
  /** This machine's running `cloud/provision` or `workspace/materialize` run that wrote `ingress.json`. */
  runId: z.string().min(1).max(160),
  /** The approved `ingress` execution content the routes come from. */
  ingress: z.string().max(131_072),
  registrations: z.array(z.object({
    hostname: z.string().min(1).max(253),
    service: serviceNameSchema,
    port: portNameSchema,
    credentials: z.array(HostedIngressCredentialSchema).max(32),
  }).strict()).max(256),
}).strict();
export type HostedIngressRegistration = z.infer<typeof HostedIngressRegistrationSchema>;
