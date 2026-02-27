import { describe, expect, it } from 'bun:test'
import {
  KITTY_KEYBOARD_DISABLE_SEQUENCE,
  KITTY_KEYBOARD_ENABLE_SEQUENCE,
  VT_KITTY_KEYBOARD_CONFIG,
  forceDisableKittyKeyboard,
  restoreKittyKeyboard,
  type KittyKeyboardRenderer,
} from '../kitty-keyboard.js'

function createRendererMock(initialMode: boolean): KittyKeyboardRenderer & {
  disableCalls: number
  enableCalls: number
} {
  return {
    useKittyKeyboard: initialMode,
    disableCalls: 0,
    enableCalls: 0,
    disableKittyKeyboard() {
      this.disableCalls += 1
      this.useKittyKeyboard = false
    },
    enableKittyKeyboard() {
      this.enableCalls += 1
      this.useKittyKeyboard = true
    },
  }
}

describe('kitty keyboard helpers', () => {
  it('defines VT kitty config with all options disabled', () => {
    expect(VT_KITTY_KEYBOARD_CONFIG).toEqual({
      disambiguate: false,
      alternateKeys: false,
      events: false,
      allKeysAsEscapes: false,
      reportText: false,
    })
  })

  it('forceDisableKittyKeyboard disables renderer and writes disable sequence', () => {
    const renderer = createRendererMock(true)
    const writes: string[] = []

    forceDisableKittyKeyboard(renderer, (chunk) => {
      writes.push(chunk)
    })

    expect(renderer.useKittyKeyboard).toBe(false)
    expect(renderer.disableCalls).toBe(1)
    expect(renderer.enableCalls).toBe(0)
    expect(writes).toEqual([KITTY_KEYBOARD_DISABLE_SEQUENCE])
  })

  it('restoreKittyKeyboard reenables kitty mode when previous mode was enabled', () => {
    const renderer = createRendererMock(false)
    const writes: string[] = []

    restoreKittyKeyboard(renderer, true, (chunk) => {
      writes.push(chunk)
    })

    expect(renderer.useKittyKeyboard).toBe(true)
    expect(renderer.enableCalls).toBe(1)
    expect(renderer.disableCalls).toBe(0)
    expect(writes).toEqual([KITTY_KEYBOARD_ENABLE_SEQUENCE])
  })

  it('restoreKittyKeyboard keeps kitty mode disabled when previous mode was disabled', () => {
    const renderer = createRendererMock(true)
    const writes: string[] = []

    restoreKittyKeyboard(renderer, false, (chunk) => {
      writes.push(chunk)
    })

    expect(renderer.useKittyKeyboard).toBe(false)
    expect(renderer.enableCalls).toBe(0)
    expect(renderer.disableCalls).toBe(1)
    expect(writes).toEqual([KITTY_KEYBOARD_DISABLE_SEQUENCE])
  })
})
