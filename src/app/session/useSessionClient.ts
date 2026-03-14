import { useMemo } from 'react'
import type { UseRemoteSessionClientOptions, UseRemoteSessionClientReturn, RemoteSessionConnectionStatus } from '../../session/useRemoteSessionClient.js'
import { useRemoteSessionClient } from '../../session/useRemoteSessionClient.js'
import type { SessionClientConnectionStatus } from './types.js'

export interface UseSessionClientOptions<ConnectParams> {
  createBackend: UseRemoteSessionClientOptions<ConnectParams>['createBackend']
  mapConnectionStatus?: (
    status: RemoteSessionConnectionStatus
  ) => SessionClientConnectionStatus
}

export type UseSessionClientReturn<ConnectParams> = Omit<
  UseRemoteSessionClientReturn<ConnectParams>,
  'status'
> & {
  status: SessionClientConnectionStatus
}

function defaultStatusMapper(
  status: RemoteSessionConnectionStatus
): SessionClientConnectionStatus {
  return status
}

export function useSessionClient<ConnectParams>(
  options: UseSessionClientOptions<ConnectParams>
): UseSessionClientReturn<ConnectParams> {
  const { createBackend, mapConnectionStatus = defaultStatusMapper } = options
  const client = useRemoteSessionClient<ConnectParams>({ createBackend })

  return useMemo(() => ({
    ...client,
    status: mapConnectionStatus(client.status),
  }), [client, mapConnectionStatus])
}
