import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { Window } from 'happy-dom'
import type { MachineInfo } from '../../components/MachineList.js'
import type {
  RelaySocketAdapter,
  RelaySocketHandlers,
} from '../machine-directory-client.js'
import { useMachineDirectory } from '../useMachineDirectory.js'

const domWindow = new Window()
const originalWindow = globalThis.window
const originalDocument = globalThis.document

const OPEN = 1
const CLOSED = 3

interface FakeSocket {
  readyState: number
  handlers: RelaySocketHandlers | null
  sent: string[]
}

beforeAll(() => {
  // @ts-expect-error test DOM setup
  globalThis.window = domWindow
  // @ts-expect-error test DOM setup
  globalThis.document = domWindow.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
})

function createAdapter(holder: { socket: FakeSocket | null }): RelaySocketAdapter<FakeSocket> {
  return {
    createSocket: () => {
      const socket: FakeSocket = {
        readyState: OPEN,
        handlers: null,
        sent: [],
      }
      holder.socket = socket
      return socket
    },
    setHandlers: (socket, handlers) => {
      socket.handlers = handlers
      if (socket.readyState === OPEN) {
        queueMicrotask(() => {
          socket.handlers?.onOpen()
        })
      }
    },
    clearHandlers: (socket) => {
      socket.handlers = null
    },
    send: (socket, data) => {
      socket.sent.push(data)
    },
    close: (socket) => {
      socket.readyState = CLOSED
      socket.handlers?.onClose()
    },
    getReadyState: (socket) => socket.readyState,
    getOpenReadyStateValue: () => OPEN,
  }
}

describe('useMachineDirectory', () => {
  it('connects and maps machines using shared hook', async () => {
    const holder = { socket: null as FakeSocket | null }

    const { result } = renderHook(() =>
      useMachineDirectory<FakeSocket, { id: string }, { publicKey: string }>({
        socketAdapter: createAdapter(holder),
        mapMachines: (machines) => [
          {
            machineId: 'local',
            label: 'This Machine',
            online: true,
            isAuthorized: true,
          },
          ...machines,
        ],
        resolveClientConfig: async () => ({
          relayUrl: 'ws://localhost:4480/ws',
          clientIdentityId: 'client-1',
          deviceCertificate: 'test-device-cert',
          identity: { id: 'identity-1' },
          context: { publicKey: 'pubkey-1' },
          signer: (message) => ({ ...message, signature: { sig: 'x' } }),
        }),
      })
    )

    await act(async () => {
      await result.current.connect()
    })

    expect(result.current.status).toBe('connecting')
    expect(result.current.identity).toEqual({ id: 'identity-1' })
    expect(result.current.context).toEqual({ publicKey: 'pubkey-1' })

    const socket = holder.socket
    if (!socket || !socket.handlers) {
      throw new Error('Socket handlers missing after connect')
    }

    act(() => {
      socket.handlers?.onMessage(JSON.stringify({
        type: 'machine_list',
        machines: [
          {
            machineId: 'remote-1',
            label: 'Dev Box',
            online: true,
            isAuthorized: true,
            lastConnectedAt: 123,
          },
        ],
      }))
    })

    expect(result.current.status).toBe('connected')
    expect(result.current.machines).toEqual<MachineInfo[]>([
      {
        machineId: 'local',
        label: 'This Machine',
        online: true,
        isAuthorized: true,
      },
      {
        machineId: 'remote-1',
        label: 'Dev Box',
        online: true,
        isAuthorized: true,
        lastConnectedAt: 123,
      },
    ])

    act(() => {
      result.current.refreshMachines()
    })
    expect(socket.sent).toHaveLength(2)
    expect(JSON.parse(socket.sent[0]).type).toBe('list_machines')
    expect(JSON.parse(socket.sent[1]).type).toBe('list_machines')
  })

  it('reports resolver failures and transitions to error state', async () => {
    const holder = { socket: null as FakeSocket | null }
    const onError = mock<(error: Error) => void>(() => {})

    const { result } = renderHook(() =>
      useMachineDirectory<FakeSocket, { id: string }>({
        socketAdapter: createAdapter(holder),
        resolveClientConfig: async () => {
          throw new Error('missing identity')
        },
        onError,
      })
    )

    await act(async () => {
      await result.current.connect()
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('missing identity')
    expect(result.current.machines).toEqual([])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('missing identity')
  })

  it('surfaces relay list errors and clears them after a later machine list', async () => {
    const holder = { socket: null as FakeSocket | null }
    const onError = mock<(error: Error) => void>(() => {})

    const { result } = renderHook(() =>
      useMachineDirectory<FakeSocket, { id: string }>({
        socketAdapter: createAdapter(holder),
        resolveClientConfig: async () => ({
          relayUrl: 'ws://localhost:4480/ws',
          clientIdentityId: 'client-2',
          deviceCertificate: 'test-device-cert',
          identity: { id: 'identity-2' },
        }),
        onError,
      })
    )

    await act(async () => {
      await result.current.connect()
    })

    const socket = holder.socket
    if (!socket || !socket.handlers) {
      throw new Error('Socket handlers missing after connect')
    }

    act(() => {
      socket.handlers?.onMessage(JSON.stringify({
        type: 'error',
        message: 'Identity mismatch',
      }))
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('Identity mismatch')
    expect(result.current.machines).toEqual([])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe('Identity mismatch')

    act(() => {
      socket.handlers?.onMessage(JSON.stringify({
        type: 'machine_list',
        machines: [
          {
            machineId: 'remote-2',
            label: 'Recovered Box',
            online: true,
            isAuthorized: true,
          },
        ],
      }))
    })

    expect(result.current.status).toBe('connected')
    expect(result.current.error).toBeNull()
    expect(result.current.machines).toEqual<MachineInfo[]>([
      {
        machineId: 'remote-2',
        label: 'Recovered Box',
        online: true,
        isAuthorized: true,
      },
    ])
  })
})
