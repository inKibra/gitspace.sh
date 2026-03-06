import { describe, expect, it } from 'bun:test'
import {
  resolveInboxCommand,
  resolveMachineListCommand,
  resolveSessionBrowserCommand,
} from '../sessionCommands.js'

describe('sessionCommands', () => {
  it('resolves machine list commands for web and tui inputs', () => {
    expect(resolveMachineListCommand({ key: 'ArrowUp' })).toBe('move-up')
    expect(resolveMachineListCommand({ name: 'down' })).toBe('move-down')
    expect(resolveMachineListCommand({ key: 'Enter' })).toBe('activate')
    expect(resolveMachineListCommand({ raw: 'r' })).toBe('refresh')
    expect(resolveMachineListCommand({ key: 'c' })).toBe('copy')
    expect(resolveMachineListCommand({ key: '?' })).toBe('help')
  })

  it('resolves inbox commands for web and tui inputs', () => {
    expect(resolveInboxCommand({ key: 'ArrowUp' })).toBe('move-up')
    expect(resolveInboxCommand({ raw: 'j' })).toBe('move-down')
    expect(resolveInboxCommand({ key: 'Enter' })).toBe('activate')
    expect(resolveInboxCommand({ key: 'Escape' })).toBe('back')
    expect(resolveInboxCommand({ key: 'x' })).toBe('delete')
    expect(resolveInboxCommand({ key: 'c' })).toBe('clear')
    expect(resolveInboxCommand({ key: 'a' })).toBe('attach')
  })

  it('resolves session browser commands for web and tui inputs', () => {
    expect(resolveSessionBrowserCommand({ key: 'ArrowUp' })).toBe('move-up')
    expect(resolveSessionBrowserCommand({ raw: 'j' })).toBe('move-down')
    expect(resolveSessionBrowserCommand({ key: 'Enter' })).toBe('activate')
    expect(resolveSessionBrowserCommand({ key: 'n' })).toBe('new')
    expect(resolveSessionBrowserCommand({ key: 'r' })).toBe('refresh')
    expect(resolveSessionBrowserCommand({ key: 'q' })).toBe('back')
    expect(resolveSessionBrowserCommand({ key: '?' })).toBe('help')
    expect(resolveSessionBrowserCommand({ key: 'x' })).toBe('kill')
    expect(resolveSessionBrowserCommand({ key: 'd' })).toBe('delete')
    expect(resolveSessionBrowserCommand({ key: 'i' })).toBe('open-inbox')
    expect(resolveSessionBrowserCommand({ key: 'b' })).toBe('bundle')
  })
})
