import { afterEach, describe, expect, it } from 'bun:test';
import { Settings } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/config/settings.ts';
import { runEvalAgent } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/eval/agent-bridge.ts';
import { disposeVmContextsByOwner } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/eval/js/context-manager.ts';
import { executeJs } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/eval/js/executor.ts';
import { executePython } from '../../../node_modules/@oh-my-pi/pi-coding-agent/src/eval/py/executor.ts';

const owners: string[] = [];

afterEach(async () => {
  for (const owner of owners.splice(0)) await disposeVmContextsByOwner(owner);
});

function session() {
  return {
    cwd: process.cwd(),
    settings: Settings.isolated(),
    getSessionSpawns: () => '*',
  } as never;
}

describe('OMP eval agent selection', () => {
  it('rejects a concrete model id before registering a background agent', async () => {
    await expect(runEvalAgent(
      { prompt: 'inspect', model: 'openai-codex/gpt-5.6-sol' },
      { session: session() },
    )).rejects.toThrow('model must name a role, not a model id');
  });

  it('rejects combining a named agent with a model role', async () => {
    await expect(runEvalAgent(
      { prompt: 'inspect', agent: 'scout', model: 'pi/smol' },
      { session: session() },
    )).rejects.toThrow('takes either agent="scout" or model=, not both');
  });

  it('enforces role selection through JavaScript background agent handles', async () => {
    const owner = crypto.randomUUID();
    owners.push(owner);
    const result = await executeJs('await agent("inspect", { model: "concrete-model-id" })', {
      cwd: process.cwd(),
      sessionId: `eval:${crypto.randomUUID()}`,
      kernelOwnerId: owner,
      session: session(),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('model must name a role, not a model id');
  });

  it('enforces role selection through Python background agent handles', async () => {
    const result = await executePython('agent("inspect", model="concrete-model-id")', {
      cwd: process.cwd(),
      sessionId: `python:${crypto.randomUUID()}`,
      kernelMode: 'per-call',
      toolSession: session(),
      timeoutMs: 30_000,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('model must name a role, not a model id');
  });
});
