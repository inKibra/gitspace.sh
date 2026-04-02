import { describe, expect, it } from 'bun:test'
import { createCliRenderer } from '@opentui/core'
import {
  VT_KITTY_KEYBOARD_CONFIG,
  forceDisableKittyKeyboard,
} from '../kitty-keyboard.js'

const runIntegration = process.env.GSSH_RUN_TTY_KEYBOARD_TEST === '1'

describe('OpenTUI kitty keyboard integration', () => {
  const integrationIt = runIntegration ? it : it.skip

  integrationIt('forces kitty mode off in workaround path', async () => {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      targetFps: 1,
      useMouse: false,
      useKittyKeyboard: VT_KITTY_KEYBOARD_CONFIG,
    })

    try {
      forceDisableKittyKeyboard(renderer, () => {})
      expect(renderer.useKittyKeyboard).toBe(false)
    } finally {
      renderer.destroy()
    }
  })
})
