import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { Window } from 'happy-dom';
import type { SessionBackend, BackendDescriptor } from '../../../session/backend.js';
import { buildRemoteBackendKey } from '../../../session/backend-key.js';
import type { MachineInfo } from '../../../components/MachineList.js';
import type { RelaySigner } from '../../../relay-client/machine-directory-client.js';

const domWindow = new Window();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

beforeAll(() => {
  // @ts-expect-error test DOM setup
  globalThis.window = domWindow;
  // @ts-expect-error test DOM setup
  globalThis.document = domWindow.document;
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

let machineListHandler: ((machines: MachineInfo[]) => void) | null = null;

mock.module('../../../relay-client/machine-directory-client.js', () => ({
  RelayMachineDirectoryClient: class MockRelayMachineDirectoryClient {
    constructor(options: { onMachineList?: (machines: MachineInfo[]) => void }) {
      machineListHandler = options.onMachineList ?? null;
    }
    connect(): Promise<void> {
      return Promise.resolve();
    }
    disconnect(): void {}
    refreshMachines(): void {}
    getSocket(): null {
      return null;
    }
  },
}));

const { useMultiBackends, LOCAL_BACKEND_KEY } = await import('../useMultiBackends.js');

function makeBackend(descriptor: BackendDescriptor): SessionBackend {
  return {
    descriptor,
    connect: async () => {},
    disconnect: async () => {},
    listProjects: async () => {},
    listGithubRepos: async () => [],
    listRemoteBranches: async () => [],
    listLinearIssues: async () => [],
    listWorkspaces: async () => {},
    listSessions: async () => {},
    createProject: async () => {},
    createWorkspace: async () => {},
    deleteProject: async () => {},
    attachSession: async () => {},
    detachSession: async () => {},
    killSession: async () => {},
    deleteWorkspace: async () => {},
    onEvent: (_handler: unknown) => () => {},
  } as unknown as SessionBackend;
}

const passthroughRelaySigner: RelaySigner = <T extends object>(message: T) => message;

describe('useMultiBackends machine dedupe', () => {
  beforeEach(() => {
    machineListHandler = null;
  });

  it('does not register a remote backend for the same machine as local', async () => {
    const localBackend = makeBackend({
      key: LOCAL_BACKEND_KEY,
      kind: 'local',
      label: 'Local',
      machineId: 'machine-local',
    });

    const createRemoteBackend = mock(({ relayUrl, machineId }: { relayUrl: string; machineId: string }) => {
      const backendKey = buildRemoteBackendKey(relayUrl, machineId);
      return {
        backendKey,
        backend: makeBackend({
          key: backendKey,
          kind: 'remote',
          label: machineId,
          machineId,
          relayUrl,
        }),
      };
    });

    const { result, unmount } = renderHook(() =>
      useMultiBackends({
        enabled: true,
        relay: { url: 'wss://relay.example/ws' },
        identity: { id: 'client-1' } as any,
        createLocalBackend: () => localBackend,
        createRemoteBackend,
        relaySocketAdapter: {} as any,
        createRelaySigner: () => passthroughRelaySigner,
        getDeviceCertificate: async () => 'device-cert',
      })
    );

    await act(async () => {});
    expect(machineListHandler).toBeTruthy();

    await act(async () => {
      machineListHandler?.([
        {
          machineId: 'machine-local',
          label: 'This machine over relay',
          online: true,
          isAuthorized: true,
        },
      ]);
    });

    expect(createRemoteBackend).not.toHaveBeenCalled();
    expect(result.current.state.backendOrder).toEqual([LOCAL_BACKEND_KEY]);
    unmount();
  });

  it('still registers remote backends for different machines', async () => {
    const localBackend = makeBackend({
      key: LOCAL_BACKEND_KEY,
      kind: 'local',
      label: 'Local',
      machineId: 'machine-local',
    });

    const createRemoteBackend = mock(({ relayUrl, machineId }: { relayUrl: string; machineId: string }) => {
      const backendKey = buildRemoteBackendKey(relayUrl, machineId);
      return {
        backendKey,
        backend: makeBackend({
          key: backendKey,
          kind: 'remote',
          label: machineId,
          machineId,
          relayUrl,
        }),
      };
    });

    const { result, unmount } = renderHook(() =>
      useMultiBackends({
        enabled: true,
        relay: { url: 'wss://relay.example/ws' },
        identity: { id: 'client-1' } as any,
        createLocalBackend: () => localBackend,
        createRemoteBackend,
        relaySocketAdapter: {} as any,
        createRelaySigner: () => passthroughRelaySigner,
        getDeviceCertificate: async () => 'device-cert',
      })
    );

    await act(async () => {});
    expect(machineListHandler).toBeTruthy();

    await act(async () => {
      machineListHandler?.([
        {
          machineId: 'machine-local',
          label: 'This machine over relay',
          online: true,
          isAuthorized: true,
        },
        {
          machineId: 'machine-remote',
          label: 'Remote devbox',
          online: true,
          isAuthorized: true,
        },
      ]);
    });

    expect(createRemoteBackend).toHaveBeenCalledTimes(1);
    expect(createRemoteBackend).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-remote' }));
    expect(result.current.state.backendOrder).toEqual([
      LOCAL_BACKEND_KEY,
      buildRemoteBackendKey('wss://relay.example/ws', 'machine-remote'),
    ]);
    unmount();
  });
});
