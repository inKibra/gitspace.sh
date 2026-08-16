import type { ReactNode } from 'react';

export function Pane({ title, sub, right, foot, children, pad = true }: {
  title: string; sub?: string; right?: ReactNode; foot?: ReactNode; children: ReactNode; pad?: boolean;
}) {
  return (
    <div className="panel" style={{ height: '100%' }}>
      <div className="panel-head">
        <span className="pt">{title}</span>
        {sub && <span className="muted" style={{ fontSize: 11 }}>{sub}</span>}
        {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
      </div>
      <div className="panel-body" style={pad ? undefined : { padding: 0 }}>{children}</div>
      {foot}
    </div>
  );
}

export function Composer({ placeholder = 'Message the agent…' }: { placeholder?: string }) {
  return (
    <div style={{ flex: 'none', borderTop: '1px solid var(--gs-border)', padding: 9, display: 'flex', gap: 7, background: '#050505' }}>
      <input
        placeholder={placeholder}
        style={{ flex: 1, background: '#000', border: '1px solid var(--gs-border)', color: 'var(--gs-text)', font: 'inherit', fontSize: 12, padding: '6px 9px', outline: 'none' }}
      />
      <button className="btn primary sm">Send</button>
    </div>
  );
}
