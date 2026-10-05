import { useState } from 'react';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import type { RepositoryMode } from '@gitspace/protocol';
import { Button } from '@gitspace/ui';
import { FilesSurface } from '../inspector/Inspector.js';
import { runtimeLfsHeldBack, useLfsTransition } from '../LfsTransition.js';

const commit = 'a'.repeat(40);
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'design', workspaceId: 'offline-lfs', cursor: 1, conversations: [], attachments: [], tasks: [], questions: [], documents: { 'gitspace.code': { checkpointRef: 'refs/gitspace/checkpoint', headCommit: commit, branch: 'main', indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: commit, worktreeTree: commit, lfs: { objects: [], heldBack: [{ path: 'assets/hero.psd', kind: 'modified' }, { path: 'video/uncommitted-take.mov', kind: 'added' }] } } } });

/** Real Files and confirmation components; all data is a saved cloud snapshot, with no machine/provider calls. */
export function LfsGallery() {
  const [mode, setMode] = useState<RepositoryMode>('working');
  const [changedOnly, setChangedOnly] = useState(false);
  const [outcome, setOutcome] = useState('Offline saved snapshot; sanitized working diff is empty.');
  const transition = useLfsTransition();
  const heldBack = runtimeLfsHeldBack(snapshot);
  return <section id="lfs" className="flex scroll-mt-24 flex-col gap-4 pt-14"><h2 className="text-title">LFS changes · offline workspace</h2><div className="flex h-96 max-w-2xl flex-col overflow-hidden rounded-xl border border-border"><FilesSurface entries={[]} heldBack={mode === 'working' ? heldBack : []} mode={mode} onModeChange={setMode} changedOnly={changedOnly} setChangedOnly={setChangedOnly} onOpen={entry => setOutcome(`Open ${entry.path}`)} onOpenHeldBack={path => setOutcome(`Open working diff: ${path}`)} /></div><div className="flex gap-2">{['Detach machine', 'Move workspace'].map(action => <Button key={action} variant="secondary" onClick={async () => { if (await transition.confirm(heldBack, () => setOutcome('Commit flow opened; transition cancelled.'))) setOutcome(`${action} explicitly confirmed without local LFS changes.`); }}>{action}</Button>)}</div><p role="status" className="text-caption text-muted-foreground">{outcome}</p>{transition.dialog}</section>;
}
