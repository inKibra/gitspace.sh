import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useWorkspaceDetailModel } from './useWorkspaceDetailModel.js';
import type { WorkspaceInfo } from '../../../components/SpacesBrowser.js';
import { buildProcessHostname } from '../../../utils/hostnames.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

const originalHome = process.env.HOME;
const originalSessionDir = process.env.TMUX_LITE_SESSION_DIR;
let tempHomeDir: string | null = null;
function makeWorkspace(): WorkspaceInfo {
  return {
    id: 'ws-1',
    name: 'feature-1',
    path: '/tmp/acme/feature-1',
    projectName: 'acme',
    sessionCount: 0,
    processes: [],
  };
}


afterEach(() => {
  if (tempHomeDir) {
    rmSync(tempHomeDir, { recursive: true, force: true });
    tempHomeDir = null;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalSessionDir === undefined) {
    delete process.env.TMUX_LITE_SESSION_DIR;
  } else {
    process.env.TMUX_LITE_SESSION_DIR = originalSessionDir;
  }
});

describe('useWorkspaceDetailModel commit action', () => {
  it('includes a commit footer action and routes it to the workspace callback', async () => {
    const onLaunchCommit = mock(async () => undefined);

    const { result } = renderHook(() => useWorkspaceDetailModel({
      workspace: makeWorkspace(),
      sessions: [],
      replays: [],
      actions: { onLaunchCommit },
    }));

    expect(result.current.footerActions.some((action) => action.id === 'launch-commit')).toBe(true);

    await act(async () => {
      await result.current.actions.footerAction('launch-commit');
    });

    expect(onLaunchCommit).toHaveBeenCalledTimes(1);
    expect(onLaunchCommit).toHaveBeenCalledWith('ws-1');
  });
});

describe('useWorkspaceDetailModel active hosted urls', () => {
  it('ignores stale hosted routes when the process is not running', () => {
    tempHomeDir = mkdtempSync(join(tmpdir(), 'workspace-detail-hosted-'));
    process.env.HOME = tempHomeDir;
    process.env.TMUX_LITE_SESSION_DIR = tempHomeDir;
    const runtimeDir = join(tempHomeDir, 'gitspace', '.tmux-hosting');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(tempHomeDir, '.gitspace-hosting.json'), `${JSON.stringify({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: Date.now(),
    }, null, 2)}\n`, 'utf-8');
    writeFileSync(join(tempHomeDir, 'gitspace', 'host.json'), JSON.stringify({
      subdomain: 'brad',
      subdomains: ['brad'],
      serveNamespaces: {
        brad: { domain: 'gitspace.sh' },
      },
      createdAt: Date.now(),
    }, null, 2), 'utf-8');
    const activeHostname = buildProcessHostname('gitspace.sh', 'brad', 'ws-1', 'sample-server', 1, 'web', 'macbook');
    writeFileSync(
      join(runtimeDir, 'hosted-routes.json'),
      `${JSON.stringify([{ hostname: activeHostname, service: 'http://127.0.0.1:7777' }], null, 2)}\n`,
      'utf-8',
    );

    const { result } = renderHook(() => useWorkspaceDetailModel({
      workspace: {
        ...makeWorkspace(),
        serveDomain: 'brad.gitspace.sh',
        processes: [{ name: 'sample-server', instances: 1, ports: [{ instance: 1, port: 7777, name: 'web', protocol: 'http' }] }],
      },
      sessions: [{
        id: 'sess-1',
        name: 'proc:ws-1:sample-server:1',
        workspaceId: 'ws-1',
        attached: false,
        createdAt: Date.now(),
        processName: 'sample-server',
        processInstance: 1,
        exitCode: 0,
      }],
      replays: [],
      actions: {},
    }));

    expect(result.current.serviceRows[0]).toMatchObject({
      localUrl: 'localhost:7777',
      hostedUrl: undefined,
      portLabel: 'localhost:7777',
      state: 'stopped',
    });
  });

  it('shows the current hosted url when the process is running', () => {
    tempHomeDir = mkdtempSync(join(tmpdir(), 'workspace-detail-hosted-'));
    process.env.HOME = tempHomeDir;
    process.env.TMUX_LITE_SESSION_DIR = tempHomeDir;
    const runtimeDir = join(tempHomeDir, 'gitspace', '.tmux-hosting');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(tempHomeDir, '.gitspace-hosting.json'), `${JSON.stringify({
      baseHost: 'brad.gitspace.sh',
      machineName: 'macbook',
      enabled: true,
      updatedAt: Date.now(),
    }, null, 2)}\n`, 'utf-8');
    writeFileSync(join(tempHomeDir, 'gitspace', 'host.json'), JSON.stringify({
      subdomain: 'brad',
      subdomains: ['brad'],
      serveNamespaces: {
        brad: { domain: 'gitspace.sh' },
      },
      createdAt: Date.now(),
    }, null, 2), 'utf-8');
    const activeHostname = buildProcessHostname('gitspace.sh', 'brad', 'ws-1', 'sample-server', 1, 'web', 'macbook');
    writeFileSync(
      join(runtimeDir, 'hosted-routes.json'),
      `${JSON.stringify([{ hostname: activeHostname, service: 'http://127.0.0.1:7777' }], null, 2)}\n`,
      'utf-8',
    );

    const { result } = renderHook(() => useWorkspaceDetailModel({
      workspace: {
        ...makeWorkspace(),
        serveDomain: 'brad.gitspace.sh',
        processes: [{ name: 'sample-server', instances: 1, ports: [{ instance: 1, port: 7777, name: 'web', protocol: 'http' }] }],
      },
      sessions: [{
        id: 'sess-1',
        name: 'proc:ws-1:sample-server:1',
        workspaceId: 'ws-1',
        attached: false,
        createdAt: Date.now(),
        processName: 'sample-server',
        processInstance: 1,
      }],
      replays: [],
      actions: {},
    }));

    expect(result.current.serviceRows[0]).toMatchObject({
      localUrl: 'localhost:7777',
      hostedUrl: `http://${activeHostname}`,
      portLabel: activeHostname,
      state: 'running',
      attachableSessionId: 'sess-1',
    });
  });
});

describe('useWorkspaceDetailModel footer ordering', () => {
  it('keeps review and config actions in the expected order', () => {
    const { result } = renderHook(() => useWorkspaceDetailModel({
      workspace: makeWorkspace(),
      sessions: [],
      replays: [],
      actions: {},
    }));

    expect(result.current.footerActions.map((action) => action.id)).toEqual([
      'open-review',
      'launch-commit',
      'edit-bundle-config',
      'edit-process-config',
      'change-status',
    ]);
  });
});
