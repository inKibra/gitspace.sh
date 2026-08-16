import { useState } from 'react';
import type { Trigger } from '../data/mock';

const KIND_TONE: Record<string, string> = { cron: 'blue', event: 'violet', manual: 'dim' };
const STATUS_TONE: Record<string, string> = { ok: 'green', pending: 'amber', failed: 'red', idle: 'dim' };
const HIST_TONE: Record<string, string> = { ok: 'var(--gs-success)', fail: 'var(--gs-danger)', pending: 'var(--gs-warning)' };

// A freshness chip that opens a quick "last run" menu for the cron/trigger
// that writes this artifact. Used on dashboard panels and tree nodes.
export function LastRunChip({ trigger, compact }: { trigger: Trigger; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="lrchip-wrap">
      <button className={`lrchip ${compact ? 'compact' : ''}`} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} title="last run">
        ⟳ {compact ? trigger.last : `${trigger.name} · ${trigger.last}`}
      </button>
      {open && (
        <>
          <span className="lrmenu-scrim" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div className="lrmenu" onClick={(e) => e.stopPropagation()}>
            <div className="lrmenu-h">
              <span className="mono lrmenu-name">{trigger.name}</span>
              <span className={`chip ${KIND_TONE[trigger.kind]}`}>{trigger.kind}</span>
              <span className="dim mono lrmenu-when">{trigger.when}</span>
            </div>
            <div className="lrmenu-row"><span className="dim">last run</span><span className={`chip ${STATUS_TONE[trigger.status]}`}>{trigger.status}</span><b>{trigger.last}</b>{trigger.cost && <span className="dim mono"> · {trigger.cost}</span>}</div>
            {trigger.next && <div className="lrmenu-row"><span className="dim">next</span><b>{trigger.next}</b></div>}
            <div className="lrmenu-row"><span className="dim">writes</span><span className="mono lrmenu-writes">{trigger.writes.join(', ')}</span></div>
            {trigger.history.length > 0 && (
              <div className="lrmenu-spark">{trigger.history.map((h, i) => <span key={i} className="lrmenu-dot" style={{ background: HIST_TONE[h] }} />)}</div>
            )}
            <div className="lrmenu-actions"><button className="btn xs">⟳ Run now</button><button className="btn xs">Open trigger</button></div>
          </div>
        </>
      )}
    </span>
  );
}
