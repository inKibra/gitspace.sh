import React, { useState, useCallback, useRef, useEffect } from 'react';
import { triggerHaptic } from '../utils/device';
import { DPad } from './DPad';
import { NumPad } from './NumPad';

export interface TerminalControlsProps {
  /** Callback to send data to terminal */
  onSendData: (data: string) => void;
  /** Callback to focus the terminal */
  onFocusTerminal?: () => void;
  /** Custom class name */
  className?: string;
}

interface ModifierState {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
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

/** Delay in ms before long-press triggers D-Pad or NumPad overlay */
const LONG_PRESS_DELAY = 150;

/**
 * Calculate modifier value for CSI sequences.
 * Formula: 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
 */
function getModifierValue(modifiers: ModifierState): number {
  return (
    1 +
    (modifiers.shift ? 1 : 0) +
    (modifiers.alt ? 2 : 0) +
    (modifiers.ctrl ? 4 : 0)
  );
}

/**
 * Generate escape sequence for arrow key with modifiers.
 * Plain: \x1b[A
 * With modifier: \x1b[1;{modifier}A
 */
function getArrowSequence(
  direction: 'up' | 'down' | 'left' | 'right',
  modifiers: ModifierState
): string {
  const codes: Record<string, string> = {
    up: 'A',
    down: 'B',
    right: 'C',
    left: 'D',
  };

  const code = codes[direction];
  const modifier = getModifierValue(modifiers);

  if (modifier === 1) {
    // No modifiers - plain arrow key
    return `\x1b[${code}`;
  }

  // With modifiers: CSI 1;{modifier}{code}
  return `\x1b[1;${modifier}${code}`;
}

export function TerminalControls({
  onSendData,
  onFocusTerminal,
  className = '',
}: TerminalControlsProps): React.ReactElement {
  // Modifier toggle states (sticky until used)
  const [modifiers, setModifiers] = useState<ModifierState>({
    ctrl: false,
    shift: false,
    alt: false,
  });

  // D-Pad and NumPad visibility
  const [showDPad, setShowDPad] = useState(false);
  const [showNumPad, setShowNumPad] = useState(false);

  // Separate timer refs to prevent conflicts when both are triggered
  const dpadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const numpadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset modifiers after sending a key
  const resetModifiers = useCallback(() => {
    setModifiers({ ctrl: false, shift: false, alt: false });
  }, []);

  // Toggle a modifier
  const toggleModifier = useCallback(
    (mod: keyof ModifierState) => {
      triggerHaptic(8);
      setModifiers((prev) => ({ ...prev, [mod]: !prev[mod] }));
      onFocusTerminal?.();
    },
    [onFocusTerminal]
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

  // Handle arrow key from D-Pad
  const handleArrow = useCallback(
    (direction: 'up' | 'down' | 'left' | 'right') => {
      const sequence = getArrowSequence(direction, modifiers);
      // Preserve modifiers for repeated arrow presses
      sendKey(sequence, true);
    },
    [modifiers, sendKey]
  );

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

  // Long press handlers for D-Pad trigger
  const handleDPadTouchStart = useCallback(() => {
    dpadTimerRef.current = setTimeout(() => {
      triggerHaptic(15);
      setShowDPad(true);
    }, LONG_PRESS_DELAY);
  }, []);

  const handleDPadTouchEnd = useCallback(() => {
    if (dpadTimerRef.current) {
      clearTimeout(dpadTimerRef.current);
      dpadTimerRef.current = null;
    }
  }, []);

  // Keyboard accessibility for D-Pad trigger
  const handleDPadKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      triggerHaptic(15);
      setShowDPad(true);
    }
  }, []);

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

  // Close overlays
  const closeDPad = useCallback(() => {
    setShowDPad(false);
    resetModifiers();
    onFocusTerminal?.();
  }, [resetModifiers, onFocusTerminal]);

  const closeNumPad = useCallback(() => {
    setShowNumPad(false);
    resetModifiers();
    onFocusTerminal?.();
  }, [resetModifiers, onFocusTerminal]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (dpadTimerRef.current) {
        clearTimeout(dpadTimerRef.current);
      }
      if (numpadTimerRef.current) {
        clearTimeout(numpadTimerRef.current);
      }
    };
  }, []);

  return (
    <>
      {/* Main controls bar */}
      <div
        className={`terminal-controls flex items-center gap-1 p-2 bg-[#161b22] border-t border-[#30363d] ${className}`}
        style={{
          paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
        }}
      >
        {/* Modifier toggles */}
        <div className="flex items-center gap-1 mr-2">
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
        </div>

        {/* Separator */}
        <div className="w-px h-6 bg-[#30363d] mx-1" />

        {/* Quick keys - scrollable on small screens */}
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
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
            small
          />

          {/* Separator */}
          <div className="w-px h-6 bg-[#30363d] mx-1 flex-shrink-0" />

          {/* Navigation keys */}
          <TerminalKey label="PgUp" onPress={handlePageUp} small />
          <TerminalKey label="PgDn" onPress={handlePageDown} small />
          <TerminalKey label="Home" onPress={handleHome} small />
          <TerminalKey label="End" onPress={handleEnd} small />

          {/* Separator */}
          <div className="w-px h-6 bg-[#30363d] mx-1 flex-shrink-0" />

          {/* D-Pad and NumPad triggers */}
          <TerminalKey
            label="↕"
            onTouchStart={handleDPadTouchStart}
            onTouchEnd={handleDPadTouchEnd}
            onKeyDown={handleDPadKeyDown}
            title="Hold for arrow keys (or press Enter)"
          />
          <TerminalKey
            label="123"
            onTouchStart={handleNumPadTouchStart}
            onTouchEnd={handleNumPadTouchEnd}
            onKeyDown={handleNumPadKeyDown}
            title="Hold for number pad (or press Enter)"
            small
          />
        </div>
      </div>

      {/* D-Pad overlay */}
      {showDPad && (
        <DPad
          onDirection={handleArrow}
          onClose={closeDPad}
          modifiers={modifiers}
        />
      )}

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
        terminal-key px-2 py-1 rounded text-xs font-medium
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
        minWidth: '40px',
        minHeight: '32px',
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
  small?: boolean;
}

function TerminalKey({
  label,
  onPress,
  onTouchStart,
  onTouchEnd,
  onKeyDown,
  highlight = false,
  title,
  small = false,
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
        terminal-key px-2 py-1 rounded font-medium
        transition-all duration-75 active:scale-95
        ${small ? 'text-[10px]' : 'text-sm'}
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
        minWidth: small ? '36px' : '40px',
        minHeight: '32px',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {label}
    </button>
  );
}

