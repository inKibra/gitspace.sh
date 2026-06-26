import { useState } from 'react';
import { TOASTS, LIFECYCLE_TASKS, INBOX_ITEMS, MACHINES } from '../data/mock';

const M_TONE: Record<string, string> = { online: 'green', offline: 'dim', connecting: 'amber', error: 'red' };
export function Machines({ onClose }: { onClose: () => void }) {
  const machines = MACHINES;
  return (
    <div className="inbox-scrim" onClick={onClose}>
      <div className="inbox" onClick={(e) => e.stopPropagation()}>
        <div className="inbox-h"><span>Machines</span><span className="chip green">relay connected</span><span className="inbox-spacer" /><button className="btn xs">Enroll machine</button><button className="inbox-x" onClick={onClose}>✕</button></div>
        <div className="inbox-list">
          {machines.length === 0 && <div className="inbox-empty dim">No machines available — owner-only access. Share your user-root key to enroll.</div>}
          {machines.map((m) => (
            <div key={m.id} className="mach-row">
              <span className={`mach-dot ${M_TONE[m.status]} ${m.status === 'connecting' ? 'pulse' : ''}`} />
              <div className="mach-main">
                <div className="mach-top"><span className="mach-name mono">{m.name}</span>{m.kind === 'local' && <span className="chip dim">local</span>}<span className={`chip ${M_TONE[m.status]}`}>{m.status}</span></div>
                <div className="mach-meta dim">{m.workspaces} workspaces · seen {m.lastSeen}{m.detail ? ` · ${m.detail}` : ''}</div>
              </div>
              {m.status === 'online' ? <button className="btn xs">Open</button>
                : m.status === 'error' ? <button className="btn xs">Retry</button>
                : m.status === 'offline' ? <span className="dim mono mach-off">offline</span>
                : <span className="dim mono mach-off">connecting…</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const TOAST_GLYPH: Record<string, string> = { success: '✓', error: '✕', info: '›' };

export function Toaster() {
  const [toasts, setToasts] = useState(TOASTS);
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span className="toast-ic">{TOAST_GLYPH[t.tone]}</span>
          <div className="toast-body"><div className="toast-text">{t.text}</div>{t.sub && <div className="toast-sub dim">{t.sub}</div>}</div>
          <button className="toast-x" onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>✕</button>
        </div>
      ))}
    </div>
  );
}

const TASK_TONE: Record<string, string> = { running: 'amber', queued: 'dim', failed: 'red', done: 'green' };
export function BottomTaskbar() {
  const [open, setOpen] = useState(false);
  const tasks = LIFECYCLE_TASKS;
  const active = tasks[0];
  return (
    <div className={`taskbar ${open ? 'open' : ''}`}>
      <div className="taskbar-h" onClick={() => setOpen((o) => !o)}>
        <span className={`wdot ${active.status === 'running' ? 'running' : 'pending'}`} />
        <span className="taskbar-title">{active.title}</span>
        <span className="taskbar-phase">{active.phases.map((p) => <span key={p} className={`taskbar-step ${p === active.phase ? 'on' : ''}`}>{p}</span>)}</span>
        <span className="dim mono taskbar-elapsed">{active.elapsed}</span>
        {tasks.length > 1 && <span className="chip dim">+{tasks.length - 1} queued</span>}
        <span className="taskbar-caret">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="taskbar-body">
          <pre className="taskbar-log">{active.log.join('\n')}</pre>
          {tasks.slice(1).map((t) => (
            <div key={t.title} className="taskbar-q"><span className={`chip ${TASK_TONE[t.status]}`}>{t.status}</span>{t.title}</div>
          ))}
        </div>
      )}
    </div>
  );
}

const INBOX_GLYPH: Record<string, string> = { output: '›', error: '✕', exit: '✓', title: '▤', permission: '⚠' };
const INBOX_TONE: Record<string, string> = { output: 'dim', error: 'red', exit: 'green', title: 'dim', permission: 'amber' };
export function Inbox({ onClose, onOpenWorkspace }: { onClose: () => void; onOpenWorkspace: (id: string) => void }) {
  const items = INBOX_ITEMS;
  const groups = Array.from(new Set(items.map((i) => i.project))).map((proj) => ({ proj, items: items.filter((i) => i.project === proj) }));
  const unread = items.filter((i) => i.unread).length;
  return (
    <div className="inbox-scrim" onClick={onClose}>
      <div className="inbox" onClick={(e) => e.stopPropagation()}>
        <div className="inbox-h"><span>Inbox</span>{unread > 0 && <span className="chip blue">{unread} unread</span>}<span className="inbox-spacer" /><button className="btn xs">Clear all</button><button className="inbox-x" onClick={onClose}>✕</button></div>
        <div className="inbox-list">
          {items.length === 0 && <div className="inbox-empty dim">No notifications</div>}
          {groups.map((g) => (
            <div key={g.proj}>
              <div className="inbox-grp">{g.proj}</div>
              {g.items.map((it) => (
                <div key={it.id} className={`inbox-item ${it.unread ? 'unread' : ''}`} onClick={() => { onClose(); }}>
                  {it.unread && <span className="inbox-unread" />}
                  <span className={`inbox-ic ${INBOX_TONE[it.kind]}`}>{INBOX_GLYPH[it.kind]}</span>
                  <div className="inbox-main">
                    <div className="inbox-title">{it.title}</div>
                    <div className="inbox-meta dim mono">{it.workspace} · {it.session} · {it.meta}</div>
                  </div>
                  <span className="dim mono inbox-time">{it.time}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
