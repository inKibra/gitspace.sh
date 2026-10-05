import { EnvironmentError, browserOriginHash, parseEnvironmentBundleJson, type LifecycleState } from '@gitspace/protocol-environment';
import type { RuntimeSnapshotCommitInput } from '@gitspace/protocol-runtime';
import type { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';

type Source = {
  code: Pick<ArtifactsCodeStore, 'resolveRef' | 'readFile'>;
  repository: string;
  branch: string;
  checkpoint(): Promise<RuntimeSnapshotCommitInput['checkpoint'] | null>;
};

/** Working-tree edits cannot grant browser access: only the recorded Git HEAD is policy content. */
export async function committedBrowserOrigins(source: Source): Promise<{ commit: string | null; origins: LifecycleState['browserOrigins'] }> {
  const head = async () => {
    const checkpoint = await source.checkpoint();
    return checkpoint === null ? source.code.resolveRef(source.repository, `refs/heads/${source.branch}`) : checkpoint.headCommit;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const commit = await head();
    const file = commit === null ? null : await source.code.readFile(source.repository, commit, '.gitspace/bundle.json');
    const patterns = file === null ? [] : parseEnvironmentBundleJson(await file.text()).browser.origins;
    const origins = await Promise.all(patterns.map(async pattern => ({ pattern, hash: await browserOriginHash(pattern) })));
    if (await head() === commit) return { commit, origins };
  }
  throw new EnvironmentError('ContentChanged', 'The committed environment changed while loading browser origins. Refresh before approving or using the grant.');
}
