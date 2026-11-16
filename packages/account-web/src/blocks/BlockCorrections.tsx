// The blocks of an agent message that the agent corrected in place after it was sent (`MessageBlock.corrected`): each
// draws with a small "corrected" mark whose tooltip lists what was wrong. This module stays free of the block code, so
// Markdown without blocks does not load it.
import { createContext, useContext } from 'react';
import type { BlockCorrection } from '@gitspace/blocks';

/** The message's corrected blocks by their trimmed fence body, which is what a fence renderer is given
 * (`MessageBlockCorrections`). */
export const BlockCorrections = createContext<ReadonlyMap<string, BlockCorrection>>(new Map());

/** The mark of a fence whose body is a corrected block of the message drawn around it; nothing for any other. */
export function CorrectedMark({ code }: { code: string }) {
  const correction = useContext(BlockCorrections).get(code.trim());
  if (!correction) return null;
  const title = `Corrected after it was sent. It had:\n${correction.issues.map(issue => `• ${issue}`).join('\n')}`;
  return <div className="flex justify-end"><span data-block-corrected="" title={title} aria-label={title} className="cursor-default rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground">corrected</span></div>;
}
