import { getKeyboardInputChunk, normalizeInputText, type KeyboardLikeInput } from './input-text.js'

interface SearchableSelectState {
  type: string
  searchable?: boolean
  searchQuery?: string
}

export interface SearchableSelectFlowApi {
  flow: SearchableSelectState
  handleCancel: () => void
  handleConfirm: () => void | Promise<void>
  moveUp: () => void
  moveDown: () => void
  updateSelectQuery: (value: string) => void
}

function isSearchableSelectOpen(flow: SearchableSelectFlowApi): boolean {
  return flow.flow.type === 'select' && flow.flow.searchable === true
}

export function applySearchableSelectPaste(flow: SearchableSelectFlowApi, text: string): boolean {
  if (!isSearchableSelectOpen(flow)) {
    return false
  }

  const chunk = normalizeInputText(text)
  if (!chunk) {
    return false
  }

  const current = flow.flow.searchQuery ?? ''
  flow.updateSelectQuery(current + chunk)
  return true
}

export async function handleSearchableSelectKey(
  flow: SearchableSelectFlowApi,
  key: KeyboardLikeInput
): Promise<boolean> {
  if (!isSearchableSelectOpen(flow)) {
    return false
  }

  if (key.name === 'escape') {
    flow.handleCancel()
    return true
  }

  if (key.name === 'return') {
    await flow.handleConfirm()
    return true
  }

  if (key.name === 'up') {
    flow.moveUp()
    return true
  }

  if (key.name === 'down') {
    flow.moveDown()
    return true
  }

  if (key.name === 'backspace') {
    const current = flow.flow.searchQuery ?? ''
    flow.updateSelectQuery(current.slice(0, -1))
    return true
  }

  const chunk = getKeyboardInputChunk(key)
  if (chunk) {
    const current = flow.flow.searchQuery ?? ''
    flow.updateSelectQuery(current + chunk)
  }

  return true
}
