import { useState } from 'react';
import { MINI_APPS, MiniAppFrame } from '../blocks/mini-apps';
import { SHIP_APP_PALETTE, SHIP_DATA } from '../data/mock';
import type { ShipPanel } from '../data/mock';

let seq = 500;

// Shared composable canvas of gitspace-mini-apps (*.gssh.html). Controlled:
// the parent owns `panels` so roll-up can inject promoted dashboards.
export function DashboardCanvas({ panels, setPanels, scopeLabel, addLabel = '＋ Create dashboard' }: {
  panels: ShipPanel[];
  setPanels: (fn: (p: ShipPanel[]) => ShipPanel[]) => void;
  scopeLabel: string;
  addLabel?: string;
}) {
  const [adding, setAdding] = useState(false);
  const toggleSize = (id: string) => setPanels((p) => p.map((x) => x.id === id ? { ...x, size: x.size === 'full' ? 'half' : 'full' } : x));
  const remove = (id: string) => setPanels((p) => p.filter((x) => x.id !== id));
  const add = (app: string, title: string, scope: 'workspace' | 'chain') => {
    setPanels((p) => [...p, { id: `p-${seq++}`, app, title, artifact: `${app}.app`, data: `${app}.data.json`, size: 'half', scope }]);
    setAdding(false);
  };

  return (
    <div className="canvas-wrap">
      <div className="canvas-head">
        <span className="kicker">{scopeLabel}</span>
        <span className="dim" style={{ fontSize: 11 }}>composable gitspace-mini-apps · *.gssh.html</span>
        <span style={{ marginLeft: 'auto', position: 'relative' }}>
          <button className="btn sm" onClick={() => setAdding((a) => !a)}>{addLabel}</button>
          {adding && (
            <div className="palette">
              {SHIP_APP_PALETTE.map((d) => (
                <button key={d.app} className="palette-item" onClick={() => add(d.app, d.title, d.scope)}>
                  <span className="palette-t">{d.title} <span className={`ma-scope ${d.scope}`}>{d.scope}</span></span>
                  <span className="palette-b dim">{d.blurb}</span>
                </button>
              ))}
            </div>
          )}
        </span>
      </div>
      <div className="canvas-grid">
        {panels.length === 0 && <div className="canvas-empty dim">No dashboards yet — create one, or roll up a shipped workspace's dashboards.</div>}
        {panels.map((p) => {
          const App = MINI_APPS[p.app] ?? (() => <div className="dim" style={{ padding: 16 }}>unknown mini-app</div>);
          return (
            <MiniAppFrame key={p.id} panel={p} onToggleSize={() => toggleSize(p.id)} onRemove={() => remove(p.id)}>
              <App data={SHIP_DATA[p.data] ?? null} panel={p} />
            </MiniAppFrame>
          );
        })}
      </div>
    </div>
  );
}
