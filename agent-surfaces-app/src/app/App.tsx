import { useState } from 'react';
import '../blocks'; // side-effect: register block renderers
import { Board } from './Board';
import { Shell } from './Shell';
import { ProjectHome } from './ProjectHome';
import { ActivityStrip } from './ActivityStrip';
import { CommandPalette } from './CommandPalette';
import { Toaster, BottomTaskbar, Inbox, Machines } from './GlobalChrome';
import { WORKSPACES, INBOX_ITEMS } from '../data/mock';

export function App() {
  const [wsId, setWsId] = useState<string | null>(null);
  const [home, setHome] = useState<'board' | 'project'>('board');
  const [inbox, setInbox] = useState(false);
  const [machines, setMachines] = useState(false);
  const ws = WORKSPACES.find((w) => w.id === wsId) ?? null;
  const unread = INBOX_ITEMS.filter((i) => i.unread).length;

  const goBoard = () => { setWsId(null); setHome('board'); };
  const goProject = () => { setWsId(null); setHome('project'); };

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand" style={{ cursor: 'pointer' }} onClick={goBoard}>GitSpace</span>
        <span className="crumb" style={{ cursor: 'pointer' }} onClick={goProject}><b>tone-tempo</b></span>
        <ActivityStrip activeId={wsId} onSelect={(id) => (id === null ? goProject() : setWsId(id))} />
        <div className="right">
          <button className="topbar-inbox" onClick={() => setMachines(true)} title="Machines">⧉</button>
          <button className="topbar-inbox" onClick={() => setInbox(true)} title="Inbox">⚑{unread > 0 && <span className="topbar-badge">{unread}</span>}</button>
          <span className="topbar-cmdk mono">⌘K</span>
          <span className="kicker">Agent Surfaces · concept</span>
        </div>
      </div>
      <CommandPalette onBoard={goBoard} onProject={goProject} onWorkspace={setWsId} />
      {inbox && <Inbox onClose={() => setInbox(false)} onOpenWorkspace={setWsId} />}
      {machines && <Machines onClose={() => setMachines(false)} />}
      <div className="appbody">
        {ws
          ? <Shell key={ws.id} ws={ws} onSwitchWorkspace={setWsId} />
          : home === 'project'
            ? <ProjectHome onOpenWorkspace={setWsId} onOpenBoard={goBoard} />
            : <Board onOpen={(w) => setWsId(w.id)} onOpenProject={goProject} />}
      </div>
      <BottomTaskbar />
      <Toaster />
    </div>
  );
}
