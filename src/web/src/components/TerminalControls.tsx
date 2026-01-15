import React, { useState, useCallback, useRef, useEffect } from 'react';
import { triggerHaptic } from '../utils/device';
import { NumPad } from './NumPad';

export interface ModifierState {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export interface TerminalControlsProps {
  /** Callback to send data to terminal */
  onSendData: (data: string) => void;
  /** Callback to focus the terminal */
  onFocusTerminal?: () => void;
  /** Whether keyboard is visible - positions bar above floating controls when false */
  keyboardVisible?: boolean;
  /** Modifier state (lifted to parent for keyboard integration) */
  modifiers: ModifierState;
  /** Callback to update modifier state */
  onModifiersChange: (modifiers: ModifierState) => void;
  /** Custom class name */
  className?: string;
}

// Escape sequences for special keys
const ESC = '\x1b';
const TAB = '\x09';
const BACKTAB = '\x1b[Z'; // CSI Z - Shift+Tab
const BACKSPACE = '\x7f';
const CTRL_W = '\x17'; // Ctrl+W for word delete
const ENTER = '\r';
const CTRL_C = '\x03'; // ETX - interrupt
const SHIFT_ENTER = '\x1b[13;2u'; // CSI u - Shift+Enter
const PAGE_UP = '\x1b[5~'; // CSI 5 ~
const PAGE_DOWN = '\x1b[6~'; // CSI 6 ~
const HOME = '\x1b[H'; // CSI H
const END = '\x1b[F'; // CSI F

/** Delay in ms before long-press triggers NumPad overlay */
const LONG_PRESS_DELAY = 150;

/**
 * Apply virtual modifiers to keyboard input.
 * Used when user selects modifiers from TerminalControls then types on mobile keyboard.
 */
export function applyModifiersToInput(
  data: Uint8Array,
  modifiers: ModifierState
): Uint8Array {
  // If no modifiers active, return as-is
  if (!modifiers.ctrl && !modifiers.shift && !modifiers.alt) {
    return data;
  }

  const result: number[] = [];

  for (const byte of data) {
    let modified = byte;

    // Handle Ctrl modifier for printable ASCII characters
    if (modifiers.ctrl) {
      // For letters a-z or A-Z, convert to control character (0x01-0x1A)
      if (byte >= 0x61 && byte <= 0x7a) {
        // lowercase a-z
        modified = byte - 0x60; // a=0x61 -> 0x01, z=0x7a -> 0x1a
      } else if (byte >= 0x41 && byte <= 0x5a) {
        // uppercase A-Z
        modified = byte - 0x40; // A=0x41 -> 0x01, Z=0x5a -> 0x1a
      }
      // For other characters, Ctrl doesn't have standard behavior
    }

    // Handle Shift modifier (uppercase)
    // Note: Mobile keyboards usually handle shift themselves, but if not:
    if (modifiers.shift && !modifiers.ctrl) {
      if (byte >= 0x61 && byte <= 0x7a) {
        // lowercase a-z -> uppercase A-Z
        modified = byte - 0x20;
      }
    }

    // Handle Alt modifier (send ESC prefix)
    if (modifiers.alt) {
      result.push(0x1b); // ESC
    }

    result.push(modified);
  }

  return new Uint8Array(result);
}

export function TerminalControls({
  onSendData,
  onFocusTerminal,
  keyboardVisible = true,
  modifiers,
  onModifiersChange,
  className = '',
}: TerminalControlsProps): React.ReactElement {
  // NumPad visibility
  const [showNumPad, setShowNumPad] = useState(false);

  // Timer ref for long press
  const numpadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset modifiers after sending a key
  const resetModifiers = useCallback(() => {
    onModifiersChange({ ctrl: false, shift: false, alt: false });
  }, [onModifiersChange]);

  // Toggle a modifier
  const toggleModifier = useCallback(
    (mod: keyof ModifierState) => {
      triggerHaptic(8);
      onModifiersChange({ ...modifiers, [mod]: !modifiers[mod] });
      onFocusTerminal?.();
    },
    [modifiers, onModifiersChange, onFocusTerminal]
  );

  // Send a key with current modifiers applied
  const sendKey = useCallback(
    (key: string, preserveModifiers = false) => {
      triggerHaptic(5);
      onSendData(key);
      if (!preserveModifiers) {
        resetModifiers();
      }
      onFocusTerminal?.();
    },
    [onSendData, resetModifiers, onFocusTerminal]
  );

  // Handle Escape key
  const handleEscape = useCallback(() => {
    sendKey(ESC);
  }, [sendKey]);

  // Handle Tab key (respects Shift modifier for backtab)
  const handleTab = useCallback(() => {
    if (modifiers.shift) {
      sendKey(BACKTAB);
    } else {
      sendKey(TAB);
    }
  }, [modifiers.shift, sendKey]);

  // Handle Backspace (Ctrl+W for word delete if Ctrl is active)
  const handleBackspace = useCallback(() => {
    if (modifiers.ctrl) {
      sendKey(CTRL_W);
    } else {
      sendKey(BACKSPACE);
    }
  }, [modifiers.ctrl, sendKey]);

  // Handle Enter (Shift+Enter sends CSI u sequence)
  const handleEnter = useCallback(() => {
    if (modifiers.shift) {
      sendKey(SHIFT_ENTER);
    } else {
      sendKey(ENTER);
    }
  }, [modifiers.shift, sendKey]);

  // Handle Ctrl+C
  const handleCtrlC = useCallback(() => {
    sendKey(CTRL_C);
  }, [sendKey]);

  // Handle Page Up
  const handlePageUp = useCallback(() => {
    sendKey(PAGE_UP);
  }, [sendKey]);

  // Handle Page Down
  const handlePageDown = useCallback(() => {
    sendKey(PAGE_DOWN);
  }, [sendKey]);

  // Handle Home
  const handleHome = useCallback(() => {
    sendKey(HOME);
  }, [sendKey]);

  // Handle End
  const handleEnd = useCallback(() => {
    sendKey(END);
  }, [sendKey]);

  // Handle number from NumPad
  const handleNumber = useCallback(
    (num: number) => {
      const char = num.toString();
      if (modifiers.ctrl) {
        // Ctrl+number - just send the number with ctrl prefix
        // Most terminals don't have special handling for Ctrl+number
        sendKey(char);
      } else {
        sendKey(char);
      }
    },
    [modifiers, sendKey]
  );

  // Long press handlers for NumPad trigger
  const handleNumPadTouchStart = useCallback(() => {
    numpadTimerRef.current = setTimeout(() => {
      triggerHaptic(15);
      setShowNumPad(true);
    }, LONG_PRESS_DELAY);
  }, []);

  const handleNumPadTouchEnd = useCallback(() => {
    if (numpadTimerRef.current) {
      clearTimeout(numpadTimerRef.current);
      numpadTimerRef.current = null;
    }
  }, []);

  // Keyboard accessibility for NumPad trigger
  const handleNumPadKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      triggerHaptic(15);
      setShowNumPad(true);
    }
  }, []);

  // Close NumPad overlay
  const closeNumPad = useCallback(() => {
    setShowNumPad(false);
    resetModifiers();
    onFocusTerminal?.();
  }, [resetModifiers, onFocusTerminal]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (numpadTimerRef.current) {
        clearTimeout(numpadTimerRef.current);
      }
    };
  }, []);

  return (
    <>
      {/* Main controls bar - two rows for more space */}
      <div
        className={`terminal-controls flex flex-col gap-2 p-3 bg-[#161b22] border-t border-[#30363d] ${className}`}
        style={{
          paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
          // When keyboard is hidden, position above floating controls (jog wheel area)
          bottom: keyboardVisible
            ? 'var(--keyboard-inset, 0px)'
            : 'calc(130px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        {/* Row 1: Modifier toggles - larger buttons */}
        <div className="flex items-center justify-center gap-2">
          <ModifierButton
            label="Ctrl"
            active={modifiers.ctrl}
            onToggle={() => toggleModifier('ctrl')}
          />
          <ModifierButton
            label="Shift"
            active={modifiers.shift}
            onToggle={() => toggleModifier('shift')}
          />
          <ModifierButton
            label="Alt"
            active={modifiers.alt}
            onToggle={() => toggleModifier('alt')}
          />

          {/* Separator */}
          <div className="w-px h-8 bg-[#30363d] mx-1" />

          {/* NumPad trigger - D-Pad removed since jog wheel handles arrows */}
          <TerminalKey
            label="123"
            onTouchStart={handleNumPadTouchStart}
            onTouchEnd={handleNumPadTouchEnd}
            onKeyDown={handleNumPadKeyDown}
            title="Hold for number pad"
          />
        </div>

        {/* Row 2: Quick keys - full width, evenly spaced */}
        <div className="flex items-center justify-between gap-1.5">
          <TerminalKey label="Esc" onPress={handleEscape} />
          <TerminalKey
            label="Tab"
            onPress={handleTab}
            highlight={modifiers.shift}
          />
          <TerminalKey
            label="⌫"
            onPress={handleBackspace}
            highlight={modifiers.ctrl}
            title={modifiers.ctrl ? 'Ctrl+W (delete word)' : 'Backspace'}
          />
          <TerminalKey
            label="↵"
            onPress={handleEnter}
            highlight={modifiers.shift}
            title={modifiers.shift ? 'Shift+Enter' : 'Enter'}
          />
          <TerminalKey
            label="^C"
            onPress={handleCtrlC}
            title="Ctrl+C (interrupt)"
          />
          <TerminalKey label="PgUp" onPress={handlePageUp} />
          <TerminalKey label="PgDn" onPress={handlePageDown} />
          <TerminalKey label="Home" onPress={handleHome} />
          <TerminalKey label="End" onPress={handleEnd} />
        </div>
      </div>

      {/* NumPad overlay */}
      {showNumPad && (
        <NumPad
          onNumber={handleNumber}
          onClose={closeNumPad}
          modifiers={modifiers}
        />
      )}
    </>
  );
}

// Modifier toggle button component
interface ModifierButtonProps {
  label: string;
  active: boolean;
  onToggle: () => void;
}

function ModifierButton({
  label,
  active,
  onToggle,
}: ModifierButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`
        terminal-key px-3 py-2 rounded text-sm font-medium
        transition-colors duration-75
        ${
          active
            ? 'bg-[#22c55e] text-[#0d1117] shadow-glow'
            : 'bg-[#21262d] text-[#e6edf3] hover:bg-[#30363d]'
        }
      `}
      style={{
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
        minWidth: '52px',
        minHeight: '40px',
      }}
    >
      {label}
    </button>
  );
}

