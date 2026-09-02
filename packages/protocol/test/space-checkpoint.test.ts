import { describe, expect, it } from 'bun:test';
import {
  projectArtifactBlobKey,
  projectRepositoryPrefix,
  spaceAgentRoot,
  spaceArtifactManifestKey,
  spaceCheckpointManifestKey,
  spaceGitCheckpointRef,
  spaceHandoffRoot,
  spaceStorageRoot,
  spaceCheckpointManifestSchema,
} from '../src/space-checkpoint.js';

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
});
