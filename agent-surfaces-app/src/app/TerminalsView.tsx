import { useState } from 'react';
import { terminals, termLines } from '../data/mock';
import type { TermSession } from '../data/mock';

// Multi-pane terminals — mirrors the real Dockview multi-pane (split / switch / new).
function TermPane({ t }: { t: TermSession }) {
  return (
    <div className="tmpane">
      <div className="tmpane-h">
        {t.busy && <span className="dotpulse" />}
        <span className="mono tmpane-name">{t.name}</span>
        <span className="dim mono tmpane-cwd">{t.cwd}</span>
        <span className="tmpane-x">✕</span>
      </div>
      <div className="tpane">{termLines.map((l, i) => <div key={i} className={`tl ${l.tone ?? ''}`}>{l.text}</div>)}</div>
    </div>
  );
}

export function TerminalsView({ focus }: { focus?: string }) {
  const [sel, setSel] = useState(focus ?? terminals[0].id);
  const [split, setSplit] = useState(false);
  const a = terminals.find((t) => t.id === sel) ?? terminals[0];
  const b = terminals.find((t) => t.id !== sel) ?? terminals[0];
  return (
    <div className="tmsurface">
      <div className="tm-bar">
        {terminals.map((t) => (
          <button key={t.id} className={`tm-tab ${t.id === sel ? 'on' : ''}`} onClick={() => setSel(t.id)}>
            {t.busy && <span className="dotpulse" />}{t.name}
          </button>
        ))}
        <button className="tm-tab new">＋ New</button>
        <span className="tm-spacer" />
        <button className="btn sm" onClick={() => setSplit((s) => !s)}>{split ? 'Unsplit' : '⊟ Split'}</button>
      </div>
      <div className={`tm-grid ${split ? 'split' : ''}`}>
        <TermPane t={a} />
        {split && <TermPane t={b} />}
      </div>
    </div>
  );
}
