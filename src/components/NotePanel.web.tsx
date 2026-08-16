/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { SessionBackend } from '../session/backend.js';
import type { WorkspaceNote } from '../types/workspace.js';
import { renderMarkdownHtml } from './markdown-render.js';
import { deriveNoteLabel } from './note-label.js';

const AUTOSAVE_DELAY_MS = 800;

/**
 * Single note as a DOCK TAB (mock: NoteView — "opened as a tab from the
 * sidebar Notes list"). Write | Preview modes; markdown body persisted through
 * the workspace-notes backend. `noteId === null` composes a new note.
 * Changes autosave (debounced + on blur/unmount); Delete lives behind the
 * '⋯' overflow menu with a two-step confirm.
 */
export function NotePanel({ backend, projectName, workspaceName, noteId, onCreated, onDeleted }: {
  backend: SessionBackend | null;
  projectName: string;
  workspaceName: string;
  noteId: string | null;
  /** New-note flow: called with the created note id so the tab can re-key. */
  onCreated?: (note: WorkspaceNote) => void;
  /** Called after a successful delete so the tab can close. */
  onDeleted?: () => void;
}): ReactElement {
  const [body, setBody] = useState<string>('# New note\n\nWrite agent-readable markdown…');
  const [mode, setMode] = useState<'write' | 'preview'>(noteId ? 'preview' : 'write');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(noteId ? 'loading' : 'ready');
  const [currentId, setCurrentId] = useState<string | null>(noteId);
  const [loadedTitle, setLoadedTitle] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const bodyRef = useRef(body);
  bodyRef.current = body;
  const currentIdRef = useRef<string | null>(noteId);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const remove = async (): Promise<void> => {
    if (!currentIdRef.current) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    dirtyRef.current = false;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    await backend?.removeWorkspaceNote?.(projectName, workspaceName, currentIdRef.current);
    onDeleted?.();
  };

  useEffect(() => {
    if (!noteId) return;
    let alive = true;
    backend?.listWorkspaceNotes?.(projectName, workspaceName)
      .then((notes) => {
        if (!alive) return;
        const note = notes.find((n) => n.id === noteId);
        if (!note) { setState('error'); return; }
        setBody(note.body);
        setLoadedTitle(deriveNoteLabel(note.body));
        setState('ready');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [backend, projectName, workspaceName, noteId]);

  const flushSave = useCallback(async (): Promise<void> => {
    if (!dirtyRef.current || savingRef.current) return;
    savingRef.current = true;
    try {
      if (currentIdRef.current) {
        await backend?.updateWorkspaceNote?.(projectName, workspaceName, currentIdRef.current, bodyRef.current);
      } else {
        const created = await backend?.addWorkspaceNote?.(projectName, workspaceName, bodyRef.current);
        if (created) { currentIdRef.current = created.id; setCurrentId(created.id); onCreated?.(created); }
      }
      dirtyRef.current = false;
    } finally {
      savingRef.current = false;
    }
  }, [backend, projectName, workspaceName, onCreated]);

  const flushRef = useRef(flushSave);
  flushRef.current = flushSave;

  // Autosave on unmount so nothing is lost when the tab closes.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void flushRef.current();
  }, []);

  const onEdit = (next: string): void => {
    setBody(next);
    dirtyRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { timerRef.current = null; void flushRef.current(); }, AUTOSAVE_DELAY_MS);
  };

  const title = (currentId && loadedTitle) || deriveNoteLabel(body) || 'New note';

  const segBtn = (m: 'write' | 'preview', label: string): ReactElement => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={`px-2.5 py-[3px] text-[11px] ${mode === m ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)]'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-[var(--gs-border)] bg-[#050505] px-3.5 py-2.5">
        <span className="truncate text-[13px] font-medium text-[var(--gs-text)]">{title}</span>
        <span className="text-[12px] text-[var(--gs-text-dim)]">agent-readable · markdown</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="inline-flex border border-[var(--gs-border)]">
            {segBtn('write', 'Write')}
            {segBtn('preview', 'Preview')}
          </span>
          {currentId && (
            <span className="relative">
              <button
                type="button"
                onClick={() => { setMenuOpen((v) => !v); setConfirmDelete(false); }}
                className={`px-1.5 py-[3px] text-[13px] leading-none ${menuOpen ? 'text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}
                aria-label="More actions"
              >
                ⋯
              </button>
              {menuOpen && (
                <span className="absolute right-0 top-full z-10 mt-1 flex min-w-[130px] flex-col border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] py-1">
                  <button
                    type="button"
                    onClick={() => void remove()}
                    className={`px-3 py-1 text-left text-[11px] ${confirmDelete ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-text-dim)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-danger)]'}`}
                  >
                    {confirmDelete ? 'Confirm delete' : 'Delete note'}
                  </button>
                </span>
              )}
            </span>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {state === 'loading' ? (
          <div className="px-4 py-3.5 text-[var(--gs-text-dim)]">Loading…</div>
        ) : state === 'error' ? (
          <div className="px-4 py-3.5 text-[var(--gs-text-dim)]">Note not found.</div>
        ) : mode === 'write' ? (
          <textarea
            value={body}
            onChange={(e) => onEdit(e.target.value)}
            onBlur={() => void flushRef.current()}
            className="h-full w-full resize-none bg-black px-4 py-3.5 font-[family-name:var(--gs-font)] text-[12.5px] leading-[1.6] text-[var(--gs-text)] outline-none"
          />
        ) : (
          <div className="gs-block-md px-[18px] py-3.5" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(body) }} />
        )}
      </div>
    </div>
  );
}
