import { useCallback, useEffect, useRef, useState } from 'react'

export interface ProcessSessionInfo {
  id: string
  workspaceId: string
  processName?: string
  processInstance?: number
  createdAt: number
  exitCode?: number
}

export interface ProcessActionParams {
  workspaceId: string
  processName: string
}

export interface ProcessStartAttachParams extends ProcessActionParams {
  instance?: number
}

export interface PendingProcessAttachTarget {
  workspaceId: string
  processName: string
  instance: number
}

export interface UseProcessActionsOptions {
  sessions: ProcessSessionInfo[]
  startProcess: (workspaceId: string, processName: string, instance?: number) => Promise<void>
  stopProcess: (workspaceId: string, processName: string) => Promise<void>
  attachSession: (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => Promise<void>
  onStartProcessError?: (error: unknown) => void
  onStopProcessError?: (error: unknown) => void
  onStartProcessAttachError?: (error: unknown) => void
  onAttachError?: (error: unknown) => void
  onAttachTimeout?: (target: PendingProcessAttachTarget) => void
  onStartProcessFinally?: () => void | Promise<void>
  onStopProcessFinally?: () => void | Promise<void>
  onStartProcessAttachFinally?: () => void | Promise<void>
  pendingAttachCancelSignal?: unknown
  attachTimeoutMs?: number
}

interface UseProcessActionsResult {
  handleStartProcess: (params: ProcessActionParams) => void
  handleStopProcess: (params: ProcessActionParams) => void
  handleStartProcessAttach: (params: ProcessStartAttachParams) => void
}

function matchesTarget(
  current: PendingProcessAttachTarget | null,
  target: PendingProcessAttachTarget
): boolean {
  return Boolean(
    current &&
      current.workspaceId === target.workspaceId &&
      current.processName === target.processName &&
      current.instance === target.instance
  )
}

export function useProcessActions(options: UseProcessActionsOptions): UseProcessActionsResult {
  const {
    sessions,
    startProcess,
    stopProcess,
    attachSession,
    onStartProcessError,
    onStopProcessError,
    onStartProcessAttachError,
    onAttachError,
    onAttachTimeout,
    onStartProcessFinally,
    onStopProcessFinally,
    onStartProcessAttachFinally,
    pendingAttachCancelSignal,
    attachTimeoutMs = 8000,
  } = options

  const [pendingProcessAttach, setPendingProcessAttach] =
    useState<PendingProcessAttachTarget | null>(null)
  const pendingProcessAttachRef = useRef<PendingProcessAttachTarget | null>(null)

  useEffect(() => {
    pendingProcessAttachRef.current = pendingProcessAttach
  }, [pendingProcessAttach])

  const runFinally = useCallback((fn?: () => void | Promise<void>) => {
    if (!fn) {
      return
    }
    void Promise.resolve(fn()).catch(() => {})
  }, [])

  const handleStartProcess = useCallback((params: ProcessActionParams) => {
    void Promise.resolve(startProcess(params.workspaceId, params.processName))
      .catch((error) => {
        onStartProcessError?.(error)
      })
      .finally(() => {
        runFinally(onStartProcessFinally)
      })
  }, [onStartProcessError, onStartProcessFinally, runFinally, startProcess])

  const handleStopProcess = useCallback((params: ProcessActionParams) => {
    void Promise.resolve(stopProcess(params.workspaceId, params.processName))
      .catch((error) => {
        onStopProcessError?.(error)
      })
      .finally(() => {
        runFinally(onStopProcessFinally)
      })
  }, [onStopProcessError, onStopProcessFinally, runFinally, stopProcess])

  const handleStartProcessAttach = useCallback((params: ProcessStartAttachParams) => {
    const target: PendingProcessAttachTarget = {
      workspaceId: params.workspaceId,
      processName: params.processName,
      instance: params.instance ?? 1,
    }

    setPendingProcessAttach(target)
    void Promise.resolve(startProcess(target.workspaceId, target.processName, target.instance))
      .catch((error) => {
        setPendingProcessAttach((current) =>
          matchesTarget(current, target) ? null : current
        )
        const errorHandler = onStartProcessAttachError ?? onStartProcessError
        errorHandler?.(error)
      })
      .finally(() => {
        runFinally(onStartProcessAttachFinally)
      })
  }, [
    onStartProcessAttachError,
    onStartProcessAttachFinally,
    onStartProcessError,
    runFinally,
    startProcess,
  ])

  useEffect(() => {
    if (!pendingProcessAttach) {
      return
    }

    const session = sessions
      .filter((item) =>
        item.workspaceId === pendingProcessAttach.workspaceId &&
        item.processName === pendingProcessAttach.processName &&
        (item.processInstance ?? 1) === pendingProcessAttach.instance &&
        item.exitCode === undefined
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0]

    if (!session) {
      return
    }

    const target = pendingProcessAttach
    setPendingProcessAttach((current) =>
      matchesTarget(current, target) ? null : current
    )

    void attachSession({ sessionId: session.id, viewOnly: true }).catch((error) => {
      onAttachError?.(error)
    })
  }, [attachSession, onAttachError, pendingProcessAttach, sessions])

  useEffect(() => {
    if (!pendingProcessAttach) {
      return
    }

    const target = pendingProcessAttach
    const timeout = setTimeout(() => {
      const current = pendingProcessAttachRef.current
      if (!matchesTarget(current, target)) {
        return
      }

      setPendingProcessAttach(null)
      onAttachTimeout?.(target)
    }, attachTimeoutMs)

    return () => clearTimeout(timeout)
  }, [attachTimeoutMs, onAttachTimeout, pendingProcessAttach])

  useEffect(() => {
    if (!pendingProcessAttach || !pendingAttachCancelSignal) {
      return
    }
    setPendingProcessAttach(null)
  }, [pendingAttachCancelSignal, pendingProcessAttach])

  return {
    handleStartProcess,
    handleStopProcess,
    handleStartProcessAttach,
  }
}
