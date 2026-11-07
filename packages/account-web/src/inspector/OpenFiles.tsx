import { Button } from '@gitspace/ui';
import { ArrowLeft, FileCode02, HardDrive, XClose } from '@untitledui/icons';
import type { ReactNode } from 'react';

/** A file open in the strip Files and Drive share: a repository file, a drive file, or a resource a link named. */
export interface InspectorOpenDocument {
  id: string;
  kind: 'file' | 'artifact' | 'resource';
  label: string;
  target: string;
}
/** The open strip: its documents, the one shown, and whether the side Inspector shows it (true) or the tab's browser. */
export interface OpenFiles {
  items: readonly InspectorOpenDocument[];
  active: string | null;
  viewing: boolean;
}

/** Repository files and `repo://` resources belong to Files; everything else to Drive. */
export function fromRepository(document: InspectorOpenDocument): boolean {
  return document.kind === 'file' || (document.kind === 'resource' && document.target.startsWith('repo://'));
}

/** Opens a document into the strip, or shows it if it is already there. */
export function openInStrip(state: OpenFiles, document: InspectorOpenDocument): OpenFiles {
  const items = state.items.some((item) => item.id === document.id) ? state.items : [...state.items, document];
  return { items, active: document.id, viewing: true };
}

/** Closes a document; closing the shown one shows its neighbour, closing the last returns to the browser. */
export function closeInStrip(state: OpenFiles, id: string): OpenFiles {
  const index = state.items.findIndex((item) => item.id === id);
  const items = state.items.filter((item) => item.id !== id);
  const active = state.active === id ? (items[Math.min(index, items.length - 1)]?.id ?? null) : state.active;
  return { items, active, viewing: state.viewing && active !== null };
}

export function OpenFilesStrip({ state, onShow, onClose }: { state: OpenFiles; onShow(id: string): void; onClose(id: string): void }) {
  return <div role="tablist" aria-label="Open files" className="flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
    {state.items.map((item) => {
      const selected = item.id === state.active;
      const Icon = fromRepository(item) ? FileCode02 : HardDrive;
      const name = item.label.split('/').at(-1) ?? item.label;
      return <span key={item.id} role="tab" aria-selected={selected} data-open-file={item.id} className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-caption ${selected ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover'}`}>
        <button type="button" className="inline-flex items-center gap-1.5" title={item.kind === 'artifact' ? item.label : item.target} onClick={() => onShow(item.id)}>
          <Icon width={12} height={12} strokeWidth={1.75} />
          <span className="max-w-48 truncate font-mono">{name}</span>
        </button>
        <button type="button" aria-label={`Close ${name}`} onClick={() => onClose(item.id)} className="flex size-5 items-center justify-center rounded hover:bg-hover"><XClose width={11} height={11} strokeWidth={2} /></button>
      </span>;
    })}
  </div>;
}

/** The Files or Drive tab: its browser and the shared strip. Beside the conversation an open document replaces the
 * browser until Back; at full width the browser stays on the left and the document shows on the right. The browser
 * stays mounted either way, so its folders, filters and scroll survive. */
export function OpenFilesLayout({ full, viewing, home, strip, browser, document, onBack }: {
  full: boolean;
  viewing: boolean;
  home: string;
  strip: ReactNode;
  browser: ReactNode;
  /** The shown document, or null when none is shown here. */
  document: ReactNode;
  onBack(): void;
}) {
  const replaced = viewing && !full;
  return <div className={full ? 'grid min-h-0 flex-1 grid-cols-[24rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]' : 'flex min-h-0 flex-1 flex-col'}>
    <div className={full ? 'col-start-2 row-start-1 flex min-h-0 min-w-0 flex-col' : replaced ? 'flex min-h-0 flex-1 flex-col' : 'flex shrink-0 flex-col'}>
      {replaced ? <Button variant="ghost" size="compact" className="mx-2 mt-2 self-start" onClick={onBack}><ArrowLeft width={14} height={14} strokeWidth={1.5} />{home}</Button> : null}
      {strip}
      {full || replaced ? document ?? <p className="px-4 pt-10 text-center text-caption text-muted-foreground">Open a file from the repository or the drive. Files and Drive share these tabs.</p> : null}
    </div>
    <div hidden={replaced} className={full ? 'col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col border-r border-border' : replaced ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>{browser}</div>
  </div>;
}
