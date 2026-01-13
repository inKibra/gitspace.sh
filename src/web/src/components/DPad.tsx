import React, { useCallback, useRef, useEffect, useState } from 'react';
import { triggerHaptic } from '../utils/device';

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface DPadProps {
  /** Callback when a direction is triggered */
  onDirection: (direction: Direction) => void;
  /** Callback to close the D-Pad */
  onClose: () => void;
  /** Current modifier state for display */
  modifiers?: {
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
  };
}

// Constants for joystick behavior
const DEAD_ZONE = 15; // Pixels from center before direction registers
const JOYSTICK_RADIUS = 70; // Visual radius of the joystick ring
const REPEAT_INITIAL_DELAY = 250; // ms before repeat starts
const REPEAT_MIN_INTERVAL = 100; // ms fastest repeat rate
const REPEAT_MAX_INTERVAL = 400; // ms slowest repeat rate

/**
 * Calculate direction and distance from center point.
 * Returns null direction if within dead zone.
 */
export function getDirectionAndDistance(
  dx: number,
  dy: number
): { direction: Direction | null; distance: number } {
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < DEAD_ZONE) {
    return { direction: null, distance: 0 };
  }

  // Calculate angle in degrees (-180 to 180)
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  // Map angle to 4-way direction
  // Right: -45 to 45
  // Down: 45 to 135
  // Left: 135 to 180 or -180 to -135
  // Up: -135 to -45
  let direction: Direction;
  if (angle >= -45 && angle < 45) {
    direction = 'right';
  } else if (angle >= 45 && angle < 135) {
    direction = 'down';
  } else if (angle >= 135 || angle < -135) {
    direction = 'left';
  } else {
    direction = 'up';
  }

  return { direction, distance };
}

/**
 * Calculate repeat interval based on distance from center.
 * Further from center = faster repeat.
 */
function getRepeatInterval(distance: number): number {
  const maxDistance = JOYSTICK_RADIUS;
  const normalizedDistance = Math.min(distance / maxDistance, 1);

  // Interpolate between max and min interval
  return (
    REPEAT_MAX_INTERVAL -
    (REPEAT_MAX_INTERVAL - REPEAT_MIN_INTERVAL) * normalizedDistance
  );
}

