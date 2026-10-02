import type { InferenceExecutionContext } from '@gitspace/protocol';

export function inferenceContext(projectId: string | null, profileId = 'default', revision = 0): InferenceExecutionContext {
  return {
    version: 1,
    projectId,
    assignmentRevision: projectId === null ? null : revision,
    profile: { version: 1, id: profileId, name: profileId, revision, settings: {}, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    advanced: { generation: 1, content: '{}', checksum: `sha256:${'0'.repeat(64)}`, updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'test' },
    broker: { url: `https://broker.invalid/profiles/${profileId}`, token: `scope-${profileId}` },
  };
}
