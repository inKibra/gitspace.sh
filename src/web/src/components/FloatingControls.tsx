import React, { useCallback } from 'react';
import { triggerHaptic } from '../utils/device';
import { FloatingJogWheel } from './FloatingJogWheel';

export interface FloatingControlsProps {
  /** Callback to send data to terminal */
  onSendData: (data: string) => void;
  /** Whether to show the jog wheel (arrow keys) */
  showJogWheel?: boolean;
}

// Escape sequences for navigation keys
const PAGE_UP = '\x1b[5~'; // CSI 5 ~
const PAGE_DOWN = '\x1b[6~'; // CSI 6 ~

/**
 * Floating controls for mobile terminal navigation.
 * Appears when keyboard is hidden on mobile devices.
 *
 * Always shows: PgUp/PgDn buttons
 * Conditionally shows: Jog wheel (when showJogWheel is true)
 */
export function FloatingControls({
  onSendData,
  showJogWheel = false,
}: FloatingControlsProps): React.ReactElement {
  const handlePageUp = useCallback(() => {
    triggerHaptic(5);
    onSendData(PAGE_UP);
  }, [onSendData]);

  const handlePageDown = useCallback(() => {
    triggerHaptic(5);
    onSendData(PAGE_DOWN);
  }, [onSendData]);

  return (
    <>
      {/* Page Up/Down buttons - bottom left */}
      <div
        className="fixed z-50 flex flex-col gap-2"
        style={{
          bottom: 'calc(24px + env(safe-area-inset-bottom, 0px))',
          left: 24,
        }}
      >
        <FloatingButton
          label="PgUp"
          onPress={handlePageUp}
          title="Page Up"
        />
        <FloatingButton
          label="PgDn"
          onPress={handlePageDown}
          title="Page Down"
        />
      </div>

      {/* Jog wheel - bottom right (only when in input mode) */}
      {showJogWheel && <FloatingJogWheel onDirection={onSendData} />}
    </>
  );
}

// Floating button component
interface FloatingButtonProps {
  label: string;
  onPress: () => void;
  title?: string;
}

function FloatingButton({
  label,
  onPress,
  title,
}: FloatingButtonProps): React.ReactElement {
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      onPress();
    },
    [onPress]
  );

  return (
    <button
      type="button"
      onClick={onPress}
      onTouchEnd={handleTouchEnd}
      title={title}
      className="
        px-3 py-2 rounded-lg text-xs font-medium
        bg-[#161b22]/90 text-[#e6edf3] border border-[#30363d]
        active:bg-[#22c55e] active:text-[#0d1117] active:border-[#22c55e]
        transition-all duration-75 active:scale-95
      "
      style={{
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
        minWidth: 48,
        minHeight: 40,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {label}
    </button>
  );
}
