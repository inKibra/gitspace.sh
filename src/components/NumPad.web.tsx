import React, { useCallback, useState, useRef } from 'react';
import { triggerHaptic } from '../utils/device.web';

export interface NumPadProps {
  /** Callback when a number is pressed */
  onNumber: (num: number) => void;
  /** Callback to close the NumPad */
  onClose: () => void;
  /** Current modifier state for display */
  modifiers?: {
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
  };
}

// Grid layout constants
const CELL_WIDTH = 56; // px - matches Tailwind w-14
const CELL_HEIGHT = 48; // px - matches Tailwind h-12
const GAP = 6; // px - gap between cells
const PADDING = 16; // px - padding around grid

// Calculate total dimensions
const PAD_WIDTH = CELL_WIDTH * 3 + GAP * 2 + PADDING * 2;

// Number grid layout (calculator style)
// Row 1: 7 8 9
// Row 2: 4 5 6
// Row 3: 1 2 3
// Row 4: - 0 -
const GRID = [
  [7, 8, 9],
  [4, 5, 6],
  [1, 2, 3],
  [null, 0, null],
];

/**
 * Calculate which number is at a given touch point.
 * Returns null if touch is in gap or outside valid cells.
 */
export function getNumAtPoint(
  clientX: number,
  clientY: number,
  padRect: DOMRect
): number | null {
  const relX = clientX - padRect.left - PADDING;
  const relY = clientY - padRect.top - PADDING - 24; // -24 for indicator

  if (relX < 0 || relY < 0) return null;

  // Calculate column (0-2)
  const colWithGap = relX / (CELL_WIDTH + GAP);
  const col = Math.floor(colWithGap);
  const colFraction = colWithGap - col;

  // Check if we're in the gap
  if (col >= 3) return null;
  if (colFraction > CELL_WIDTH / (CELL_WIDTH + GAP)) return null;

  // Calculate row (0-3)
  const rowWithGap = relY / (CELL_HEIGHT + GAP);
  const row = Math.floor(rowWithGap);
  const rowFraction = rowWithGap - row;

  // Check if we're in the gap
  if (row >= 4) return null;
  if (rowFraction > CELL_HEIGHT / (CELL_HEIGHT + GAP)) return null;

  // Get the number from grid
  const num = GRID[row]?.[col];
  return num ?? null;
}

export function NumPad({
  onNumber,
  onClose,
  modifiers,
}: NumPadProps): React.ReactElement {
  const [activeNum, setActiveNum] = useState<number | null>(null);
  const padRef = useRef<HTMLDivElement>(null);

  // Handle touch start - detect initial number for tap support
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (!padRef.current) return;

    const touch = e.touches[0];
    const rect = padRef.current.getBoundingClientRect();
    const num = getNumAtPoint(touch.clientX, touch.clientY, rect);

    setActiveNum(num);
    if (num !== null) {
      triggerHaptic(5);
    }
  }, []);

  // Handle touch move - update selection as finger moves
  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (!padRef.current) return;

      const touch = e.touches[0];
      const rect = padRef.current.getBoundingClientRect();
      const num = getNumAtPoint(touch.clientX, touch.clientY, rect);

      if (num !== activeNum) {
        setActiveNum(num);
        if (num !== null) {
          triggerHaptic(5);
        }
      }
    },
    [activeNum]
  );

  // Handle touch end - send the number
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (activeNum !== null) {
        triggerHaptic(8);
        onNumber(activeNum);
      }
      setActiveNum(null);
      onClose();
    },
    [activeNum, onNumber, onClose]
  );

  // Handle click for mouse users
  const handleClick = useCallback(
    (num: number) => {
      triggerHaptic(8);
      onNumber(num);
      onClose();
    },
    [onNumber, onClose]
  );

  // Handle backdrop click to close
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // Get modifier indicator text
  const modifierText = modifiers
    ? [
        modifiers.ctrl && 'Ctrl',
        modifiers.shift && 'Shift',
        modifiers.alt && 'Alt',
      ]
        .filter(Boolean)
        .join('+')
    : '';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
      }}
      onClick={handleBackdropClick}
    >
      {/* NumPad container */}
      <div
        ref={padRef}
        className="bg-[var(--gs-bg-elevated)] rounded-xl shadow-2xl border border-[var(--gs-border)]"
        style={{
          width: PAD_WIDTH,
          padding: PADDING,
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Active number indicator */}
        <div
          className="text-center text-lg font-mono text-[var(--gs-text)] mb-2"
          style={{ height: 24 }}
        >
          {activeNum !== null ? (
            <span>
              {modifierText && (
                <span className="text-[var(--gs-accent)]">{modifierText}+</span>
              )}
              {activeNum}
            </span>
          ) : (
            <span className="text-[var(--gs-text-dim)]">
              {modifierText ? `${modifierText}+` : 'Tap a number'}
            </span>
          )}
        </div>

        {/* Number grid */}
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(3, ${CELL_WIDTH}px)`,
            gap: GAP,
          }}
        >
          {GRID.flat().map((num, idx) => (
            <NumKey
              key={idx}
              num={num}
              active={activeNum === num}
              onClick={num !== null ? () => handleClick(num) : undefined}
            />
          ))}
        </div>
      </div>

      {/* Instructions */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 text-[var(--gs-text-dim)] text-sm">
        Tap number • Tap outside to close
      </div>
    </div>
  );
}

// Number key component
interface NumKeyProps {
  num: number | null;
  active: boolean;
  onClick?: () => void;
}

function NumKey({ num, active, onClick }: NumKeyProps): React.ReactElement {
  if (num === null) {
    // Empty cell
    return <div style={{ width: CELL_WIDTH, height: CELL_HEIGHT }} />;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        rounded-lg font-mono text-xl font-medium
        transition-all duration-75 active:scale-95
        ${
          active
            ? 'bg-[var(--gs-accent)] text-[var(--gs-text-on-accent)] shadow-glow'
            : 'bg-[var(--gs-btn-secondary-bg)] text-[var(--gs-text)] hover:bg-[var(--gs-border)]'
        }
      `}
      style={{
        width: CELL_WIDTH,
        height: CELL_HEIGHT,
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {num}
    </button>
  );
}
