import { describe, expect, it } from 'bun:test'
import {
  canConsumePageNavigationInViewport,
  getPageNavigationEscapeSequence,
  shouldConsumePageNavigationInScrollbox,
} from '../../components/session-terminal-page-navigation.js'

describe('session terminal page navigation helpers', () => {
  it('consumes page navigation only when scrollbox has overflow', () => {
    expect(shouldConsumePageNavigationInScrollbox({ scrollHeight: 100, viewportHeight: 20 })).toBe(true)
    expect(shouldConsumePageNavigationInScrollbox({ scrollHeight: 20, viewportHeight: 20 })).toBe(false)
    expect(shouldConsumePageNavigationInScrollbox({ scrollHeight: 10, viewportHeight: 20 })).toBe(false)
  })

  it('detects when viewport can consume page up/down', () => {
    expect(
      canConsumePageNavigationInViewport({
        direction: 'up',
        viewportY: 0,
        baseY: 200,
      })
    ).toBe(true)

    expect(
      canConsumePageNavigationInViewport({
        direction: 'down',
        viewportY: 75,
        baseY: 200,
      })
    ).toBe(true)

    expect(
      canConsumePageNavigationInViewport({
        direction: 'down',
        viewportY: 200,
        baseY: 200,
      })
    ).toBe(false)
  })

  it('returns standard escape sequences for page keys', () => {
    expect(getPageNavigationEscapeSequence('up')).toBe('\x1b[5~')
    expect(getPageNavigationEscapeSequence('down')).toBe('\x1b[6~')
  })
})
