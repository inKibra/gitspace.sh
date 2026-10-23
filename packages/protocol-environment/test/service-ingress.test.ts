import { describe, expect, it } from 'bun:test';
import {
  HostedIngressCredentialSchema, IngressJwksSchema, ServiceIngressPathSchema, deriveLifecycleExecutions, ingressUrlAllowed, loadEnvironmentBundle,
  parseIngressFile, serviceIngressContent, serviceIngressMatches,
} from '../src/index.js';

const services = (ingress: unknown[], ports: unknown[] = [{ name: 'http' }, { name: 'admin' }, { name: 'db', protocol: 'tcp' }]) => JSON.stringify({ services: [{ name: 'api', command: 'bun', ports, ingress }] });
const derive = (source: string | null) => deriveLifecycleExecutions({
  bundle: loadEnvironmentBundle({ version: 1, profiles: { base: {} } }), selectedProfile: 'base',
  list: async () => [], read: async () => { throw new Error('no scripts'); }, services: async () => source,
});

describe('signed-caller routes', () => {
  it('accepts exact paths and trailing prefixes only', () => {
    for (const path of ['/', '/webhooks/stripe', '/webhooks/', '/webhooks/*', '/*', '/a:b/@c']) expect(ServiceIngressPathSchema.safeParse(path).success).toBe(true);
    for (const path of ['webhooks', '/a/../b', '/a/./b', '/a//b', '/a*', '/a/*/b', '/*/b', '/a?b', '/a#b', '/a b', '/__gitspace/auth', '/__gitspace']) expect(ServiceIngressPathSchema.safeParse(path).success).toBe(false);
  });

  it('matches exact paths, prefixes below their slash, the method, and never GitSpace paths', () => {
    const routes = [{ method: 'POST' as const, path: '/webhooks/*' }, { method: 'GET' as const, path: '/health' }, { method: '*' as const, path: '/rpc' }];
    expect(serviceIngressMatches(routes, 'POST', '/webhooks/stripe')).toBe(true);
    expect(serviceIngressMatches(routes, 'POST', '/webhooks/')).toBe(true);
    expect(serviceIngressMatches(routes, 'POST', '/webhooks')).toBe(false);
    expect(serviceIngressMatches(routes, 'POST', '/webhooksx')).toBe(false);
    expect(serviceIngressMatches(routes, 'GET', '/webhooks/stripe')).toBe(false);
    expect(serviceIngressMatches(routes, 'GET', '/health')).toBe(true);
    expect(serviceIngressMatches(routes, 'GET', '/health/')).toBe(false);
    expect(serviceIngressMatches(routes, 'HEAD', '/health')).toBe(false);
    expect(serviceIngressMatches(routes, 'DELETE', '/rpc')).toBe(true);
    expect(serviceIngressMatches([{ method: '*', path: '/*' }], 'GET', '/__gitspace/auth')).toBe(false);
  });

  it('approves one canonical content: reordering keeps the hash, any route change needs a new approval', async () => {
    const declared = [{ method: 'POST', path: '/webhooks/*' }, { method: 'GET', path: '/status', port: 'admin' }, { method: 'POST', path: '/events', port: 'http' }];
    const [first] = await derive(services(declared));
    const [reordered] = await derive(services(declared.toReversed()));
    expect(first).toMatchObject({ id: 'ingress', kind: 'ingress', phase: null });
    expect(reordered?.hash).toBe(first?.hash);
    expect(JSON.parse(first?.content ?? '')).toEqual([
      { service: 'api', port: 'admin', routes: [{ method: 'GET', path: '/status' }] },
      { service: 'api', port: 'http', routes: [{ method: 'POST', path: '/events' }, { method: 'POST', path: '/webhooks/*' }] },
    ]);
    const [changed] = await derive(services([...declared, { method: 'PUT', path: '/events' }]));
    expect(changed?.hash).not.toBe(first?.hash);
    expect(await derive(JSON.stringify({ services: [{ name: 'api', command: 'bun', ports: [{ name: 'http' }] }] }))).toEqual([]);
    expect(await derive(null)).toEqual([]);
  });

  it('refuses routes on tcp or missing ports, unknown fields, and more than 64 routes', () => {
    expect(() => serviceIngressContent(services([{ method: 'GET', path: '/', port: 'db' }]))).toThrow('http port');
    expect(() => serviceIngressContent(services([{ method: 'GET', path: '/' }], [{ name: 'db', protocol: 'tcp' }]))).toThrow('http port');
    expect(() => serviceIngressContent(services([{ method: 'GET', path: '/', auth: 'none' }]))).toThrow();
    expect(() => serviceIngressContent(services([{ method: 'TRACE', path: '/' }]))).toThrow();
    expect(() => serviceIngressContent(services(Array.from({ length: 65 }, (_, index) => ({ method: 'GET', path: `/r${index}` }))))).toThrow('64');
  });

  it('fetches issuers and keys only over https from public DNS names outside GitSpace', () => {
    for (const url of ['https://issuer.example.com', 'https://login.example.co.uk/tenant/v2.0']) expect(ingressUrlAllowed(url)).toBe(true);
    for (const url of ['http://issuer.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://a.localhost', 'https://intranet', 'https://broker.gssh.dev', 'https://gitspace.sh', 'https://x.gitspace.sh.', 'https://user:pw@issuer.example.com', 'not a url']) expect(ingressUrlAllowed(url)).toBe(false);
  });

  it('keeps private key material and bearer secrets out of registrations', () => {
    const publicKey = { kty: 'OKP', crv: 'Ed25519', x: 'q3SgAZm1AKoQpo3VSJSTzQi7sGBDfIrZYfCtrxuIc8M', kid: 'k1' };
    expect(IngressJwksSchema.safeParse({ keys: [publicKey] }).success).toBe(true);
    expect(IngressJwksSchema.safeParse({ keys: [{ ...publicKey, d: 'private' }] }).success).toBe(false);
    expect(IngressJwksSchema.safeParse({ keys: [{ kty: 'oct', k: 'c2VjcmV0' }] }).success).toBe(false);
    expect(parseIngressFile(JSON.stringify({ credentials: [{ kind: 'bearer', service: 'api', secret: 'WEBHOOK_TOKEN' }] })).credentials).toHaveLength(1);
    expect(() => parseIngressFile(JSON.stringify({ credentials: [{ kind: 'bearer', service: 'api', secret: 'WEBHOOK_TOKEN', value: 'plain' }] }))).toThrow();
    expect(HostedIngressCredentialSchema.safeParse({ kind: 'bearer', secret: 'WEBHOOK_TOKEN', sha256: 'plain-token' }).success).toBe(false);
  });
});
