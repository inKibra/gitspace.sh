import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalFetch = globalThis.fetch;

function buildConfigResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    github_client_id: 'client-id',
    version: '1.0.0',
    apiVersion: 1,
    subdomainsSchemaVersion: 2,
    ...overrides,
  };
}

describe('host sync', () => {
  let spacesDir: string;
  let secrets = new Map<string, string>();

  beforeEach(async () => {
    spacesDir = mkdtempSync(join(tmpdir(), 'gitspace-host-test-'));
    mkdirSync(spacesDir, { recursive: true });
    secrets = new Map([['GITSPACE_TOKEN', 'gitspace-token']]);

    const realSecrets = await import('../../utils/secrets.js');
    const realConfig = await import('../../core/config.js');
    const realIdentity = await import('../../core/identity.js');

    mock.module('../../utils/secrets.js', () => ({
      ...realSecrets,
      getSecret: mock(async (key: string) => secrets.get(key) ?? null),
      setSecret: mock(async (key: string, value: string) => {
        secrets.set(key, value);
      }),
      deleteSecret: mock(async (key: string) => {
        secrets.delete(key);
        return true;
      }),
    }));

    mock.module('../../core/config.js', () => ({
      ...realConfig,
      getSpacesDir: mock(() => spacesDir),
    }));

    mock.module('../../core/identity.js', () => ({
      ...realIdentity,
      getPublicKeyWithoutPassword: mock(() => ({ signingPublicKey: 'device-fingerprint' })),
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
    rmSync(spacesDir, { recursive: true, force: true });
  });

  test('syncHostConfig stores explicit serve companion metadata and credentials', async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.endsWith('/config')) {
        return Response.json(buildConfigResponse());
      }
      if (url.endsWith('/subdomains')) {
        return Response.json([
          {
            id: 'sub-1',
            subdomain: 'brad',
            status: 'active',
            is_primary: 1,
            created_at: 123,
            updated_at: 123,
            serveSubdomain: 'brad.serve',
            serveStatus: 'active',
          },
        ]);
      }
      if (url.endsWith('/subdomains/brad/token')) {
        return Response.json({ tunnelToken: 'primary-token' });
      }
      if (url.endsWith('/subdomains/brad.serve/token')) {
        return Response.json({ tunnelToken: 'serve-token' });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { readHostConfig, syncHostConfig } = await import(`../host.js?test=${Date.now()}`);
    const report = await syncHostConfig(false);

    expect(report.ready).toBe(true);
    expect(report.primarySubdomain).toBe('brad');
    expect(report.serveSubdomain).toBe('brad.serve');
    expect(report.warnings).toEqual([]);
    expect(report.tunnelToken.status).toBe('configured');
    expect(report.serveTunnelToken.status).toBe('configured');
    expect(readHostConfig()).toEqual({
      subdomain: 'brad',
      serveSubdomain: 'brad.serve',
      subdomains: ['brad'],
      createdAt: 123,
    });
    expect(secrets.get('TUNNEL_TOKEN_brad')).toBe('primary-token');
    expect(secrets.get('TUNNEL_TOKEN_brad_serve')).toBe('serve-token');
  });

  test('syncHostConfig refuses to guess when multiple active subdomains lack a primary', async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.endsWith('/config')) {
        return Response.json(buildConfigResponse());
      }
      if (url.endsWith('/subdomains')) {
        return Response.json([
          {
            id: 'sub-1',
            subdomain: 'brad',
            status: 'active',
            is_primary: 0,
            created_at: 123,
            updated_at: 123,
            serveSubdomain: 'brad.serve',
            serveStatus: 'active',
          },
          {
            id: 'sub-2',
            subdomain: 'alice',
            status: 'active',
            is_primary: 0,
            created_at: 124,
            updated_at: 124,
            serveSubdomain: 'alice.serve',
            serveStatus: 'active',
          },
        ]);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { readHostConfig, syncHostConfig } = await import(`../host.js?test=${Date.now()}`);
    const report = await syncHostConfig(false);

    expect(report.ready).toBe(false);
    expect(report.primarySubdomain).toBeNull();
    expect(report.subdomain.status).toBe('missing');
    expect(report.subdomain.fix).toBe('gssh user host set-primary <name>');
    expect(report.warnings).toContain('Host config was not updated because no primary subdomain is set.');
    expect(readHostConfig()).toBeNull();
  });

  test('syncHostConfig warns instead of claiming serve readiness when worker metadata is incompatible', async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.endsWith('/config')) {
        return Response.json(buildConfigResponse({ apiVersion: undefined, subdomainsSchemaVersion: undefined }));
      }
      if (url.endsWith('/subdomains')) {
        return Response.json([
          {
            id: 'sub-1',
            subdomain: 'brad',
            status: 'active',
            is_primary: 1,
            created_at: 123,
            updated_at: 123,
          },
        ]);
      }
      if (url.endsWith('/subdomains/brad/token')) {
        return Response.json({ tunnelToken: 'primary-token' });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { syncHostConfig } = await import(`../host.js?test=${Date.now()}`);
    const report = await syncHostConfig(false);

    expect(report.ready).toBe(false);
    expect(report.primarySubdomain).toBe('brad');
    expect(report.serveSubdomain).toBeNull();
    expect(report.tunnelToken.status).toBe('configured');
    expect(report.serveTunnelToken.status).toBe('error');
    expect(report.warnings).toEqual([
      'gitspace.sh API compatibility metadata missing from worker 1.0.0. Hosted status may be incomplete until the worker is updated.',
      'gitspace.sh subdomain schema metadata missing from worker 1.0.0. Serve readiness cannot be verified safely.',
    ]);
  });
});
