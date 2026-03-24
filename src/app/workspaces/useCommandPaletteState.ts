/**
 * Shared command palette state controller.
 * Manages open/close, filter, selection index, and command execution.
 * Use from both TUI and web; platform layer handles rendering and keyboard.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';

export interface CommandPaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  icon?: string;
  /** Optional: run when selected. If not set, caller handles by id. */
  onSelect?: () => void;
}

export interface UseCommandPaletteStateOptions {
  /** Initial command list (e.g. Add Repo, Add Workspace, Set Status, ...). */
  commands: CommandPaletteCommand[];
  /** Called when user selects a command (by id). */
  onSelect?: (commandId: string) => void;
}

export interface CommandPaletteStateResult {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  filter: string;
  setFilter: (value: string) => void;
  /** Filtered commands (by label match). */
  filteredCommands: CommandPaletteCommand[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  /** Select by index and run onSelect. */
  selectCurrent: () => void;
  /** Move selection up/down. */
  moveSelection: (delta: number) => void;
}

export function useCommandPaletteState(
  options: UseCommandPaletteStateOptions
): CommandPaletteStateResult {
  const { commands, onSelect } = options;
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredCommands = useMemo(() => {
    if (!filter.trim()) {
      return commands;
    }
    const lower = filter.toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(lower));
  }, [commands, filter]);

  const open = useCallback(() => {
    setIsOpen(true);
    setFilter('');
    setSelectedIndex(0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setFilter('');
  }, []);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      if (!prev) {
        setFilter('');
        setSelectedIndex(0);
      }
      return !prev;
    });
  }, []);

  const maxIndex = Math.max(0, filteredCommands.length - 1);
  const selectedIndexClamped = Math.min(selectedIndex, maxIndex);

  useEffect(() => {
    if (selectedIndex > maxIndex) {
      setSelectedIndex(maxIndex);
    }
  }, [selectedIndex, maxIndex]);

  const selectCurrent = useCallback(() => {
    const cmd = filteredCommands[selectedIndexClamped];
    if (cmd) {
      if (cmd.onSelect) {
        cmd.onSelect();
      } else {
        onSelect?.(cmd.id);
      }
      close();
    }
  }, [filteredCommands, selectedIndexClamped, onSelect, close]);

  const moveSelection = useCallback(
    (delta: number) => {
      const len = filteredCommands.length;
      if (len === 0) return;
      setSelectedIndex((i) => {
        const next = i + delta;
        if (next < 0) return 0;
        if (next >= len) return len - 1;
        return next;
      });
    },
    [filteredCommands.length]
  );

  return {
    isOpen,
    open,
    close,
    toggle,
    filter,
    setFilter,
    filteredCommands,
  selectedIndex: selectedIndexClamped,
  setSelectedIndex,
  selectCurrent,
    moveSelection,
  };
}
