import { useState } from 'react';
import { artifactTree, explorerTree, notesList, ratedPrecedents, reportItems, reviewStaged, DIFF_BASES } from '../data/mock';
import type { ArtifactRow, Stage } from '../data/mock';
import type { Pane } from './Shell';

function grouped(rows: ArtifactRow[]): [string, ArtifactRow[]][] {
  const m = new Map<string, ArtifactRow[]>();
  for (const r of rows) { const a = m.get(r.group) ?? []; a.push(r); m.set(r.group, a); }
  return [...m];
}
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
const KIND_TONE: Record<string, string> = { praise: 'blue', 'good-pattern': 'green', frustration: 'red', 'workflow-quirk': 'amber', 'gitspace-quirk': 'violet' };

export function RightRail({ onOpen, onFile, stage }: { onOpen: (target: string) => void; onFile: (name: string) => void; stage?: Stage }) {
  const [mode, setMode] = useState<'repo' | 'artifacts'>('repo');
  const [diffBase, setDiffBase] = useState<string>('main');
  const reviewing = stage === 'review';
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();
  const arts = artifactTree.filter((r) => !ql || `${r.group} ${r.label} ${r.meta ?? ''}`.toLowerCase().includes(ql));
  const precs = ratedPrecedents.filter((p) => !ql || `${p.label} ${p.surface}`.toLowerCase().includes(ql));
  const reps = reportItems.filter((r) => !ql || `${r.kind} ${r.surface} ${r.note}`.toLowerCase().includes(ql));

  return (
    <aside className="rrail-wrap">
      <div className="rmode">
        <button className={mode === 'repo' ? 'on' : ''} onClick={() => setMode('repo')}>Repo</button>
        <button className={mode === 'artifacts' ? 'on' : ''} onClick={() => setMode('artifacts')}>Artifacts</button>
      </div>

      {mode === 'repo' ? (
        <>
          <div className="rsection files">
            <div className="rsec-h"><span>▾</span> {reviewing ? 'Diffs' : 'Files'} <span className="compTag"><span className="x">backed by</span> @pierre/trees</span></div>
            <div className="diffbase">
              <span className="dim">diff vs</span>
              <select className="diffbase-sel" value={diffBase} onChange={(e) => setDiffBase(e.target.value)}>
                {DIFF_BASES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {reviewing && <span className="chip amber diffbase-mode">review</span>}
            </div>
            <div className="rsec-b">
              {explorerTree.map((n) => (
                <div key={n.path} className={`tnode ${n.kind} ${reviewing && n.git ? 'changed' : ''}`} style={{ paddingLeft: 12 + n.depth * 14 }} onClick={() => n.kind === 'file' && onFile(n.name)}>
                  <span style={{ color: 'var(--gs-text-dim)' }}>{n.kind === 'dir' ? '▾' : '▤'}</span>
                  {n.name}
                  {n.git && <span className={`gd ${n.git.toLowerCase()}`}>{reviewing ? `${n.git}` : n.git}</span>}
                </div>
              ))}
            </div>
          </div>
          <div className="rsection changes">
            <div className="rsec-h"><span>▾</span> Changes <span className="ct tnum">{reviewStaged.length}</span></div>
            <div className="rsec-b">
              <div className="commitbox"><input placeholder="Commit message…" /><button className="btn primary sm">Commit</button></div>
              <div className="scgrp">Changes · {reviewStaged.length}</div>
              {reviewStaged.map((f) => (
                <div key={f.path} className="scrow clickrow" onClick={() => onFile(f.path.split('/').pop() ?? f.path)}>
                  <span className={`st ${f.git.toLowerCase()}`}>{f.git}</span>
                  <span className="pth">{f.path}</span>
                  <span className="cnt tnum">+{f.adds} −{f.dels}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="rsec-b" style={{ flex: 1 }}>
          <div className="artsearch"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search project artifacts…" /></div>

          {grouped(arts).map(([group, rows]) => (
            <div key={group}>
              <div className="artgrp">{group}</div>
              {rows.map((r) => (
                <div key={r.label} className="artrow" onClick={() => onOpen(r.ev ? `ev:${r.ev}` : r.pane)}>
                  <span className="ai">{r.icon}</span>{r.label}
                  {r.meta && <span className="ax">{r.meta}</span>}
                </div>
              ))}
            </div>
          ))}

          <div>
            <div className="artgrp">Notes</div>
            {notesList.map((nt, i) => (
              <div key={i} className="artrow" onClick={() => onOpen(`note:${i}`)}>
                <span className="ai">✎</span>{nt.title}
                {nt.dirty && <span className="ax" style={{ color: 'var(--gs-warning)' }}>●</span>}
              </div>
            ))}
            <div className="artrow" onClick={() => onOpen('note:new')}><span className="ai">＋</span>New note</div>
          </div>

          {precs.length > 0 && (
            <div>
              <div className="artgrp">Rated precedents · seed from these</div>
              {precs.map((p) => (
                <div key={p.label} className="artrow" onClick={() => onOpen('goal')} title={p.surface}>
                  <span className="ai">⛓</span>{p.label}
                  <span className="art-stars">{stars(p.rating)}</span>
                </div>
              ))}
            </div>
          )}

          {reps.length > 0 && (
            <div>
              <div className="artgrp">Reports · good + bad</div>
              {reps.map((r, i) => (
                <div key={i} className="artrow report" title={r.note} onClick={() => onOpen('report:' + reportItems.indexOf(r))}>
                  <span className={`rep-kind ${KIND_TONE[r.kind]}`}>{r.kind}</span>
                  <span className="rep-surface">{r.surface}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
