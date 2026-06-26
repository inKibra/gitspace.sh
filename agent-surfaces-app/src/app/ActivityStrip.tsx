import { WORKSPACES, WS_STATUS, WS_STATUS_COLOR, WS_STATUS_LABEL } from '../data/mock';

export function ActivityStrip({ activeId, onSelect }: { activeId: string | null; onSelect: (id: string | null) => void }) {
  return (
    <div className="actstrip">
      <button className="wschip" data-on={activeId === null} onClick={() => onSelect(null)}>⊞ board</button>
      {WORKSPACES.map((w) => {
        const status = WS_STATUS[w.id] ?? 'idle';
        return (
          <button key={w.id} className="wschip" data-on={w.id === activeId} onClick={() => onSelect(w.id)} title={WS_STATUS_LABEL[status]}>
            <span className="sd" style={{ background: WS_STATUS_COLOR[status] }} />
            {w.name}
            <span className="st">{w.stage}</span>
          </button>
        );
      })}
    </div>
  );
}