// Terminal key button component
interface TerminalKeyProps {
  label: string;
  onPress?: () => void;
  onTouchStart?: () => void;
  onTouchEnd?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  highlight?: boolean;
  title?: string;
}

function TerminalKey({
  label,
  onPress,
  onTouchStart,
  onTouchEnd,
  onKeyDown,
  highlight = false,
  title,
}: TerminalKeyProps): React.ReactElement {
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      onTouchStart?.();
    },
    [onTouchStart]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      onTouchEnd?.();
      // If no long press handlers, treat as a tap
      if (!onTouchStart && onPress) {
        onPress();
      }
    },
    [onTouchEnd, onTouchStart, onPress]
  );

  const handleClick = useCallback(() => {
    // For mouse clicks (desktop)
    if (!onTouchStart && onPress) {
      onPress();
    }
  }, [onTouchStart, onPress]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (onKeyDown) {
        onKeyDown(e);
      } else if (onPress && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onPress();
      }
    },
    [onKeyDown, onPress]
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onKeyDown={handleKeyDown}
      title={title}
      className={`
        terminal-key px-2 py-1.5 rounded text-xs font-medium flex-1
        transition-all duration-75 active:scale-95
        ${
          highlight
            ? 'bg-[#d29922] text-[#0d1117] shadow-glow'
            : 'bg-[#21262d] text-[#e6edf3] hover:bg-[#30363d]'
        }
      `}
      style={{
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
        minWidth: '32px',
        minHeight: '36px',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {label}
    </button>
  );
}

