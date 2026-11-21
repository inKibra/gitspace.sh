import { ChatterPane } from './ChatterPane.js';
import { useChatter } from './useChatter.js';

/** The project's Chatter button and pane in the open workspace's header, read live. `workspaces` are the project's open
 * workspaces, whose main agents Hear as can pick beside the project agent. */
export function LiveChatter({ projectId, projectName, workspaceId, workspaces }: { projectId: string; projectName: string; workspaceId: string; workspaces: readonly { id: string; name: string }[] }) {
  const chatter = useChatter(projectId);
  return <ChatterPane projectName={projectName} workspaceCount={workspaces.length} workspaceId={workspaceId} workspaces={workspaces.filter(workspace => workspace.id !== projectId)} state={chatter.state} active={chatter.active} error={chatter.error}
    onPost={chatter.post} onAct={chatter.act} onLoadOlder={chatter.loadOlder} onHearAs={chatter.hearAs} onHearings={chatter.hearings} />;
}
