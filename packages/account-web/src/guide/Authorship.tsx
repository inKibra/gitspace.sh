// Who made each part of a Change Guide, marked quietly: a filled dot for what the agent wrote (title, introduction,
// sections, notes, the map's areas and paths, its diagrams), a hollow ring for what GitSpace computed (the diff, the
// map's layout, read progress, acceptance). Hovering a mark says what it covers.
import { Tooltip, badgeColors } from '@gitspace/ui';

export type Author = 'agent' | 'gitspace';
const BY: Record<Author, string> = { agent: 'Written by the agent', gitspace: 'Computed by GitSpace' };

function Dot({ by }: { by: Author }) {
  return <span className="size-1.5 shrink-0 rounded-full" style={by === 'agent' ? { background: badgeColors.violet } : { boxShadow: 'inset 0 0 0 1.25px var(--muted-foreground)' }} />;
}

export function Source({ by, what }: { by: Author; what: string }) {
  return <Tooltip content={`${BY[by]} · ${what}`} side="top">
    <span tabIndex={0} role="note" aria-label={`${BY[by]}: ${what}`} data-source={by} className="inline-flex size-3 shrink-0 cursor-help items-center justify-center align-middle outline-none">
      <Dot by={by} />
    </span>
  </Tooltip>;
}

/** The one-line key to the marks. */
export function SourceLegend() {
  return <p className="flex flex-wrap items-center gap-x-3 text-caption text-muted-foreground">
    <span className="inline-flex items-center gap-1"><Dot by="agent" />written by the agent</span>
    <span className="inline-flex items-center gap-1"><Dot by="gitspace" />computed by GitSpace</span>
    <span>hover a mark for what</span>
  </p>;
}
