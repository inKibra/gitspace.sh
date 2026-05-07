/** @jsxImportSource react */
import { useMemo, useState } from 'react';
import type { WorkspaceNote } from '../types/workspace.js';

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

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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

function renderMarkdown(md: string): string {
  let html = escapeHtml(md);
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
  html = html.split(/\n{2,}/).map((block) => {
    if (block.startsWith('<h') || block.startsWith('<pre>') || block.startsWith('<ul>')) return block;
    return `<p>${block.replace(/\n/g, '<br />')}</p>`;
  }).join('');
  return html || '<p><em>Empty note.</em></p>';
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
  const [viewMode, setViewMode] = useState<'split' | 'edit' | 'preview'>('split');

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
          <div className="min-h-0 grid" style={{ gridTemplateRows: '56px 1fr' }}>
            <div className="flex items-center gap-3 px-4 border-b border-[var(--gs-border)] bg-[rgba(255,255,255,0.02)]">
              <div className="inline-flex rounded-lg border border-[var(--gs-border)] bg-[rgba(255,255,255,0.02)] p-1">
                <button type="button" className={`px-3 py-1.5 rounded-md text-xs ${viewMode === 'split' ? 'bg-[rgba(155,255,105,0.12)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`} onClick={() => setViewMode('split')}>Split</button>
                <button type="button" className={`px-3 py-1.5 rounded-md text-xs ${viewMode === 'edit' ? 'bg-[rgba(155,255,105,0.12)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`} onClick={() => setViewMode('edit')}>Edit</button>
                <button type="button" className={`px-3 py-1.5 rounded-md text-xs ${viewMode === 'preview' ? 'bg-[rgba(155,255,105,0.12)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`} onClick={() => setViewMode('preview')}>Preview</button>
              </div>
              <div className="min-w-0 flex-1 text-xs text-[var(--gs-text-dim)] truncate">
                {selectedNote ? `${deriveNoteLabel(selectedNote.body)} · Updated ${formatDate(selectedNote.updatedAt)}` : loading ? 'Loading notes…' : 'No note selected'}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="gs-chip-button"
                  style={{ color: 'var(--gs-danger-hover)', borderColor: 'rgba(255,107,95,0.25)', background: 'rgba(255,107,95,0.08)' }}
                  onClick={onDeleteNote}
                  disabled={!selectedNote || saving}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="gs-chip-button"
                  style={{ color: 'var(--gs-text)', borderColor: 'rgba(155,255,105,0.28)', background: 'rgba(155,255,105,0.10)' }}
                  onClick={() => void onSaveNote()}
                  disabled={!selectedNote || saving}
                >
                  {saving ? 'Saving…' : 'Save note'}
                </button>
              </div>
            </div>
            <div className={`grid min-h-0 ${viewMode === 'split' ? 'grid-cols-2' : viewMode === 'edit' ? 'grid-cols-[1fr_0]' : 'grid-cols-[0_1fr]'}`}>
              <div className={`min-h-0 overflow-hidden ${viewMode === 'preview' ? 'border-r-0' : 'border-r border-[var(--gs-border)]'}`}>
                <textarea
                  className="w-full h-full resize-none border-0 outline-none bg-[#0a0c09] text-[var(--gs-text)] p-5 font-mono text-xs leading-6"
                  value={draftBody}
                  onChange={(event) => onChangeDraftBody(event.target.value)}
                />
              </div>
              <div className="min-h-0 overflow-auto bg-[#0b0d0a] px-6 py-5 text-[var(--gs-text)] leading-7">
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(draftBody) }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
