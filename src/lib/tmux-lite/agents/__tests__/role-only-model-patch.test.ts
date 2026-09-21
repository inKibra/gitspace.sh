import { describe, expect, it } from 'bun:test';
import { assertRoleOnlyModelSelector } from '@oh-my-pi/pi-coding-agent/config/model-resolver';
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings';
import { runEvalAgent } from '@oh-my-pi/pi-coding-agent/eval/agent-bridge';

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


describe('role-only model selection (patched SDK guard)', () => {
  it('rejects a concrete model id and names the alternatives', () => {
    expect(() => assertRoleOnlyModelSelector('gpt-5.5')).toThrow(/must name a role/);
    expect(() => assertRoleOnlyModelSelector('openai-codex/gpt-5.5')).toThrow(/must name a role/);
    // An agent name in the model slot is also wrong — the message must point at `agent=`.
    expect(() => assertRoleOnlyModelSelector('Tester')).toThrow(/agent=<name>/);
    // A mixed list is rejected on the offending entry, not silently accepted.
    expect(() => assertRoleOnlyModelSelector(['pi/smol', 'anthropic/claude-fable-5'])).toThrow(
      /claude-fable-5/,
    );
  });

  it('accepts model= at the eval boundary, then rejects concrete ids and agent/model combinations', async () => {

    const session = {
      getSessionSpawns: () => '*',
      settings: Settings.isolated(),
    } as never;

    await expect(runEvalAgent({ prompt: 'test', model: 'gpt-5.5' }, { session })).rejects.toThrow(
      /must name a role/,
    );
    await expect(
      runEvalAgent({ prompt: 'test', agent: 'scout', model: 'pi/smol' }, { session }),
    ).rejects.toThrow(/takes either agent=/);

  });

});
