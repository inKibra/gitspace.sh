import { describe, expect, it } from 'bun:test';

/**
 * Canary for the GitSpace patch on @oh-my-pi/pi-coding-agent that forces agents
 * to address models by ROLE rather than by model id.
 *
 * Agents could hardcode a concrete model in an eval spawn —
 * `agent(prompt, agent='Tester', model='gpt-5.5')` — which silently opts out of
 * the operator's role config, rots when model ids change, and makes spend
 * unattributable to a role. The `task` tool never had this hole (its input
 * schema has no `model` key), so eval's `agent()` is the only surface, and the
 * patch guards it in `eval/agent-bridge.ts` via `assertRoleOnlyModelSelector`.
 *
 * This test exists because the guard lives in a PATCHED DEPENDENCY: an SDK
 * upgrade that drops or fails to port the patch would silently re-open the
 * hole. Failing here is the signal to re-apply it (see patches/).
 */

/**
 * NOTE the `as unknown as` casts below: the patch edits the package's `src/`
 * (which is what actually runs — the package's export map points at
 * `./src/*.ts`), while its published `dist/types/*.d.ts` stay unpatched. So TS
 * cannot see the added export even though it exists at runtime. That mismatch
 * is expected, not a smell.
 */
interface RoleOnlyGuard {
  assertRoleOnlyModelSelector?: (value: string | string[] | undefined, settings?: unknown) => void;
}

/** Minimal Settings stand-in: only what getKnownRoleIds + the guard read. */
const settingsStub = {
  get: (key: string) => (key === 'cycleOrder' ? ['default', 'smol', 'my_custom'] : {}),
  getModelRoles: () => ({ default: 'openai-codex/gpt-5.5', smol: 'x', my_custom: 'q' }),
  getModelRole: (role: string) =>
    ({ default: 'openai-codex/gpt-5.5', smol: 'x', my_custom: 'q' })[role],
};

describe('role-only model selection (patched SDK guard)', () => {
  it('is still present after any SDK install/upgrade', async () => {
    const mod = (await import('@oh-my-pi/pi-coding-agent/config/model-resolver')) as RoleOnlyGuard;
    expect(typeof mod.assertRoleOnlyModelSelector).toBe('function');
  });

  it('rejects a concrete model id and names the alternatives', async () => {
    const { assertRoleOnlyModelSelector } = (await import(
      '@oh-my-pi/pi-coding-agent/config/model-resolver'
    )) as unknown as Required<RoleOnlyGuard>;

    expect(() => assertRoleOnlyModelSelector('gpt-5.5', settingsStub)).toThrow(/must name a role/);
    expect(() => assertRoleOnlyModelSelector('openai-codex/gpt-5.5', settingsStub)).toThrow(/must name a role/);
    // An agent name in the model slot is also wrong — the message must point at `agent=`.
    expect(() => assertRoleOnlyModelSelector('Tester', settingsStub)).toThrow(/agent=<name>/);
    // A mixed list is rejected on the offending entry, not silently accepted.
    expect(() => assertRoleOnlyModelSelector(['pi/smol', 'anthropic/claude-fable-5'], settingsStub)).toThrow(
      /claude-fable-5/,
    );
  });

  it('accepts ANY role under settings > Models — bound or not, built-in or custom', async () => {
    const { assertRoleOnlyModelSelector } = (await import(
      '@oh-my-pi/pi-coding-agent/config/model-resolver'
    )) as unknown as Required<RoleOnlyGuard>;

    // Bound built-in.
    expect(() => assertRoleOnlyModelSelector('pi/smol', settingsStub)).not.toThrow();
    // UNBOUND built-ins must pass: the constraint is "name a role", not "name a
    // role you already configured", and it is not limited to the quick cycle.
    expect(() => assertRoleOnlyModelSelector('pi/vision', settingsStub)).not.toThrow();
    expect(() => assertRoleOnlyModelSelector('pi/advisor', settingsStub)).not.toThrow();
    // Custom role introduced via cycleOrder / modelRoles / modelTags.
    expect(() => assertRoleOnlyModelSelector('pi/my_custom', settingsStub)).not.toThrow();
    // Thinking suffix is part of the role selector vocabulary.
    expect(() => assertRoleOnlyModelSelector('pi/slow:xhigh', settingsStub)).not.toThrow();
    // Omitted ⇒ inherit the session model, the desired default.
    expect(() => assertRoleOnlyModelSelector(undefined, settingsStub)).not.toThrow();
  });

  it('keeps the `task` tool free of a model key (nothing to guard there)', async () => {
    // The task tool takes its model from human-controlled config (settings
    // agentModelOverrides + agent frontmatter), never from the calling agent.
    // If a future SDK adds a `model` input here, this test fails and the guard
    // must be extended to that surface too.
    const { taskSchema } = (await import('@oh-my-pi/pi-coding-agent/task/types')) as {
      taskSchema: { json?: unknown };
    };
    expect(JSON.stringify(taskSchema.json ?? taskSchema)).not.toContain('"model"');
  });
});
