import { useState } from 'react';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import { CacheMachineRow } from './CacheMachineRow.js';

const stamp = '2026-10-06T12:00:00.000Z';
const initial = RuntimeAttachmentSchema.parse({ projectId: 'gallery', workspaceId: 'environment', attachmentId: 'laptop-cache', machineId: 'laptop', generation: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp, heartbeatAt: stamp, cache: { state: 'paused', platform: 'darwin', activity: [], lastActivityAt: stamp, pausedAt: stamp, reclaimAt: '2026-10-07T12:00:00.000Z', lastSyncAt: stamp, localWorkOptIn: false, setup: [{ phase: 'machine/prepare', state: 'succeeded', runId: 'prepare' }, { phase: 'checks', state: 'waiting-for-approval', runId: 'checks' }, { phase: 'workspace/materialize', state: 'pending', runId: null }] } });

/** Gallery-only state, exercising the production row rather than a mock layout. */
export function CacheMachineGallery() {
  const [attachment, setAttachment] = useState(initial);
  const [isDefault, setDefault] = useState(false);
  const [activity, setActivity] = useState('Fixture machine · no commands run');
  return <section aria-label="Workspace machines" className="flex flex-col gap-2">
    {attachment.state !== 'detached' ? <CacheMachineRow attachment={attachment} name="Studio Mac" isDefault={isDefault} pending={false} now={Date.parse(stamp)} onDefault={() => setDefault(true)} onDetach={() => setAttachment(current => ({ ...current, state: 'detached' }))} onOpenLog={runId => setActivity(`Opened ${runId} log`)} onAction={action => {
      if (action.kind === 'local-work') setAttachment(current => ({ ...current, cache: current.cache ? { ...current.cache, localWorkOptIn: action.enabled } : undefined }));
      else if (action.kind === 'reclaim') setAttachment(current => ({ ...current, cache: current.cache ? { ...current.cache, state: 'reclaimed' } : undefined }));
      else setAttachment(current => ({ ...current, cache: current.cache ? { ...current.cache, state: 'setup', setup: current.cache.setup.map(step => ({ ...step, state: 'running' })) } : undefined }));
    }} blockers={<p className="text-caption text-warning">Check · Database migration · Waiting approval</p>} /> : <p>No machine</p>}
    <p role="status" className="text-caption text-muted-foreground">{activity}</p>
  </section>;
}
