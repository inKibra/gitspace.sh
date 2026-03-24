/**
 * KanbanBoard - Shared logic for workspace board by phase.
 * Renders columns (plan, code, review, ship) and workspace cards.
 * Selection is driven by workspaceBoardState and workspaceDetailState.
 */

import type { KanbanWorkspaceItem } from '../machine/controllers/useKanbanViewController.js';

export function getWorkspaceDisplayName(entry: KanbanWorkspaceItem): string {
  return entry.name || entry.id.split(':').pop() || entry.id;
}
