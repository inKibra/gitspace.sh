import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { UserSkillsDO } from '../src/user-skills.js';

describe('UserSkillsDO', () => {
  it('provides GitSpace defaults and persists optimistic overrides', async () => {
    const namespace = env.USER_SKILLS as DurableObjectNamespace<UserSkillsDO>;
    const skills = namespace.get(namespace.idFromName(`skills-${crypto.randomUUID()}`));
    const defaults = await skills.list();
    expect(defaults.map((skill) => skill.id)).toContain('review-guide-narrator');
    expect(defaults.map((skill) => skill.id)).toContain('workspace-services');
    expect(defaults.map((skill) => skill.id)).toContain('integration-code-mode');
    const goal = defaults.find((skill) => skill.id === 'space-goal')!;
    const assignments = [{ projectId: 'project-a', projectSpaceEnabled: true, workspacesEnabled: false }];
    const updated = await skills.update({ id: goal.id, expectedRevision: goal.revision, enabled: false, scope: 'all', exceptions: ['project-a'], assignments });
    expect(updated).toMatchObject({ enabled: false, scope: 'all', exceptions: ['project-a'], assignments, revision: 2 });
    expect((await skills.list()).find((skill) => skill.id === goal.id)).toMatchObject(updated);
  });
});
