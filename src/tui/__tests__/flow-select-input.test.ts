import { describe, expect, it, mock } from 'bun:test'
import { applySearchableSelectPaste, handleSearchableSelectKey } from '../flow-select-input.js'

function createFlow(overrides: Partial<{ type: string; searchable: boolean; searchQuery: string }> = {}) {
  const flowState = {
    type: overrides.type ?? 'select',
    searchable: overrides.searchable ?? true,
    searchQuery: overrides.searchQuery ?? '',
  }

  const flowApi = {
    flow: flowState,
    handleCancel: mock(() => {}),
    handleConfirm: mock(async () => {}),
    moveUp: mock(() => {}),
    moveDown: mock(() => {}),
    updateSelectQuery: mock((value: string) => {
      flowState.searchQuery = value
    }),
  }

  return flowApi
}

describe('searchable select input helpers', () => {
  it('applies normalized pasted text to searchable select query', () => {
    const flow = createFlow({ searchQuery: 'fea' })

    const handled = applySearchableSelectPaste(flow, 't\nure')

    expect(handled).toBe(true)
    expect(flow.flow.searchQuery).toBe('feature')
    expect(flow.updateSelectQuery).toHaveBeenCalledWith('feature')
  })

  it('treats j/k as text input for searchable selects', async () => {
    const flow = createFlow({ searchQuery: 'fix-' })

    const handled = await handleSearchableSelectKey(flow, { raw: 'j' })

    expect(handled).toBe(true)
    expect(flow.flow.searchQuery).toBe('fix-j')
    expect(flow.moveDown).toHaveBeenCalledTimes(0)
  })

  it('uses arrow keys for navigation in searchable selects', async () => {
    const flow = createFlow()

    const handled = await handleSearchableSelectKey(flow, { name: 'down' })

    expect(handled).toBe(true)
    expect(flow.moveDown).toHaveBeenCalledTimes(1)
    expect(flow.updateSelectQuery).toHaveBeenCalledTimes(0)
  })

  it('returns false when flow is not a searchable select', async () => {
    const flow = createFlow({ type: 'message', searchable: false })

    const pasteHandled = applySearchableSelectPaste(flow, 'abc')
    const keyHandled = await handleSearchableSelectKey(flow, { raw: 'x' })

    expect(pasteHandled).toBe(false)
    expect(keyHandled).toBe(false)
    expect(flow.updateSelectQuery).toHaveBeenCalledTimes(0)
  })
})
