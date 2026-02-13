import React, { useCallback, useRef, useState, useEffect } from 'react';
import { triggerHaptic } from '../utils/device.web';
import { getDirectionAndDistance, type Direction } from './DPad.web';

export interface FloatingJogWheelProps {
  /** Callback when a direction is triggered - sends escape sequence */
  onDirection: (data: string) => void;
}

// Constants for jog wheel behavior (matching D-Pad)
const JOYSTICK_RADIUS = 50; // Visual radius of the jog wheel
const REPEAT_INITIAL_DELAY = 250; // ms before repeat starts
const REPEAT_MIN_INTERVAL = 100; // ms fastest repeat rate
const REPEAT_MAX_INTERVAL = 400; // ms slowest repeat rate

// Arrow key escape sequences
const ARROW_SEQUENCES: Record<Direction, string> = {
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
};

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

/**
 * Floating jog wheel for terminal navigation.
 * Appears in bottom-right when input mode is on but keyboard is hidden.
 * 4-direction joystick that sends arrow keys with auto-repeat.
 */
export function FloatingJogWheel({ onDirection }: FloatingJogWheelProps): React.ReactElement {
  // Touch tracking state
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);
  const [currentDirection, setCurrentDirection] = useState<Direction | null>(null);
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
        onDirection(ARROW_SEQUENCES[currentDirectionRef.current]);
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
    e.stopPropagation();
    const touch = e.touches[0];
    setTouchStart({ x: touch.clientX, y: touch.clientY });
    setJoystickOffset({ x: 0, y: 0 });
  }, []);

  // Handle touch move
  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
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

      const { direction, distance: dirDistance } = getDirectionAndDistance(dx, dy);
      distanceRef.current = dirDistance;

      if (direction !== currentDirectionRef.current) {
        // Direction changed
        currentDirectionRef.current = direction;
        setCurrentDirection(direction);

        if (direction) {
          triggerHaptic(8);
          onDirection(ARROW_SEQUENCES[direction]);
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
      e.stopPropagation();
      clearRepeat();
      currentDirectionRef.current = null;
      setCurrentDirection(null);
      setTouchStart(null);
      setJoystickOffset({ x: 0, y: 0 });
    },
    [clearRepeat]
  );

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clearRepeat();
    };
  }, [clearRepeat]);

  return (
    <div
      className="fixed z-50 flex items-center justify-center"
      style={{
        bottom: 'calc(24px + env(safe-area-inset-bottom, 0px))',
        right: 24,
        width: JOYSTICK_RADIUS * 2 + 40,
        height: JOYSTICK_RADIUS * 2 + 40,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {/* Outer ring */}
      <div
        className="absolute rounded-full border-2 border-[#30363d] bg-[#161b22]/90"
        style={{
          width: JOYSTICK_RADIUS * 2,
          height: JOYSTICK_RADIUS * 2,
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      />

      {/* Direction indicators */}
      <DirectionIndicator direction="up" active={currentDirection === 'up'} />
      <DirectionIndicator direction="down" active={currentDirection === 'down'} />
      <DirectionIndicator direction="left" active={currentDirection === 'left'} />
      <DirectionIndicator direction="right" active={currentDirection === 'right'} />

      {/* Center knob */}
      <div
        className="absolute rounded-full bg-[#22c55e] shadow-glow transition-transform duration-75"
        style={{
          width: 32,
          height: 32,
          transform: `translate(${joystickOffset.x * 0.5}px, ${joystickOffset.y * 0.5}px)`,
        }}
      />

      {/* Label */}
      <div className="absolute text-[10px] text-[#6e7681] whitespace-nowrap" style={{ bottom: -16 }}>
        Arrows
      </div>
    </div>
  );
}

// Direction indicator arrow component
interface DirectionIndicatorProps {
  direction: Direction;
  active: boolean;
}

function DirectionIndicator({ direction, active }: DirectionIndicatorProps): React.ReactElement {
  const arrows: Record<Direction, string> = {
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
  };

  // Positions relative to center
  const positions: Record<Direction, React.CSSProperties> = {
    up: { top: 0, left: '50%', transform: 'translateX(-50%)' },
    down: { bottom: 0, left: '50%', transform: 'translateX(-50%)' },
    left: { left: 0, top: '50%', transform: 'translateY(-50%)' },
    right: { right: 0, top: '50%', transform: 'translateY(-50%)' },
  };

  return (
    <div
      className={`absolute text-lg font-bold transition-colors duration-75 ${
        active ? 'text-[#22c55e]' : 'text-[#30363d]'
      }`}
      style={{
        ...positions[direction],
        width: 20,
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {arrows[direction]}
    </div>
  );
}
