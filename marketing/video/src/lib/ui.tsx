import React from 'react';
import { interpolate } from 'remotion';
import { T, stateColor, type AgentState } from './theme';

/** Characters revealed for a type-on effect. */
export const typed = (text: string, frame: number, start: number, cps = 1.6): string => {
  const n = Math.max(0, Math.floor((frame - start) * cps));
  return text.slice(0, n);
};

/** 0→1 fade-slide entrance. */
export const enter = (frame: number, start: number, dur = 12) =>
  interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

/** One-shot pulse (0→1→0) used for state-change glow. */
export const pulse = (frame: number, at: number, dur = 24): number => {
  if (frame < at || frame > at + dur) return 0;
  const t = (frame - at) / dur;
  return Math.sin(t * Math.PI);
};

/** Status pip: square, product-authentic. */
export const Pip: React.FC<{
  state: AgentState;
  size?: number;
  glow?: number; // 0..1 extra glow (pulse)
}> = ({ state, size = 14, glow = 0 }) => {
  const c = stateColor(state);
  const base = state === 'none' ? 0 : 0.55;
  return (
    <div
      style={{
        width: size,
        height: size,
        background: c,
        boxShadow: `0 0 ${8 + glow * 18}px ${c}${''}`,
        opacity: base + 0.45,
        filter: `brightness(${1 + glow * 0.4})`,
      }}
    />
  );
};

/** Blinking block caret. */
export const Caret: React.FC<{ frame: number; color?: string; height?: number }> = ({
  frame,
  color = T.accent,
  height = 22,
}) => (
  <span
    style={{
      display: 'inline-block',
      width: height * 0.55,
      height,
      background: color,
      verticalAlign: 'text-bottom',
      opacity: Math.floor(frame / 16) % 2 === 0 ? 1 : 0,
    }}
  />
);

/** macOS-style pointer cursor with click ring. */
export const Cursor: React.FC<{ x: number; y: number; click?: number /* 0..1 */ }> = ({
  x,
  y,
  click = 0,
}) => (
  <div style={{ position: 'absolute', left: x, top: y, zIndex: 100, pointerEvents: 'none' }}>
    {click > 0 && (
      <div
        style={{
          position: 'absolute',
          left: -14 - click * 18,
          top: -14 - click * 18,
          width: 28 + click * 36,
          height: 28 + click * 36,
          border: `2px solid ${T.text}`,
          borderRadius: '50%',
          opacity: (1 - click) * 0.8,
        }}
      />
    )}
    <svg width="34" height="34" viewBox="0 0 24 24" style={{ display: 'block' }}>
      <path
        d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L6.35 2.85a.5.5 0 0 0-.85.36Z"
        fill="#ffffff"
        stroke="#000000"
        strokeWidth="1.4"
      />
    </svg>
  </div>
);
