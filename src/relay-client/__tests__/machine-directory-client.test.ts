import { describe, it, expect } from 'bun:test';
import {
  RelayMachineDirectoryClient,
  type RelaySocketAdapter,
  type RelaySocketHandlers,
} from '../machine-directory-client';

interface FakeSocket {
  readyState: number;
  sent: string[];
  handlers: RelaySocketHandlers | null;
}

const OPEN = 1;
const CLOSED = 3;

function createFakeAdapter(holder: { socket: FakeSocket | null }): RelaySocketAdapter<FakeSocket> {
  return {
    createSocket: (_url: string) => {
      const socket: FakeSocket = {
        readyState: 0,
        sent: [],
        handlers: null,
      };
      holder.socket = socket;
      return socket;
    },
    setHandlers: (socket, handlers) => {
      socket.handlers = handlers;
    },
    clearHandlers: (socket) => {
      socket.handlers = null;
    },
    send: (socket, data) => {
      socket.sent.push(data);
    },
    close: (socket) => {
      socket.readyState = CLOSED;
      socket.handlers?.onClose();
    },
    getReadyState: (socket) => socket.readyState,
    getOpenReadyStateValue: () => OPEN,
  };
}

describe('RelayMachineDirectoryClient', () => {
  it('requests machine list on connect and normalizes machine data', async () => {
    const holder = { socket: null as FakeSocket | null };
    const statuses: string[] = [];
    const errors: string[] = [];
    const machineLists: unknown[] = [];

    const client = new RelayMachineDirectoryClient<FakeSocket>({
      relayUrl: 'ws://localhost:4480/ws',
      clientIdentityId: 'client-1',
      deviceCertificate: 'test-device-cert',
      socketAdapter: createFakeAdapter(holder),
      signer: (msg) => ({ ...msg, signature: { sig: 'x', pub: 'y', ts: 123 } }),
      onStatusChange: (status) => statuses.push(status),
      onError: (message) => errors.push(message),
      onMachineList: (machines) => machineLists.push(machines),
    });

    const connectPromise = client.connect();
    const socket = holder.socket!;
    socket.readyState = OPEN;
    socket.handlers!.onOpen();
    await connectPromise;

    expect(statuses).toEqual(['connecting', 'connected']);
    expect(socket.sent).toHaveLength(1);

    const outbound = JSON.parse(socket.sent[0]);
    expect(outbound.type).toBe('list_machines');
    expect(outbound.clientIdentityId).toBe('client-1');
    expect(outbound.signature).toBeDefined();

    socket.handlers!.onMessage(JSON.stringify({
      type: 'machine_list',
      machines: [
        {
          machineId: 'machine-a',
          label: 'Dev Box',
          online: true,
          isAuthorized: true,
          lastConnectedAt: 100,
        },
      ],
    }));

    expect(machineLists).toHaveLength(1);
    expect(client.getMachines()).toEqual([
      {
        machineId: 'machine-a',
        label: 'Dev Box',
        online: true,
        isAuthorized: true,
        lastConnectedAt: 100,
      },
    ]);

    expect(errors).toEqual([]);
  });

  it('refreshMachines sends another list_machines request', async () => {
    const holder = { socket: null as FakeSocket | null };

    const client = new RelayMachineDirectoryClient<FakeSocket>({
      relayUrl: 'ws://localhost:4480/ws',
      clientIdentityId: 'client-2',
      deviceCertificate: 'test-device-cert',
      socketAdapter: createFakeAdapter(holder),
    });

    const connectPromise = client.connect();
    const socket = holder.socket!;
    socket.readyState = OPEN;
    socket.handlers!.onOpen();
    await connectPromise;

    expect(socket.sent).toHaveLength(1);
    client.refreshMachines();
    expect(socket.sent).toHaveLength(2);

    expect(JSON.parse(socket.sent[1]).type).toBe('list_machines');
  });

  it('disconnect clears machine list and transitions to disconnected', async () => {
    const holder = { socket: null as FakeSocket | null };
    const statuses: string[] = [];
    const machineLists: unknown[] = [];

    const client = new RelayMachineDirectoryClient<FakeSocket>({
      relayUrl: 'ws://localhost:4480/ws',
      clientIdentityId: 'client-3',
      deviceCertificate: 'test-device-cert',
      socketAdapter: createFakeAdapter(holder),
      onStatusChange: (status) => statuses.push(status),
      onMachineList: (machines) => machineLists.push(machines),
    });

    const connectPromise = client.connect();
    const socket = holder.socket!;
    socket.readyState = OPEN;
    socket.handlers!.onOpen();
    await connectPromise;

    client.disconnect();

    expect(client.getStatus()).toBe('disconnected');
    expect(client.getMachines()).toEqual([]);
    expect(machineLists[machineLists.length - 1]).toEqual([]);
    expect(statuses[statuses.length - 1]).toBe('disconnected');
  });
});
