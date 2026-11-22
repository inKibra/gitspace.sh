import { ChatterPane } from './ChatterPane.js';
import { useChatterOpenRequest } from './chatter-open.js';
import { useChatter } from './useChatter.js';

/** The project's Chatter button and pane in the open workspace's header, read live. `workspaces` are the project's open
 * workspaces, whose main agents Hear as can pick beside the project agent; `onOpenWorkspace` opens one a project agent's
 * post links. */
export function LiveChatter({ projectId, projectName, workspaceId, workspaces, onOpenWorkspace }: { projectId: string; projectName: string; workspaceId: string; workspaces: readonly { id: string; name: string }[]; onOpenWorkspace(workspaceId: string): void }) {
  const chatter = useChatter(projectId);
  const openRequest = useChatterOpenRequest(projectId);
  return <ChatterPane projectId={projectId} projectName={projectName} workspaceCount={workspaces.length} workspaceId={workspaceId} workspaces={workspaces.filter(workspace => workspace.id !== projectId)} state={chatter.state} active={chatter.active} error={chatter.error}
    onPost={chatter.post} onAct={chatter.act} onLoadOlder={chatter.loadOlder} onHearAs={chatter.hearAs} onHearings={chatter.hearings} onShowPost={chatter.showPost} onOpenWorkspace={onOpenWorkspace} openRequest={openRequest} />;
}
