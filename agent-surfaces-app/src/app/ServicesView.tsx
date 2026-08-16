import { services } from '../data/mock';

const TONE: Record<string, string> = { ready: 'green', running: 'green', stopped: 'dim', failed: 'red' };

// Services / long-running processes (real GitSpace: .gitspace/processes.json + ports)
export function ServicesView() {
  return (
    <div className="svc">
      <div className="svc-bar">
        <span className="kicker">Services &amp; processes</span>
        <span className="dim" style={{ fontSize: 11 }}>.gitspace/processes.json · auto-allocated ports</span>
        <span style={{ marginLeft: 'auto' }}><button className="btn sm">＋ Add service</button></span>
      </div>
      <div className="svc-list">
        {services.map((s) => (
          <div key={s.id} className="svc-row">
            <span className={`svc-dot ${TONE[s.status]}`} />
            <div className="svc-main">
              <div className="svc-top"><span className="svc-name mono">{s.name}</span><span className={`chip ${TONE[s.status]}`}>{s.status}</span>{s.autostart && <span className="chip dim">autostart</span>}</div>
              <div className="svc-cmd mono dim">{s.command}</div>
              <div className="svc-meta">
                {s.ports.map((p) => <span key={p.name} className="svc-port">{p.name} <a className="svc-portn mono">:{p.port}</a> <span className="dim">{p.protocol}</span></span>)}
                {s.ports.length === 0 && <span className="dim">no ports</span>}
                <span className="dim svc-restart">restart: {s.restart}{s.uptime ? ` · up ${s.uptime}` : ''}</span>
              </div>
            </div>
            <div className="svc-actions">
              {s.status === 'stopped' || s.status === 'failed'
                ? <button className="btn xs">Start</button>
                : <><button className="btn xs">Attach</button><button className="btn xs">Stop</button></>}
              <button className="btn xs">Logs</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
