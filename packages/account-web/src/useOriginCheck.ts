import { useEffect, useRef } from 'react';
import type { ProjectLifecycleView } from './GitSpaceShell.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** How old an origin check may be when a project opens before it is checked again. */
const ORIGIN_CHECK_AGE_MS = 10 * 60_000;

/** Opening a project whose origin was not checked in the last ten minutes checks it once. Push webhooks keep covered
 * repositories current, so nothing polls; the result reaches the page through the project list. */
export function useOriginCheck(project: Pick<ProjectLifecycleView, 'id' | 'lifecycle' | 'repositoryReference' | 'remote'> | null): void {
  const opened = useRef<string | null>(null);
  const projectId = project?.id ?? null;
  const due = project !== null && project.repositoryReference !== null && project.lifecycle !== 'deleting'
    && (project.remote === null || Date.now() - Date.parse(project.remote.checkedAt) > ORIGIN_CHECK_AGE_MS);
  useEffect(() => {
    // Once per opening: a failed check is not retried until the project is opened again.
    if (projectId === opened.current) return;
    opened.current = projectId;
    if (!due || projectId === null) return;
    void rpcClient.project.remote.refresh({ projectId }).then((result) => {
      if (result.status === 'error') console.warn(rpcErrorMessage(result.error, 'Check origin'));
    }, (error: unknown) => console.warn(rpcErrorMessage(error, 'Check origin')));
  }, [projectId, due]);
}
