import { describe, expect, it } from 'bun:test'
import { ScriptTerminalBuffer } from '../script-terminal-buffer.tui.js'

function createFeedTarget() {
  const chunks: string[] = []
  return {
    chunks,
    target: {
      feed(data: Buffer) {
        chunks.push(data.toString('utf-8'))
      },
    },
  }
}

describe('ScriptTerminalBuffer', () => {
  it('buffers output before mount and flushes exactly once on first mount', () => {
    const buffer = new ScriptTerminalBuffer()
    const { chunks, target } = createFeedTarget()

    buffer.feed(new TextEncoder().encode('hello '))
    buffer.feed(new TextEncoder().encode('world'))

    expect(chunks).toEqual([])

    buffer.setTarget(target)
    expect(chunks).toEqual(['hello world'])

    // Subsequent target updates should not replay already-flushed output.
    buffer.setTarget(target)
    expect(chunks).toEqual(['hello world'])
  })

  it('does not replay previously rendered output after ref churn', () => {
    const buffer = new ScriptTerminalBuffer()
    const { chunks, target } = createFeedTarget()

    buffer.setTarget(target)
    buffer.feed(new TextEncoder().encode('line-1\n'))
    expect(chunks).toEqual(['line-1\n'])

    // Simulate ref callback churn: unmount then remount same target.
    buffer.setTarget(null)
    buffer.setTarget(target)

    // Already-rendered bytes should not replay.
    expect(chunks).toEqual(['line-1\n'])

    // New bytes still render once.
    buffer.feed(new TextEncoder().encode('line-2\n'))
    expect(chunks).toEqual(['line-1\n', 'line-2\n'])
  })

  it('flushes only bytes written while target is detached', () => {
    const buffer = new ScriptTerminalBuffer()
    const { chunks, target } = createFeedTarget()

    buffer.setTarget(target)
    buffer.feed(new TextEncoder().encode('initial\n'))
    expect(chunks).toEqual(['initial\n'])

    buffer.setTarget(null)
    buffer.feed(new TextEncoder().encode('pending-a\n'))
    buffer.feed(new TextEncoder().encode('pending-b\n'))

    // No direct writes while detached.
    expect(chunks).toEqual(['initial\n'])

    buffer.setTarget(target)
    expect(chunks).toEqual(['initial\n', 'pending-a\npending-b\n'])
  })
})