export function DPad({
  onDirection,
  onClose,
  modifiers,
}: DPadProps): React.ReactElement {
  // Touch tracking state
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(
    null
  );
  const [currentDirection, setCurrentDirection] = useState<Direction | null>(
    null
  );
  const [joystickOffset, setJoystickOffset] = useState({ x: 0, y: 0 });

  // Refs for repeat handling
  const repeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentDirectionRef = useRef<Direction | null>(null);
  const distanceRef = useRef(0);

  // Clear repeat timer
  const clearRepeat = useCallback(() => {
    if (repeatTimerRef.current) {
      clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
  }, []);

  // Start repeat for a direction
  const startRepeat = useCallback(() => {
    clearRepeat();

    const scheduleNext = () => {
      if (currentDirectionRef.current) {
        onDirection(currentDirectionRef.current);
        triggerHaptic(5);

        const interval = getRepeatInterval(distanceRef.current);
        repeatTimerRef.current = setTimeout(scheduleNext, interval);
      }
    };

    // Initial delay before repeat starts
    repeatTimerRef.current = setTimeout(scheduleNext, REPEAT_INITIAL_DELAY);
  }, [clearRepeat, onDirection]);

  // Handle touch start
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    const touch = e.touches[0];
    setTouchStart({ x: touch.clientX, y: touch.clientY });
    setJoystickOffset({ x: 0, y: 0 });
  }, []);

  // Handle touch move
  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (!touchStart) return;

      const touch = e.touches[0];
      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;

      // Clamp offset to joystick radius
      const distance = Math.sqrt(dx * dx + dy * dy);
      const clampedDistance = Math.min(distance, JOYSTICK_RADIUS);
      const scale = distance > 0 ? clampedDistance / distance : 0;

      setJoystickOffset({
        x: dx * scale,
        y: dy * scale,
      });

      const { direction, distance: dirDistance } = getDirectionAndDistance(
        dx,
        dy
      );
      distanceRef.current = dirDistance;

      if (direction !== currentDirectionRef.current) {
        // Direction changed
        currentDirectionRef.current = direction;
        setCurrentDirection(direction);

        if (direction) {
          triggerHaptic(8);
          onDirection(direction);
          startRepeat();
        } else {
          clearRepeat();
        }
      }
    },
    [touchStart, onDirection, startRepeat, clearRepeat]
  );

  // Handle touch end
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      clearRepeat();
      currentDirectionRef.current = null;
      setCurrentDirection(null);
      setTouchStart(null);
      setJoystickOffset({ x: 0, y: 0 });
      onClose();
    },
    [clearRepeat, onClose]
  );

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clearRepeat();
    };
  }, [clearRepeat]);

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
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Joystick visualization */}
      <div
        className="relative"
        style={{
          width: JOYSTICK_RADIUS * 2 + 40,
          height: JOYSTICK_RADIUS * 2 + 40,
        }}
      >
        {/* Outer ring */}
        <div
          className="absolute rounded-full border-2 border-[#585b70]"
          style={{
            width: JOYSTICK_RADIUS * 2,
            height: JOYSTICK_RADIUS * 2,
            left: 20,
            top: 20,
          }}
        />

        {/* Direction indicators */}
        <DirectionIndicator
          direction="up"
          active={currentDirection === 'up'}
          radius={JOYSTICK_RADIUS}
        />
        <DirectionIndicator
          direction="down"
          active={currentDirection === 'down'}
          radius={JOYSTICK_RADIUS}
        />
        <DirectionIndicator
          direction="left"
          active={currentDirection === 'left'}
          radius={JOYSTICK_RADIUS}
        />
        <DirectionIndicator
          direction="right"
          active={currentDirection === 'right'}
          radius={JOYSTICK_RADIUS}
        />

        {/* Center knob (40px wide, centered in the ring) */}
        <div
          className="absolute rounded-full bg-[#89b4fa] shadow-lg transition-transform duration-75"
          style={{
            width: 40,
            height: 40,
            left: JOYSTICK_RADIUS + joystickOffset.x,
            top: JOYSTICK_RADIUS + joystickOffset.y,
          }}
        />

        {/* Dead zone indicator */}
        <div
          className="absolute rounded-full border border-[#45475a]"
          style={{
            width: DEAD_ZONE * 2,
            height: DEAD_ZONE * 2,
            left: JOYSTICK_RADIUS + 20 - DEAD_ZONE,
            top: JOYSTICK_RADIUS + 20 - DEAD_ZONE,
          }}
        />
      </div>

      {/* Modifier indicator */}
      {modifierText && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-[#313244] text-[#cdd6f4] text-sm">
          {modifierText}+Arrow
        </div>
      )}

      {/* Instructions */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 text-[#6c7086] text-sm">
        Drag to move • Release to close
      </div>
    </div>
  );
}

// Direction indicator arrow component (memoized to prevent re-renders during joystick movement)
interface DirectionIndicatorProps {
  direction: Direction;
  active: boolean;
  radius: number;
}

const DirectionIndicator = React.memo(function DirectionIndicator({
  direction,
  active,
  radius,
}: DirectionIndicatorProps): React.ReactElement {
  const arrows: Record<Direction, string> = {
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
  };

  // Positions relative to container (radius + padding offset - half indicator width)
  const positions: Record<Direction, { x: number; y: number }> = {
    up: { x: radius + 8, y: -5 },
    down: { x: radius + 8, y: radius * 2 + 20 },
    left: { x: -5, y: radius + 8 },
    right: { x: radius * 2 + 20, y: radius + 8 },
  };

  const pos = positions[direction];

  return (
    <div
      className={`absolute text-xl font-bold transition-colors duration-75 ${
        active ? 'text-[#89b4fa]' : 'text-[#585b70]'
      }`}
      style={{
        left: pos.x,
        top: pos.y,
        width: 24,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {arrows[direction]}
    </div>
  );
});

