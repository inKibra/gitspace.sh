/** @jsxImportSource react */
import { useEffect, useState, type ReactElement } from 'react';
import type { SessionBackend } from '../session/backend.js';
import type { WorkspaceNote } from '../types/workspace.js';
import { renderMarkdownHtml } from './markdown-render.js';

/**
 * Single note as a DOCK TAB (mock: NoteView — "opened as a tab from the
 * sidebar Notes list"). Write | Preview modes; markdown body persisted through
 * the workspace-notes backend. `noteId === null` composes a new note.
 */
export function NotePanel({ backend, projectName, workspaceName, noteId, onCreated }: {
  backend: SessionBackend | null;
  projectName: string;
  workspaceName: string;
  noteId: string | null;
  /** New-note flow: called with the created note id so the tab can re-key. */
  onCreated?: (note: WorkspaceNote) => void;
}): ReactElement {
  const [body, setBody] = useState<string>('# New note\n\nWrite agent-readable markdown…');
  const [mode, setMode] = useState<'write' | 'preview'>(noteId ? 'preview' : 'write');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(noteId ? 'loading' : 'ready');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(noteId);

  useEffect(() => {
    if (!noteId) return;
    let alive = true;
    backend?.listWorkspaceNotes?.(projectName, workspaceName)
      .then((notes) => {
        if (!alive) return;
        const note = notes.find((n) => n.id === noteId);
        if (!note) { setState('error'); return; }
        setBody(note.body);
        setState('ready');
      })
      .catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [backend, projectName, workspaceName, noteId]);

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      if (currentId) {
        await backend?.updateWorkspaceNote?.(projectName, workspaceName, currentId, body);
      } else {
        const created = await backend?.addWorkspaceNote?.(projectName, workspaceName, body);
        if (created) { setCurrentId(created.id); onCreated?.(created); }
      }
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const title = body.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 60) || 'New note';

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-3 py-1.5">
        <span className="text-[var(--gs-text-ghost)]">✎</span>
        <span className="truncate text-[var(--gs-text)]">{title}</span>
        <span className="text-[10px] text-[var(--gs-text-ghost)]">agent-readable · markdown</span>
        <span className="ml-auto flex items-center gap-1 text-[11px]">
          <button type="button" onClick={() => setMode('write')} className={`rounded px-2 py-0.5 ${mode === 'write' ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)]'}`}>Write</button>
          <button type="button" onClick={() => setMode('preview')} className={`rounded px-2 py-0.5 ${mode === 'preview' ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-dim)]'}`}>Preview</button>
          {dirty && (
            <button type="button" onClick={() => void save()} disabled={saving} className="ml-1 border border-[#1f4a2f] px-2 py-0.5 text-[var(--gs-accent)] disabled:opacity-40">
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {state === 'loading' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-dim)]">Loading…</div>
        ) : state === 'error' ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-danger)]">Note not found.</div>
        ) : mode === 'write' ? (
          <textarea
            value={body}
            onChange={(e) => { setBody(e.target.value); setDirty(true); }}
            className="h-full w-full resize-none bg-[var(--gs-bg)] p-3 font-[family-name:var(--gs-font-mono)] text-[12px] leading-[1.6] text-[var(--gs-text)] outline-none"
          />
        ) : (
          <div className="gs-block-md max-w-[860px] p-3" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(body) }} />
        )}
      </div>
    </div>
  );
}
