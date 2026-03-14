export interface SessionCommandKeyInput {
  key?: string | null
  name?: string | null
  raw?: string | null
  shift?: boolean
}

export type SessionUiCommand =
  | 'move-up'
  | 'move-down'
  | 'activate'
  | 'back'
  | 'new'
  | 'refresh'
  | 'help'
  | 'delete'
  | 'clear'
  | 'attach'
  | 'kill'
  | 'open-inbox'
  | 'bundle'
  | 'copy'
  | 'toggle-hidden'

function normalizeCommandKey(input: SessionCommandKeyInput): string | null {
  const key = input.key?.toLowerCase()
  if (key) {
    if (key === 'arrowup') return 'up'
    if (key === 'arrowdown') return 'down'
    if (key === 'enter') return 'return'
    if (key === 'escape') return 'escape'
    return key
  }

  const name = input.name?.toLowerCase()
  if (name === 'up' || name === 'down' || name === 'return' || name === 'escape') {
    return name
  }

  const raw = input.raw
  if (!raw) {
    return null
  }

  return raw.toLowerCase()
}

export function resolveMachineListCommand(input: SessionCommandKeyInput): SessionUiCommand | null {
  const key = normalizeCommandKey(input)
  if (!key) {
    return null
  }

  if (key === 'up' || key === 'k') return 'move-up'
  if (key === 'down' || key === 'j') return 'move-down'
  if (key === 'return') return 'activate'
  if (key === 'r') return 'refresh'
  if (key === 'c') return 'copy'
  if (key === '?') return 'help'
  return null
}

export function resolveInboxCommand(input: SessionCommandKeyInput): SessionUiCommand | null {
  const key = normalizeCommandKey(input)
  if (!key) {
    return null
  }

  if (key === 'up' || key === 'k') return 'move-up'
  if (key === 'down' || key === 'j') return 'move-down'
  if (key === 'return') return 'activate'
  if (key === 'escape' || key === 'q') return 'back'
  if (key === 'x') return 'delete'
  if (key === 'c') return 'clear'
  if (key === 'a') return 'attach'
  return null
}

export function resolveSessionBrowserCommand(input: SessionCommandKeyInput): SessionUiCommand | null {
  const key = normalizeCommandKey(input)
  if (!key) {
    return null
  }

  if (key === 'up' || key === 'k') return 'move-up'
  if (key === 'down' || key === 'j') return 'move-down'
  if (key === 'return') return 'activate'
  if (key === 'n') return 'new'
  if (key === 'r') return 'refresh'
  if (key === 'escape' || key === 'q') return 'back'
  if (key === '?') return 'help'
  if (key === 'x') return 'kill'
  if (key === 'd') return 'delete'
  if (key === 'h') return 'toggle-hidden'
  if (key === 'i') return 'open-inbox'
  if (key === 'b') return 'bundle'
  return null
}
