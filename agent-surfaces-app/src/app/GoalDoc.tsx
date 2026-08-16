import { useState } from 'react';
import { BlockView } from '../blocks';
import { goalChain } from '../data/mock';
import type { Pane } from './Shell';

export function GoalDoc({ onOpen }: { onOpen: (p: Pane) => void }) {
  const [cur, setCur] = useState(() => { const i = goalChain.findIndex((d) => d.status === 'active'); return i < 0 ? 0 : i; });
  const [exemplars, setExemplars] = useState<Set<string>>(new Set());
  const doc = goalChain[cur];
  const toggle = (id: string) => setExemplars((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="gdoc">
      <div className="gdoc-head">
        <span className="gdoc-t">Goal · {doc.title}</span>
        <span className="gdoc-sub">composed from a small block vocabulary{exemplars.size > 0 ? ` · ★ ${exemplars.size} exemplar` : ''}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn sm">Preview</button>
          <button className="btn sm">Edit</button>
        </span>
      </div>

      <div className="gchain">
        <button className="gchain-nav" disabled={cur === 0} onClick={() => setCur((c) => c - 1)}>‹ up</button>
        <div className="gchain-track">
          {goalChain.map((d, i) => (
            <button key={d.id} className={`gchain-node ${d.status} ${i === cur ? 'on' : ''}`} onClick={() => setCur(i)}>
              <span className="gchain-ic">⛓</span><span className="gchain-n">{i + 1}</span>{d.title}
            </button>
          ))}
        </div>
        <button className="gchain-nav" disabled={cur === goalChain.length - 1} onClick={() => setCur((c) => c + 1)}>down ›</button>
      </div>

      <div className="gdoc-body">
        {doc.blocks.map((b) => (
          <div key={b.id} className={`docblock ${exemplars.has(b.id) ? 'exemplar' : ''}`}>
            <button className={`exstar ${exemplars.has(b.id) ? 'on' : ''}`} title="Mark as exemplar" onClick={() => toggle(b.id)}>★</button>
            <BlockView block={b} />
          </div>
        ))}
        <button className="wf-tie" onClick={() => onOpen('workflow')}>
          <span className="wf-tie-ic">⟜</span>
          <div className="wf-tie-body">
            <div className="wf-tie-t">This goal drives the review-gated workflow</div>
            <div className="wf-tie-d">4 phases · implement → evidence → review-gate → adjudicate</div>
          </div>
          <span className="wf-tie-open">open Workflow ↗</span>
        </button>
      </div>
    </div>
  );
}
