import { useEffect, useMemo, useRef, useState } from 'react';
import { PALETTE_COMMANDS, WORKSPACES, WS_STATUS, WS_STATUS_COLOR } from '../data/mock';
import type { PaletteCmd } from '../data/mock';

export function CommandPalette({ onBoard, onProject, onWorkspace }: {
  onBoard: () => void; onProject: () => void; onWorkspace: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // workspace-switch commands generated from the live list
  const commands = useMemo<PaletteCmd[]>(() => [
    ...PALETTE_COMMANDS,
    ...WORKSPACES.map((w) => ({ id: `ws-${w.id}`, label: `Switch to ${w.name}`, group: 'Navigate' as const, hint: w.stage, nav: { type: 'workspace' as const, id: w.id } })),
  ], []);
  const filtered = commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const groups = ['Navigate', 'Actions', 'Open'].map((g) => [g, filtered.filter((c) => c.group === g)] as const).filter(([, c]) => c.length);
  const flat = groups.flatMap(([, c]) => c);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); setQ(''); setSel(0); }
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 10); }, [open]);

  const run = (c?: PaletteCmd) => {
    if (!c) return;
    setOpen(false);
    if (c.nav?.type === 'board') onBoard();
    else if (c.nav?.type === 'project') onProject();
    else if (c.nav?.type === 'workspace' && c.nav.id) onWorkspace(c.nav.id);
    // non-nav commands are stubs in the mock
  };

  if (!open) return null;
  return (
    <div className="cmdk-scrim" onClick={() => setOpen(false)}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-in"
          placeholder="Type a command or search…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(flat.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(flat[sel]); }
          }}
        />
        <div className="cmdk-list">
          {groups.map(([g, cmds]) => (
            <div key={g}>
              <div className="cmdk-grp">{g}</div>
              {cmds.map((c) => {
                const idx = flat.indexOf(c);
                const wsId = c.nav?.type === 'workspace' ? c.nav.id : undefined;
                return (
                  <button key={c.id} className={`cmdk-item ${idx === sel ? 'on' : ''}`} onMouseEnter={() => setSel(idx)} onClick={() => run(c)}>
                    {wsId && <span className="cmdk-dot" style={{ background: WS_STATUS_COLOR[WS_STATUS[wsId] ?? 'idle'] }} />}
                    <span className="cmdk-label">{c.label}</span>
                    {c.hint && <span className="cmdk-hint mono dim">{c.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && <div className="cmdk-empty dim">No commands match “{q}”.</div>}
        </div>
        <div className="cmdk-foot dim"><span>↑↓ navigate · ↵ run · esc close</span><span className="mono">⌘K</span></div>
      </div>
    </div>
  );
}
