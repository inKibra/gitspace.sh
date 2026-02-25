import { describe, expect, it } from 'bun:test'
import {
  canConsumePageNavigationInViewport,
  getPageNavigationEscapeSequence,
  shouldBypassScrollboxKeyHandling,
  shouldConsumePageNavigationInScrollbox,
} from '../../components/session-terminal-page-navigation.js'

describe('session terminal page navigation helpers', () => {
  it('consumes scrollbox page navigation only when scroll can move', () => {
    expect(
      shouldConsumePageNavigationInScrollbox({
        direction: 'up',
        scrollTop: 10,
        scrollHeight: 100,
        viewportHeight: 20,
      })
    ).toBe(true)

    expect(
      shouldConsumePageNavigationInScrollbox({
        direction: 'up',
        scrollTop: 0,
        scrollHeight: 100,
        viewportHeight: 20,
      })
    ).toBe(false)

    expect(
      shouldConsumePageNavigationInScrollbox({
        direction: 'down',
        scrollTop: 10,
        scrollHeight: 100,
        viewportHeight: 20,
      })
    ).toBe(true)

    expect(
      shouldConsumePageNavigationInScrollbox({
        direction: 'down',
        scrollTop: 80,
        scrollHeight: 100,
        viewportHeight: 20,
      })
    ).toBe(false)

    expect(
      shouldConsumePageNavigationInScrollbox({
        direction: 'down',
        scrollTop: 0,
        scrollHeight: 20,
        viewportHeight: 20,
      })
    ).toBe(false)
  })

  it('detects when viewport can consume page up/down', () => {
    expect(
      canConsumePageNavigationInViewport({
        direction: 'up',
        viewportY: 50,
        baseY: 200,
      })
    ).toBe(true)

    expect(
      canConsumePageNavigationInViewport({
        direction: 'down',
        viewportY: 1,
        baseY: 200,
      })
    ).toBe(true)

    expect(
      canConsumePageNavigationInViewport({
        direction: 'down',
        viewportY: 0,
        baseY: 200,
      })
    ).toBe(false)

    expect(
      canConsumePageNavigationInViewport({
        direction: 'up',
        viewportY: 200,
        baseY: 200,
      })
    ).toBe(false)
  })

  it('returns standard escape sequences for page keys', () => {
    expect(getPageNavigationEscapeSequence('up')).toBe('\x1b[5~')
    expect(getPageNavigationEscapeSequence('down')).toBe('\x1b[6~')
  })

  it('bypasses scrollbox key handling for terminal navigation keys', () => {
    expect(shouldBypassScrollboxKeyHandling('up')).toBe(true)
    expect(shouldBypassScrollboxKeyHandling('down')).toBe(true)
    expect(shouldBypassScrollboxKeyHandling('home')).toBe(true)
    expect(shouldBypassScrollboxKeyHandling('end')).toBe(true)
    expect(shouldBypassScrollboxKeyHandling('pageup')).toBe(true)
    expect(shouldBypassScrollboxKeyHandling('pagedown')).toBe(true)

    expect(shouldBypassScrollboxKeyHandling('left')).toBe(false)
    expect(shouldBypassScrollboxKeyHandling(undefined)).toBe(false)
  })
})
