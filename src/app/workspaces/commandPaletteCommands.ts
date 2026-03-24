/**
 * Shared command palette command definitions.
 * Apps build CommandPaletteCommand[] by adding onSelect to these entries.
 */

export const COMMAND_PALETTE_COMMAND_DEFS = [
  { id: 'add-repo', label: 'Add Repo', shortcut: '⌘N' },
  { id: 'add-workspace', label: 'Add Workspace', shortcut: '⌘⇧N' },
  { id: 'set-status', label: 'Set Workspace Status', shortcut: '' },
  { id: 'delete-repo', label: 'Delete Repo', shortcut: '' },
  { id: 'delete-workspace', label: 'Delete Workspace', shortcut: '' },
  { id: 'edit-bundle-config', label: 'Edit Bundle Config', shortcut: '' },
  { id: 'edit-process-config', label: 'Edit Process Config', shortcut: '' },
  { id: 'open-github-pr', label: 'Open GitHub PR', shortcut: '' },
  { id: 'open-review', label: 'Open Review', shortcut: '' },
  { id: 'open-service', label: 'Open Service in Browser', shortcut: '' },
] as const;

export type CommandPaletteCommandId = (typeof COMMAND_PALETTE_COMMAND_DEFS)[number]['id'];
