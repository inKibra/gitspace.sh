import { describe, expect, it } from 'bun:test'
import { buildRemoteBackendKey } from '../connect-key'

describe('buildRemoteBackendKey', () => {
  it('builds canonical remote backend key with relay URL and machine id', () => {
    expect(buildRemoteBackendKey('ws://relay.test/ws', 'machine-1')).toBe(
      'remote:ws://relay.test/ws:machine-1'
    )
  })
})
