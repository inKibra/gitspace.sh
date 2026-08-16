import React from 'react';
import { interpolate, Easing } from 'remotion';
import { T, MONO } from './theme';

/**
 * Kinetic VO captions: word-stagger pops (scale + rise + fade), frame-timed so
 * they can be retimed to the recorded voice over word-by-word. Muted viewers
 * read the VO; sounded viewers get reinforcement.
 */

export interface CapWord {
  w: string;
  at: number; // frame the word pops in
  color?: string;
  /** Stress. Underlined the way you'd underline a word you lean on saying it. */
  underline?: boolean;
}

export interface CapLine {
  words: CapWord[];
  out: number; // frame the whole line starts to exit
  y: number;
  size: number;
}

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const Word: React.FC<{ word: CapWord; frame: number; size: number }> = ({ word, frame, size }) => {
  const t = interpolate(frame, [word.at, word.at + 4], [0, 1], {
    ...clampOpts,
    easing: Easing.out(Easing.cubic),
  });
  if (t <= 0) return null;
  return (
    <span
      style={{
        display: 'inline-block',
        color: word.color ?? T.text,
        opacity: t,
        transform: `translateY(${(1 - t) * 16}px) scale(${1.22 - 0.22 * t})`,
        textShadow: '0 2px 14px rgba(0,0,0,0.95), 0 0 4px rgba(0,0,0,0.8)',
        fontWeight: word.underline ? 700 : 500,
        fontSize: size,
        // the rule sits under the word, not under the whole line, and matches
        // whatever colour the word is
        textDecoration: word.underline ? 'underline' : undefined,
        textDecorationThickness: word.underline ? 2 : undefined,
        textUnderlineOffset: word.underline ? 6 : undefined,
      }}
    >
      {word.w}
    </span>
  );
};

export const KineticCaptions: React.FC<{ frame: number; lines: CapLine[] }> = ({
  frame,
  lines,
}) => (
  <>
    {lines.map((line, li) => {
      const start = line.words[0]!.at;
      if (frame < start || frame > line.out + 8) return null;
      const exit = interpolate(frame, [line.out, line.out + 7], [1, 0], clampOpts);
      return (
        <div
          key={li}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: line.y,
            display: 'flex',
            justifyContent: 'center',
            gap: '0.4em',
            flexWrap: 'wrap',
            padding: '0 80px',
            fontFamily: MONO,
            fontSize: line.size,
            opacity: exit,
            transform: `translateY(${(1 - exit) * 10}px)`,
            zIndex: 200,
            pointerEvents: 'none',
          }}
        >
          {line.words.map((w, wi) => (
            <Word key={wi} word={w} frame={frame} size={line.size} />
          ))}
        </div>
      );
    })}
  </>
);
