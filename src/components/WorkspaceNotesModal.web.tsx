/** @jsxImportSource react */
import { useMemo, useState } from 'react';
import type { WorkspaceNote } from '../types/workspace.js';
import { MarkdownEditor, type MarkdownEditorMode } from './MarkdownEditor.web.js';

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


function deriveNoteLabel(body: string): string {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => line.startsWith('#'));
  const raw = heading ? heading.replace(/^#+\s*/, '') : (lines[0] ?? 'Untitled note');
  return raw.length > 56 ? `${raw.slice(0, 56)}…` : raw;
}

function toPreview(body: string): string {
  return body.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((note) =>
      deriveNoteLabel(note.body).toLowerCase().includes(q)
      || toPreview(note.body).toLowerCase().includes(q)
    );
  }, [notes, query]);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? null,
    [notes, selectedNoteId],
  );

  return (
    <div className="gs-overlay-root" role="dialog" aria-label="Workspace notes" onClick={onClose}>
      <div className="absolute inset-0 gs-overlay-backdrop" />
      <div
        className="gs-shell-card gs-shell-card--wide"
        style={{ width: 'min(1120px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 48px)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gs-shell-header">
          <div>
            <div className="gs-shell-kicker">Workspace notes</div>
            <div className="gs-shell-title">Notes for {workspaceName}</div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-[var(--gs-text-dim)]">
              {loading ? 'Loading notes…' : `${notes.length} note${notes.length === 1 ? '' : 's'}`}
            </div>
            <button type="button" className="gs-chip-button" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="gs-shell-body p-0" style={{ minHeight: 560, display: 'grid', gridTemplateColumns: '320px 1fr' }}>
          <div className="border-r border-[var(--gs-border)] bg-[rgba(255,255,255,0.02)] min-h-0 overflow-auto">
            <div className="p-3 border-b border-[rgba(255,255,255,0.04)] space-y-3 sticky top-0 bg-[rgba(13,16,14,0.96)] backdrop-blur">
              <input
                className="gs-field"
                placeholder="Search notes..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                type="button"
                className="w-full rounded-lg border border-[rgba(125,211,252,0.25)] bg-[rgba(125,211,252,0.08)] px-3 py-2 text-left text-sm text-[var(--gs-text)] hover:bg-[rgba(125,211,252,0.12)]"
                onClick={onAddNote}
                disabled={saving}
              >
                + New note
              </button>
            </div>
            <div className="p-2 space-y-1">
              {filteredNotes.map((note) => (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => onSelectNote(note.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${note.id === selectedNoteId ? 'border-[rgba(155,255,105,0.28)] bg-[rgba(155,255,105,0.08)] text-[var(--gs-text)] shadow-[inset_0_0_0_1px_rgba(155,255,105,0.08)]' : 'border-transparent text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] hover:bg-[rgba(255,255,255,0.03)]'}`}
                >
                  <div className="text-sm text-[var(--gs-text)]">{deriveNoteLabel(note.body)}</div>
                  <div className="mt-1 text-xs text-[var(--gs-text-dim)] line-clamp-2">{toPreview(note.body).slice(0, 120) || 'Empty note'}</div>
                  <div className="mt-2 text-[10px] uppercase tracking-[0.12em] text-[var(--gs-text-dim)]">Updated {formatDate(note.updatedAt)}</div>
                </button>
              ))}
              {filteredNotes.length === 0 ? (
                <div className="px-3 py-6 text-xs text-[var(--gs-text-ghost)]">
                  {loading ? 'Loading notes…' : 'No notes match this filter.'}
                </div>
              ) : null}
            </div>
          </div>
          <div className="min-h-0 flex flex-col">
            <div className="px-4 py-3 border-b border-[var(--gs-border)] bg-[rgba(255,255,255,0.02)]">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1 text-xs text-[var(--gs-text-dim)] truncate">
                  {selectedNote ? `${deriveNoteLabel(selectedNote.body)} · Updated ${formatDate(selectedNote.updatedAt)}` : loading ? 'Loading notes…' : 'No note selected'}
                </div>
                <button
                  type="button"
                  className="gs-chip-button"
                  style={{ color: 'var(--gs-danger-hover)', borderColor: 'rgba(255,107,95,0.25)', background: 'rgba(255,107,95,0.08)' }}
                  onClick={onDeleteNote}
                  disabled={!selectedNote || saving}
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 p-4">
              <MarkdownEditor
                body={draftBody}
                mode={viewMode}
                dirty={!!selectedNote}
                saving={saving}
                emptyPreviewHtml="<p><em>Empty note.</em></p>"
                onChange={onChangeDraftBody}
                onModeChange={setViewMode}
                onSave={selectedNote ? () => void onSaveNote() : undefined}
                minHeightPx={460}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
