/**
 * Shared command palette state controller.
 * Manages open/close, filter, selection index, and command execution.
 * Use from both TUI and web; platform layer handles rendering and keyboard.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';

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
  const [selectedIndex, setSelectedIndexState] = useState(0);
  const selectedIndexRef = useRef(0);

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
    selectedIndexRef.current = 0;
    setSelectedIndexState(0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setFilter('');
  }, []);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      if (!prev) {
        setFilter('');
        selectedIndexRef.current = 0;
        setSelectedIndexState(0);
      }
      return !prev;
    });
  }, []);

  const maxIndex = Math.max(0, filteredCommands.length - 1);
  const selectedIndexClamped = Math.min(selectedIndex, maxIndex);

  useEffect(() => {
    if (selectedIndex > maxIndex) {
      selectedIndexRef.current = maxIndex;
      setSelectedIndexState(maxIndex);
    }
  }, [selectedIndex, maxIndex]);

  const selectCurrent = useCallback(() => {
    const index = Math.max(0, Math.min(selectedIndexRef.current, Math.max(0, filteredCommands.length - 1)));
    const cmd = filteredCommands[index];
    if (cmd) {
      if (cmd.onSelect) {
        cmd.onSelect();
      } else {
        onSelect?.(cmd.id);
      }
      close();
    }
  }, [filteredCommands, onSelect, close]);

  const moveSelection = useCallback(
    (delta: number) => {
      const len = filteredCommands.length;
      if (len === 0) return;
      setSelectedIndexState((i) => {
        const next = i + delta;
        const clamped = next < 0 ? 0 : next >= len ? len - 1 : next;
        selectedIndexRef.current = clamped;
        return clamped;
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
    setSelectedIndex: (index: number) => {
      selectedIndexRef.current = index;
      setSelectedIndexState(index);
    },
  selectCurrent,
    moveSelection,
  };
}
