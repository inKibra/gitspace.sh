// Small pieces a ghost draws in several places: its glyph, a citation chip, and inline text with `code` and **bold**.
import { Tooltip } from '@gitspace/ui';
import type { GhostCite } from '@gitspace/protocol-runtime';
import { File02, MessageTextSquare01 } from '@untitledui/icons';

/** The ghost's tint: a soft lavender, kept off the product's blue (selection) and violet (upstream). */
export const GHOST = '#9a8cff';
export const AMBER = '#f59e0b';

/** There is no ghost in the icon set: a rounded sheet with a hem and two eyes, drawn on the same 24px grid. */
export function GhostGlyph({ size = 16, className }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" className={className} aria-hidden>
    <path d="M5 20.5V11a7 7 0 0 1 14 0v9.5l-2.33-1.75-2.34 1.75L12 18.75l-2.33 1.75-2.34-1.75L5 20.5Z" />
    <circle cx="9.5" cy="11" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="11" r="1.1" fill="currentColor" stroke="none" />
  </svg>;
}

/** `#118`, `#93–117`, `plan.md:19–20`. */
export function citeLabel(cite: GhostCite): string {
  if (cite.kind === 'entry') return cite.to === undefined ? `#${cite.from}` : `#${cite.from}–${cite.to}`;
  const name = decodeURIComponent(cite.url.split('/').at(-1) ?? cite.url);
  return cite.lines ? `${name}:${cite.lines[0] === cite.lines[1] ? cite.lines[0] : `${cite.lines[0]}–${cite.lines[1]}`}` : name;
}

/** A citation: an entry (#118, #93–117) or a drive file's lines. Clicking shows it in the workspace. */
export function CiteChip({ cite, onCite }: { cite: GhostCite; onCite(cite: GhostCite): void }) {
  const Icon = cite.kind === 'entry' ? MessageTextSquare01 : File02;
  const label = citeLabel(cite);
  const preview = cite.kind === 'entry'
    ? `Show ${cite.to === undefined ? `entry ${cite.from}` : `entries ${cite.from}–${cite.to}`} in the transcript`
    : `Open ${label} in the Drive${cite.generation === null ? '' : ` · the ghost read generation ${cite.generation}`}`;
  return <Tooltip content={<span className="block max-w-[280px] whitespace-normal">{preview}</span>} side="top">
    <button type="button" onClick={() => onCite(cite)} data-cite={label} aria-label={preview}
      className="ghost-chip mx-0.5 inline-flex h-[19px] translate-y-[-1px] items-center gap-1 rounded-full px-1.5 align-middle font-mono text-[10.5px] font-medium leading-none transition-colors">
      <Icon width={11} height={11} strokeWidth={1.75} className="shrink-0 opacity-80" />{label}
    </button>
  </Tooltip>;
}

/** Text with `code` and **bold**; a half-streamed marker still renders as what it will become. */
export function Inline({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]*`?|\*\*[^*\n]*(?:\*\*)?)/u).map((piece, index) => {
    if (piece.startsWith('`')) return <code key={index} className="rounded-[4px] bg-foreground/[0.07] px-1 py-px font-mono text-[0.88em]">{piece.replace(/`/gu, '')}</code>;
    if (piece.startsWith('**')) return <strong key={index} className="font-semibold">{piece.replace(/\*\*/gu, '')}</strong>;
    return piece;
  })}</>;
}
