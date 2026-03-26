import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProcessHostname } from '../../../utils/hostnames.js';

let hostingState: { baseHost?: string; machineName?: string; enabled: boolean; updatedAt: number } | null = null;

mock.module('./state.js', () => ({
  readTmuxHostingState: mock(() => hostingState),
}));

const { resolveHostedServiceUrl } = await import('./routes.js');

let gitspaceDir: string | null = null;
const originalHome = process.env.HOME;

beforeEach(() => {
  hostingState = null;
});

afterEach(() => {
  if (gitspaceDir) {
    rmSync(gitspaceDir, { recursive: true, force: true });
    gitspaceDir = null;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

function configureHostingSandbox(): string {
  gitspaceDir = mkdtempSync(join(tmpdir(), 'gitspace-hosted-routes-'));
  process.env.HOME = gitspaceDir;
  const spacesDir = join(gitspaceDir, 'gitspace');
  const runtimeDir = join(spacesDir, '.tmux-hosting');
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(spacesDir, 'host.json'), JSON.stringify({
    subdomain: 'brad',
    subdomains: ['brad'],
    serveNamespaces: {
      brad: { domain: 'gitspace.sh' },
    },
    createdAt: Date.now(),
  }, null, 2), 'utf-8');
  return runtimeDir;
}

describe('active hosted route resolver', () => {
  it('returns only currently active hosted urls', () => {
    const runtimeDir = configureHostingSandbox();
    const activeHostname = buildProcessHostname('gitspace.sh', 'brad', 'demo', 'sam', 1, '7777', 'macbook');
    writeFileSync(
      join(runtimeDir, 'hosted-routes.json'),
      `${JSON.stringify([{ hostname: activeHostname, service: 'http://127.0.0.1:7777' }], null, 2)}\n`,
      'utf-8',
    );

    expect(resolveHostedServiceUrl({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      workspaceId: 'demo',
      processName: 'sam',
      instance: 1,
      portLabel: '7777',
      protocol: 'http',
    })).toBe(`http://${activeHostname}`);

    expect(resolveHostedServiceUrl({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      workspaceId: 'demo',
      processName: 'web',
      instance: 1,
      portLabel: 'app',
      protocol: 'http',
    })).toBeUndefined();
  });

  it('falls back to persisted machine name when caller omits it', () => {
    const runtimeDir = configureHostingSandbox();
    hostingState = {
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: Date.now(),
    };
    const activeHostname = buildProcessHostname('gitspace.sh', 'brad', 'demo', 'sam', 1, '7777', 'macbook');
    writeFileSync(
      join(runtimeDir, 'hosted-routes.json'),
      `${JSON.stringify([{ hostname: activeHostname, service: 'http://127.0.0.1:7777' }], null, 2)}\n`,
      'utf-8',
    );

    expect(resolveHostedServiceUrl({
      baseHost: 'brad.gitspace.sh',
      workspaceId: 'demo',
      processName: 'sam',
      instance: 1,
      portLabel: '7777',
      protocol: 'http',
    })).toBe(`http://${activeHostname}`);
  });

  it('matches active routes when callers pass backend-scoped workspace ids', () => {
    const runtimeDir = configureHostingSandbox();
    hostingState = {
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: Date.now(),
    };
    const activeHostname = buildProcessHostname('gitspace.sh', 'brad', 'ws-1', 'sample-server', 1, 'web', 'macbook');
    writeFileSync(
      join(runtimeDir, 'hosted-routes.json'),
      `${JSON.stringify([{ hostname: activeHostname, service: 'http://127.0.0.1:7777' }], null, 2)}\n`,
      'utf-8',
    );

    expect(resolveHostedServiceUrl({
      baseHost: 'brad.gitspace.sh',
      workspaceId: 'acme:ws-1',
      processName: 'sample-server',
      instance: 1,
      portLabel: 'web',
      protocol: 'http',
    })).toBe(`http://${activeHostname}`);
  });

  it('never returns remote urls for tcp services', () => {
    expect(resolveHostedServiceUrl({
      baseHost: 'brad.gitspace.sh',
      workspaceId: 'demo',
      processName: 'db',
      instance: 1,
      portLabel: '5432',
      protocol: 'tcp',
    })).toBeUndefined();
  });
});
