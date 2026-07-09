import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Skill } from '@oh-my-pi/pi-coding-agent/extensibility/skills';

export const MANAGED_SKILL_NAMES = [
  'space-goal',
  'space-chain',
  'space-review',
  'space-notes',
  'space-process-config',
  'space-run-process',
  'space-event-logs',
  'space-artifacts',
  'phase-journal',
  'review-guide-narrator',
] as const;

const MANAGED_SOURCE_META = {
  provider: 'gitspace-managed',
  providerName: 'GitSpace Managed Defaults',
  level: 'native' as const,
};

export interface ManagedSessionBootstrap {
  skills: Skill[];
}

export type DiscoverSkillsFn = (
  cwd?: string,
  agentDir?: string,
) => Promise<{ skills: Skill[]; warnings?: unknown[] }>;

function extractFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim();
}

function parseManagedSkill(skillPath: string, content: string): Skill {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter = frontmatterMatch?.[1] ?? '';
  const fallbackName = dirname(skillPath).split(/[\\/]/).pop() ?? 'gitspace-skill';
  const name = extractFrontmatterValue(frontmatter, 'name') ?? fallbackName;
  const description = extractFrontmatterValue(frontmatter, 'description') ?? '';

  return {
    name,
    description,
    filePath: skillPath,
    baseDir: dirname(skillPath),
    source: 'gitspace-managed:native',
    _source: {
      ...MANAGED_SOURCE_META,
      path: skillPath,
    },
  };
}

export function getManagedSkillPaths(): string[] {
  return MANAGED_SKILL_NAMES.map((name) => fileURLToPath(new URL(`./skills/${name}/SKILL.md`, import.meta.url)));
}

export async function loadManagedDefaultSkills(): Promise<Skill[]> {
  const paths = getManagedSkillPaths();
  return Promise.all(paths.map(async (skillPath) => parseManagedSkill(skillPath, await readFile(skillPath, 'utf8'))));
}

export function mergeManagedSkills(discoveredSkills: Skill[], managedSkills: Skill[]): Skill[] {
  const merged = new Map<string, Skill>();
  for (const skill of discoveredSkills) {
    merged.set(skill.name, skill);
  }
  for (const skill of managedSkills) {
    merged.set(skill.name, skill);
  }
  return Array.from(merged.values());
}

export async function getManagedSessionBootstrap(
  cwd: string,
  agentDir: string,
  discoverSkills: DiscoverSkillsFn,
): Promise<ManagedSessionBootstrap> {
  const [discoveredResult, managedSkills] = await Promise.all([
    discoverSkills(cwd, agentDir),
    loadManagedDefaultSkills(),
  ]);

  return {
    skills: mergeManagedSkills(discoveredResult.skills, managedSkills),
  };
}
