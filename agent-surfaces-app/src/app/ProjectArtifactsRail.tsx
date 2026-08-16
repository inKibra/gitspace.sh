import { useMemo, useState } from 'react';
import { projectWorkspaceArtifacts, triggerForData } from '../data/mock';
import type { FlatArtifact } from '../data/mock';
import { LastRunChip } from './LastRunMenu';

const KIND_ICON: Record<string, string> = { goal: '◇', rubric: '☰', evidence: '▸', dashboard: '▦', app: '◧', data: '▤', note: '✎' };
const KIND_LABEL: Record<string, string> = { goal: 'Goal', rubric: 'Rubric', evidence: 'Evidence', dashboard: 'Dashboards', app: 'Apps', data: 'Data', note: 'Notes' };
const KIND_ORDER = ['goal', 'rubric', 'evidence', 'dashboard', 'app', 'data', 'note'];

// single autocomplete combobox: pick a workspace; options grouped by chain
function WorkspaceCombo({ value, options, onChange }: { value: string; options: { ws: string; chain: string }[]; onChange: (ws: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const cur = options.find((o) => o.ws === value);
  const filtered = options.filter((o) => `${o.chain} ${o.ws}`.toLowerCase().includes(q.toLowerCase()));
  const chains = Array.from(new Set(filtered.map((o) => o.chain)));
  return (
    <div className="combo wide">
      <span className="combo-ic">⛓</span>
      <input
        className="combo-in mono"
        value={open ? q : (cur ? `${cur.chain} · ${cur.ws}` : '')}
        placeholder="find chain / workspace…"
        onFocus={() => { setOpen(true); setQ(''); }}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 130)}
      />
      <span className="combo-caret">▾</span>
      {open && (
        <div className="combo-list">
          {chains.map((ch) => (
            <div key={ch}>
              <div className="combo-grp">{ch}</div>
              {filtered.filter((o) => o.chain === ch).map((o) => (
                <button key={o.ws} className={`combo-item ${o.ws === value ? 'on' : ''}`} onMouseDown={() => { onChange(o.ws); setOpen(false); }}>{o.ws}</button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && <div className="combo-empty dim">no matches</div>}
        </div>
      )}
    </div>
  );
}

function ArtRow({ a, fav, onFav, onOpen, sub }: { a: FlatArtifact; fav: boolean; onFav: () => void; onOpen: () => void; sub?: string }) {
  const tr = a.cron ? triggerForData(a.name) : undefined;
  return (
    <div className="artrow parts-row" onClick={onOpen}>
      <span className="ai">{KIND_ICON[a.kind]}</span>
      <span className="parts-name">{a.name}{sub && <span className="dim parts-sub"> · {sub}</span>}</span>
      {tr && <span className="parts-cron"><LastRunChip trigger={tr} compact /></span>}
      <button className={`parts-star ${fav ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onFav(); }} title="favorite">★</button>
    </div>
  );
}

export function ProjectArtifactsRail({ onOpen, favorites, toggleFav }: {
  onOpen: (t: string) => void; favorites: Set<string>; toggleFav: (id: string) => void;
}) {
  const wsList = useMemo(() => projectWorkspaceArtifacts.map((w) => ({ ws: w.workspace, chain: w.chain })), []);
  const [workspace, setWorkspace] = useState(wsList[0].ws);
  const [view, setView] = useState<'sel' | 'fav'>('sel');

  const cur = projectWorkspaceArtifacts.find((w) => w.workspace === workspace) ?? projectWorkspaceArtifacts[0];
  const openArtifact = (a: FlatArtifact) => a.kind === 'note' ? onOpen(`note:${a.noteIdx}`) : a.ev ? onOpen(`ev:${a.ev}`) : onOpen(`artifact:${a.name}`);
  const favList = projectWorkspaceArtifacts.flatMap((w) => w.artifacts.map((a) => ({ a, ws: w.workspace }))).filter((x) => favorites.has(x.a.id));

  const groups = KIND_ORDER.map((k) => [k, cur.artifacts.filter((a) => a.kind === k)] as const).filter(([, a]) => a.length);

  return (
    <div className="parts">
      <div className="parts-loc">
        <WorkspaceCombo value={workspace} options={wsList} onChange={setWorkspace} />
      </div>
      <div className="parts-modes">
        <button className={view === 'sel' ? 'on' : ''} onClick={() => setView('sel')}>Artifacts</button>
        <button className={view === 'fav' ? 'on' : ''} onClick={() => setView('fav')}>★ Favorites <span className="dim">{favorites.size || ''}</span></button>
      </div>
      <div className="parts-body">
        {view === 'sel'
          ? groups.map(([kind, arts]) => (
            <div key={kind}>
              <div className="parts-grp">{KIND_LABEL[kind]}</div>
              {arts.map((a) => <ArtRow key={a.id} a={a} fav={favorites.has(a.id)} onFav={() => toggleFav(a.id)} onOpen={() => openArtifact(a)} />)}
            </div>
          ))
          : favList.length
            ? favList.map(({ a, ws }) => <ArtRow key={a.id} a={a} fav onFav={() => toggleFav(a.id)} onOpen={() => openArtifact(a)} sub={ws} />)
            : <div className="parts-empty dim">No favorites yet — ★ an artifact to pin it across the project.</div>}
      </div>
    </div>
  );
}
