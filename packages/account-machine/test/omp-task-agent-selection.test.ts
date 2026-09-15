import { describe, expect, it } from 'bun:test';
import { Settings } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts';
import { resolveEffectiveSubagentPolicy } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/task/structured-subagent.ts';
import { taskSchema } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/task/types.ts';

function session() {
  return {
    cwd: process.cwd(),
    settings: Settings.isolated(),
    getSessionSpawns: () => '*',
  } as never;
}

describe('OMP task agent selection', () => {
  it('does not expose a per-call model selector', () => {
    const parsed = taskSchema({ task: 'inspect', model: 'pi/smol' });

    expect(parsed).toEqual({ agent: 'task', task: 'inspect' });
    expect(parsed).not.toHaveProperty('model');
  });

  it('rejects agent names that were not discovered', async () => {
    await expect(resolveEffectiveSubagentPolicy({
      session: session(),
      invocationKind: 'task',
      assignment: 'inspect',
      agent: 'not-a-discovered-agent',
    })).rejects.toThrow('Unknown agent "not-a-discovered-agent"');
  });
});
