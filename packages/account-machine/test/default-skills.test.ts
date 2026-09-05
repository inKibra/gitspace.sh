import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'bun:test';
import { installDefaultGitSpaceSkills } from '../src/default-skills.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('default GitSpace skills', () => {
  it('installs eval-native Space and MCP instructions without standalone code tools', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'gitspace-skills-'));
    roots.push(agentDir);
    await installDefaultGitSpaceSkills(agentDir);

    const integration = await readFile(join(agentDir, 'skills', 'integration-code-mode', 'SKILL.md'), 'utf8');
    const goal = await readFile(join(agentDir, 'skills', 'space-goal', 'SKILL.md'), 'utf8');
    const journal = await readFile(join(agentDir, 'skills', 'phase-journal', 'SKILL.md'), 'utf8');
    expect(integration).toContain('normal JavaScript `eval` tool');
    expect(integration).toContain('`mcp.call({ name, args })`');
    expect(integration).not.toContain('mcp_code');
    expect(goal).toContain('`space.goal.put(input)`');
    expect(journal).toContain('`space.journal.list/startPhase/endPhase/append`');
  });
});
