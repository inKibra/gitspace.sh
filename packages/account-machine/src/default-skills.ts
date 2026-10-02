import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_SKILLS } from '@gitspace/protocol/default-skills';

export async function installDefaultGitSpaceSkills(agentDir: string, enabledSkillIds: readonly string[] = Object.keys(DEFAULT_SKILLS)): Promise<void> {
  for (const [name, source] of Object.entries(DEFAULT_SKILLS)) {
    const directory = join(agentDir, 'skills', name);
    if (!enabledSkillIds.includes(name)) {
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), source, 'utf8');
  }
}
