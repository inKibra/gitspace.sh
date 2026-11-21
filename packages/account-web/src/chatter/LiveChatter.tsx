import { useState } from 'react';
import { ChatterPane } from './ChatterPane.js';
import { useChatter } from './useChatter.js';

/** Whether the pane is collapsed to its pill, remembered across projects and reloads; collapsed until opened once. */
const COLLAPSED_KEY = 'gitspace.chatter.collapsed';

/** The project's Chatter pane over the open workspace, read live. */
export function LiveChatter({ projectId, projectName, workspaceCount }: { projectId: string; projectName: string; workspaceCount: number | null }) {
  const chatter = useChatter(projectId);
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem(COLLAPSED_KEY) !== 'false');
  return <ChatterPane projectName={projectName} workspaceCount={workspaceCount} state={chatter.state} active={chatter.active} error={chatter.error}
    collapsed={collapsed} onCollapsed={next => { setCollapsed(next); window.localStorage.setItem(COLLAPSED_KEY, String(next)); }}
    onPost={chatter.post} onAct={chatter.act} onLoadOlder={chatter.loadOlder} />;
}
