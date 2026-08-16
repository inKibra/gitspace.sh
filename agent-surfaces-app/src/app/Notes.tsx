import { useState } from 'react';
import { notesList } from '../data/mock';
import type { NoteItem } from '../data/mock';

// Shared notes list + editor — used by both the workspace Notes pane and the
// project home. Agent-readable notes; same display in both scopes.
export function Notes({ notes = notesList }: { notes?: NoteItem[] }) {
  const [sel, setSel] = useState(0);
  const note = notes[sel];
  return (
    <div className="npane">
      <div className="nlist">
        <button className="btn sm" style={{ width: '100%', justifyContent: 'flex-start' }}>+ New note</button>
        {notes.map((nt, i) => (
          <button key={nt.title} className={`nitem ${i === sel ? 'on' : ''}`} onClick={() => setSel(i)}>
            <div className="t">{nt.title}</div><div className="s">{nt.sub}</div>
          </button>
        ))}
      </div>
      <div className="neditor">
        <div className="nehdr">
          {note.dirty && <span className="dot" />}
          <span>{note.title}</span>
          <span className="ns">{note.dirty ? 'unsaved · agent-readable' : 'agent-readable'}</span>
        </div>
        <div className="nebody"><textarea defaultValue={note.body} key={note.title} /></div>
      </div>
    </div>
  );
}
