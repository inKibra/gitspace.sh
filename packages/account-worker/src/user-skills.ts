import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_GITSPACE_SKILLS, skillUpdateSchema, skillViewSchema, type SkillUpdate, type SkillView } from '@gitspace/protocol/skills-contract';

interface SkillOverrideRow extends Record<string, SqlStorageValue> {
  skill_id: string;
  revision: number;
  enabled: number;
  scope: SkillView['scope'];
  exceptions_json: string;
  assignments_json: string | null;
}

export class SkillRevisionConflict extends Error {
  constructor(readonly skillId: string, readonly expected: number, readonly actual: number) {
    super(`Skill ${skillId} revision changed from ${expected} to ${actual}`);
    this.name = 'SkillRevisionConflict';
  }
}

export class UserSkillsDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS user_skill_overrides (
        skill_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        scope TEXT NOT NULL CHECK (scope IN ('project','workspaces','all')),
        exceptions_json TEXT NOT NULL
      )
    `);
    try {
      ctx.storage.sql.exec(`ALTER TABLE user_skill_overrides ADD COLUMN assignments_json TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // Existing objects already migrated.
    }
  }

  list(): SkillView[] {
    const overrides = new Map(this.ctx.storage.sql.exec<SkillOverrideRow>('SELECT skill_id, revision, enabled, scope, exceptions_json, assignments_json FROM user_skill_overrides').toArray().map((row) => [row.skill_id, row]));
    return DEFAULT_GITSPACE_SKILLS.map((skill) => {
      const override = overrides.get(skill.id);
      return skillViewSchema.parse(override ? {
        ...skill,
        enabled: override.enabled === 1,
        scope: override.scope,
        exceptions: JSON.parse(override.exceptions_json),
        assignments: JSON.parse(override.assignments_json ?? '[]'),
        revision: override.revision,
      } : { ...skill, revision: 1 });
    });
  }

  update(inputValue: SkillUpdate): SkillView {
    const input = skillUpdateSchema.parse(inputValue);
    const defaults = DEFAULT_GITSPACE_SKILLS.find((skill) => skill.id === input.id);
    if (!defaults) throw new Error(`Skill ${input.id} does not exist`);
    const current = this.ctx.storage.sql.exec<SkillOverrideRow>('SELECT skill_id, revision, enabled, scope, exceptions_json, assignments_json FROM user_skill_overrides WHERE skill_id = ?', input.id).toArray()[0];
    const actual = current?.revision ?? 1;
    if (actual !== input.expectedRevision) throw new SkillRevisionConflict(input.id, input.expectedRevision, actual);
    const revision = actual + 1;
    const assignments = [...input.assignments]
      .sort((left, right) => left.projectId.localeCompare(right.projectId))
      .filter((assignment, index, values) => index === 0 || assignment.projectId !== values[index - 1]!.projectId);
    this.ctx.storage.sql.exec(
      'INSERT INTO user_skill_overrides(skill_id, revision, enabled, scope, exceptions_json, assignments_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(skill_id) DO UPDATE SET revision = excluded.revision, enabled = excluded.enabled, scope = excluded.scope, exceptions_json = excluded.exceptions_json, assignments_json = excluded.assignments_json',
      input.id, revision, input.enabled ? 1 : 0, input.scope, JSON.stringify([...new Set(input.exceptions)].sort()), JSON.stringify(assignments),
    );
    return { ...defaults, enabled: input.enabled, scope: input.scope, exceptions: [...new Set(input.exceptions)].sort(), assignments, revision };
  }
}
