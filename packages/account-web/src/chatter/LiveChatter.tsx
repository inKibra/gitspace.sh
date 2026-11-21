import { ChatterPane } from './ChatterPane.js';
import { useChatter } from './useChatter.js';

/** The project's Chatter button and pane in the open workspace's header, read live. */
export function LiveChatter({ projectId, projectName, workspaceId, workspaceCount }: { projectId: string; projectName: string; workspaceId: string; workspaceCount: number | null }) {
  const chatter = useChatter(projectId);
  return <ChatterPane projectName={projectName} workspaceCount={workspaceCount} workspaceId={workspaceId} state={chatter.state} active={chatter.active} error={chatter.error}
    onPost={chatter.post} onAct={chatter.act} onLoadOlder={chatter.loadOlder} />;
}
