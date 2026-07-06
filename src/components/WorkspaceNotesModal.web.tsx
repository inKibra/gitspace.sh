/** @jsxImportSource react */
import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceNote } from '../types/workspace.js';
import { MarkdownEditor, type MarkdownEditorMode } from './MarkdownEditor.web.js';
import { btnDanger, btnGhost, R_CARD, R_CHIP } from './ui/control.js';

export interface WorkspaceNotesModalProps {
  workspaceName: string;
  notes: WorkspaceNote[];
  selectedNoteId: string | null;
  draftBody: string;
  loading?: boolean;
  saving?: boolean;
  onSelectNote: (noteId: string) => void;
  onChangeDraftBody: (body: string) => void;
  onAddNote: () => void;
  onSaveNote: () => void | Promise<void>;
  onDeleteNote: () => void | Promise<void>;
  onClose: () => void;
}


import { deriveNoteLabel } from './note-label.js';

function toPreview(body: string): string {
  return body.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}


export function WorkspaceNotesModal({
  workspaceName,
  notes,
  selectedNoteId,
  draftBody,
  loading = false,
  saving = false,
  onSelectNote,
  onChangeDraftBody,
  onAddNote,
  onSaveNote,
  onDeleteNote,
  onClose,
}: WorkspaceNotesModalProps) {
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<MarkdownEditorMode>('split');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );

  const dirty = selectedNote ? draftBody !== selectedNote.body : draftBody.trim().length > 0;

  useEffect(() => { setConfirmingDelete(false); }, [selectedNoteId]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((note) =>
      deriveNoteLabel(note.body).toLowerCase().includes(q)
      || toPreview(note.body).toLowerCase().includes(q)
    );
  }, [notes, query]);

  const guard = (): boolean => !dirty || window.confirm('Discard unsaved changes to this note?');

  const selectNote = (noteId: string) => {
    if (noteId === selectedNoteId || guard()) onSelectNote(noteId);
  };
  const addNote = () => { if (guard()) onAddNote(); };
  const close = () => { if (guard()) onClose(); };

  return (
    <div className="gs-overlay-root" role="dialog" aria-label="Workspace notes" onClick={close}>
      <div className="absolute inset-0 gs-overlay-backdrop" />
      <div
        className="gs-shell-card gs-shell-card--wide"
        style={{ width: 'min(1120px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 48px)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gs-shell-header">
          <div className="min-w-0">
            <div className="gs-shell-kicker">Workspace notes</div>
            <div className="gs-shell-title truncate">Notes for {workspaceName}</div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs tabular-nums text-[var(--gs-text-dim)]">
              {loading ? 'Loading notes…' : `${notes.length} note${notes.length === 1 ? '' : 's'}`}
            </div>
            <button type="button" className="gs-chip-button" onClick={close}>Close</button>
          </div>
        </div>
        <div className="gs-shell-body p-0" style={{ minHeight: 560, display: 'grid', gridTemplateColumns: '320px 1fr' }}>
          <div className="flex min-h-0 flex-col border-r border-[var(--gs-border)] bg-[var(--gs-bg)]">
            <div className="sticky top-0 z-10 space-y-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg)] p-3">
              <input
                className="gs-field"
                placeholder="Search notes…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                type="button"
                onClick={addNote}
                disabled={saving}
                className={`flex w-full items-center justify-center gap-1.5 ${R_CHIP} border border-[var(--gs-accent)] bg-[var(--gs-accent-subtle)] px-3 py-2 text-sm font-medium text-[var(--gs-accent)] transition-[background-color,scale] duration-150 ease-out hover:bg-[var(--gs-highlight-bg)] active:scale-[0.98] disabled:opacity-40`}
              >
                + New note
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
              {filteredNotes.map((note) => {
                const active = note.id === selectedNoteId;
                return (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => selectNote(note.id)}
                    className={`w-full ${R_CARD} px-3 py-3 text-left transition-[background-color,box-shadow,color] duration-150 ${active ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)] shadow-[inset_3px_0_0_var(--gs-selected-border)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)] hover:text-[var(--gs-text)]'}`}
                  >
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm text-[var(--gs-text)]">{deriveNoteLabel(note.body)}</div>
                      {active && dirty && <span className="ml-auto flex-shrink-0 text-[var(--gs-warning)]" title="Unsaved changes">●</span>}
                    </div>
                    <div className="mt-1 line-clamp-2 text-xs text-[var(--gs-text-dim)]">{toPreview(note.body).slice(0, 120) || 'Empty note'}</div>
                    <div className="mt-2 text-[10px] uppercase tracking-[0.12em] tabular-nums text-[var(--gs-text-dim)]">Updated {formatDate(note.updatedAt)}</div>
                  </button>
                );
              })}
              {filteredNotes.length === 0 && (
                <div className="px-3 py-8 text-center text-xs text-[var(--gs-text-ghost)]">
                  {loading ? 'Loading notes…' : notes.length === 0 ? 'No notes yet. Create one to start.' : 'No notes match this search.'}
                </div>
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="border-b border-[var(--gs-border)] bg-[var(--gs-bg)] px-4 py-3">
              <div className="min-w-0 flex-1 truncate text-xs text-[var(--gs-text-dim)]">
                {selectedNote ? `${deriveNoteLabel(selectedNote.body)} · Updated ${formatDate(selectedNote.updatedAt)}` : loading ? 'Loading notes…' : 'No note selected'}
              </div>
            </div>
            <div className="min-h-0 flex-1 p-4">
              {selectedNote || draftBody ? (
                <MarkdownEditor
                  body={draftBody}
                  mode={viewMode}
                  dirty={dirty}
                  saving={saving}
                  emptyPreviewHtml="<p><em>Empty note.</em></p>"
                  onChange={onChangeDraftBody}
                  onModeChange={setViewMode}
                  onSave={selectedNote ? () => void onSaveNote() : undefined}
                  onDiscard={selectedNote ? () => onChangeDraftBody(selectedNote.body) : undefined}
                  minHeightPx={460}
                  rightActions={selectedNote ? (
                    confirmingDelete ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs text-[var(--gs-text-muted)]">Delete note?</span>
                        <button type="button" className={btnGhost()} onClick={() => setConfirmingDelete(false)}>Cancel</button>
                        <button type="button" className={btnDanger()} disabled={saving} onClick={() => { setConfirmingDelete(false); void onDeleteNote(); }}>Confirm</button>
                      </span>
                    ) : (
                      <button type="button" className={btnDanger()} disabled={saving} onClick={() => setConfirmingDelete(true)}>Delete</button>
                    )
                  ) : undefined}
                />
              ) : (
                <div className={`flex h-full items-center justify-center ${R_CARD} border border-dashed border-[var(--gs-border)] text-center text-xs text-[var(--gs-text-muted)]`}>
                  {loading ? 'Loading notes…' : 'Select a note on the left, or create a new one.'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
