import { describe, expect, it } from 'bun:test'
import { getKeyboardInputChunk, getNumericInputChunk, normalizeInputText } from '../input-text.js'

describe('tui input text helpers', () => {
  it('accepts single-key and pasted multi-character keyboard chunks', () => {
    expect(getKeyboardInputChunk({ raw: 'a' })).toBe('a')
    expect(getKeyboardInputChunk({ raw: 'PULUMI_ACCESS_TOKEN_123' })).toBe('PULUMI_ACCESS_TOKEN_123')
  })

  it('filters control characters and line breaks from pasted text', () => {
    expect(normalizeInputText('abc\n123\r\n')).toBe('abc123')
    expect(normalizeInputText('tok\u0007en')).toBe('token')
  })

  it('extracts numeric chunks for numeric-only fields', () => {
    expect(getNumericInputChunk('1a2b3')).toBe('123')
    expect(getNumericInputChunk('abc')).toBe('')
  })

  it('ignores keyboard chunks when ctrl/meta modifiers are active', () => {
    expect(getKeyboardInputChunk({ raw: 'v', ctrl: true })).toBeNull()
    expect(getKeyboardInputChunk({ raw: 'v', meta: true })).toBeNull()
  })
})
