import { useState } from 'react';
import { notesList } from '../data/mock';
import { Md } from '../Md';

// single note (markdown) — opened as a tab from the sidebar Notes list
export function NoteView({ noteId }: { noteId: string }) {
  const idx = Number(noteId);
  const existing = Number.isInteger(idx) ? notesList[idx] : undefined;
  const [body, setBody] = useState(existing?.body ?? '# New note\n\nWrite agent-readable markdown…');
  const [mode, setMode] = useState<'write' | 'preview'>(existing ? 'preview' : 'write');
  const title = existing?.title ?? 'New note';
  return (
    <div className="noteview">
      <div className="noteview-h">
        <span className="noteview-t">{title}</span>
        <span className="ns dim">agent-readable · markdown</span>
        <span className="noteview-modes">
          <button className={mode === 'write' ? 'on' : ''} onClick={() => setMode('write')}>Write</button>
          <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>Preview</button>
        </span>
      </div>
      <div className="noteview-b">
        {mode === 'write'
          ? <textarea className="noteview-ta" value={body} onChange={(e) => setBody(e.target.value)} />
          : <div className="noteview-prev"><Md>{body}</Md></div>}
      </div>
    </div>
  );
}
