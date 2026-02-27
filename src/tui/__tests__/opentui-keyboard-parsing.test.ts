import { describe, expect, it } from 'bun:test'
import { parseKeypress } from '@opentui/core'

const KITTY_BACKSPACE = '\x1b[127;1u'

describe('OpenTUI kitty parsing behavior', () => {
  it('keeps raw CSI-u bytes even when kitty parsing recognizes the key', () => {
    const parsed = parseKeypress(KITTY_BACKSPACE, { useKittyKeyboard: true })

    expect(parsed).not.toBeNull()
    expect(parsed?.source).toBe('kitty')
    expect(parsed?.name).toBe('backspace')
    expect(parsed?.raw).toBe(KITTY_BACKSPACE)
    expect(parsed?.sequence).toBe(KITTY_BACKSPACE)
  })

  it('does not decode CSI-u to legacy key bytes when kitty parsing is disabled', () => {
    const parsed = parseKeypress(KITTY_BACKSPACE, { useKittyKeyboard: false })

    expect(parsed).not.toBeNull()
    expect(parsed?.source).toBe('raw')
    expect(parsed?.name).toBe('')
    expect(parsed?.raw).toBe(KITTY_BACKSPACE)
    expect(parsed?.sequence).toBe(KITTY_BACKSPACE)
  })
})
