import { describe, expect, it } from 'bun:test';
import {
  CHECKPOINT_CHUNK_BYTES,
  chunkedCheckpointManifestSchema,
  projectArtifactBlobKey,
  projectRepositoryPrefix,
  spaceAgentRoot,
  spaceArtifactManifestKey,
  spaceCheckpointManifestKey,
  spaceGitCheckpointRef,
  spaceHandoffRoot,
  spaceStorageRoot,
  spaceCheckpointManifestSchema,
} from '@gitspace/protocol-workspace';

describe('space checkpoint storage', () => {
  it('keeps repository and all space-owned state under the project hierarchy', () => {
    expect(projectRepositoryPrefix('project-a')).toBe('projects/project-a/repo');
    expect(spaceStorageRoot('project-a', 'space-a')).toBe('projects/project-a/spaces/space-a');
    expect(spaceAgentRoot('project-a', 'space-a')).toBe('projects/project-a/spaces/space-a/agent');
    expect(spaceArtifactManifestKey('project-a', 'space-a', 9, 7)).toBe('projects/project-a/spaces/space-a/artifacts/manifests/9/7.enc');
    expect(spaceCheckpointManifestKey('project-a', 'space-a', 9)).toBe('projects/project-a/spaces/space-a/checkpoints/9/manifest.enc');
    expect(spaceHandoffRoot('project-a', 'space-a', 'handoff-a')).toBe('projects/project-a/spaces/space-a/handoffs/handoff-a');
    expect(projectArtifactBlobKey('project-a', `sha256:${'a'.repeat(64)}`)).toBe(`projects/project-a/artifact-blobs/${'a'.repeat(64)}`);
    expect(spaceGitCheckpointRef('space-a', 9)).toBe('refs/gitspace/spaces/space-a/checkpoints/9');
  });

  it('rejects path traversal and malformed checkpoint manifests', () => {
    expect(() => projectRepositoryPrefix('../project')).toThrow();
    expect(() => spaceGitCheckpointRef('space/a', 1)).toThrow();
    expect(() => spaceCheckpointManifestSchema.parse({ version: 1 })).toThrow();
  });

  it('accepts complete chunk inventories with either a full or partial final chunk', () => {
    const hash = `sha256:${'a'.repeat(64)}`;
    for (const finalSize of [1, CHECKPOINT_CHUNK_BYTES]) {
      expect(chunkedCheckpointManifestSchema.safeParse({
        version: 1,
        size: CHECKPOINT_CHUNK_BYTES + finalSize,
        chunks: [{ hash, size: CHECKPOINT_CHUNK_BYTES }, { hash, size: finalSize }],
      }).success).toBe(true);
    }
  });

  it('rejects incomplete, noncanonical, unsafe, or path-bearing chunk inventories', () => {
    const hash = `sha256:${'a'.repeat(64)}`;
    const full = { hash, size: CHECKPOINT_CHUNK_BYTES };
    const last = { hash, size: 1 };
    const valid = { version: 1, size: CHECKPOINT_CHUNK_BYTES + 1, chunks: [full, last] };
    for (const invalid of [
      { ...valid, chunks: [full] },
      { ...valid, chunks: [full, last, last] },
      { ...valid, chunks: [last, full] },
      { ...valid, size: valid.size + 1 },
      { ...valid, size: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, chunks: [full, { ...last, hash: '../other-object' }] },
      { ...valid, chunks: [full, { ...last, key: 'projects/other/checkpoint.enc' }] },
    ]) {
      expect(chunkedCheckpointManifestSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
