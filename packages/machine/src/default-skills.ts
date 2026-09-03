import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REVIEW_GUIDE_NARRATOR = `---
name: review-guide-narrator
description: Delegate and write a reviewable Change Guide grounded in the typed Journal and current Git diff. Use when asked to generate or refresh the Change Guide.
---

# Review Guide Narrator

Turn the analyzed diff into the PR as a build-order story, not a file inventory.

## Process

1. In JavaScript \`eval\`, call \`space.current()\` to load current typed context.
2. Call \`space.guide.get()\`; inspect the current Git diff with repository tools.
3. Delegate one focused narrator subagent with the complete typed context and diff clusters.
4. Narrate stale clusters in reader order. Ground motivation in \`space.journal.list()\`; never invent missing intent.
5. Submit the complete guide with \`space.guide.put(input)\`.
6. Fix every validation error and resubmit until accepted.

## Hard rules

- HEAD and base ref must match the worksheet.
- Reader order is authoritative.
- Every stale cluster must have one section.
- Section id and content hash must match its cluster.
- Exhibits must belong to the cluster.
- Keep each section readable in under one minute.
`;

function gitSpaceSkill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body.trim()}\n`;
}

const SPACE_GOAL = gitSpaceSkill('space-goal', 'Manage typed Goal intent, requirements, evidence, and decisions.', `
Use JavaScript \`eval\` and the injected \`space.goal\` namespace as the source of truth:
- \`space.goal.get()\`
- \`space.goal.put(input)\`
- \`space.goal.attachEvidence(input)\`

Current project and space ids are injected by the host. Keep requirements observable, attach evidence by stable reference, and never mark work accepted without the configured judge or human decision.`);
const SPACE_CHAIN = gitSpaceSkill('space-chain', 'Reason about related project spaces and their ordered goal chain.', `
Use \`space.current()\`, \`space.list()\`, and \`space.chain.list()\` inside JavaScript \`eval\`. Stable project and space identities come from the host; never infer a session id is a durable workspace target.`);
const SPACE_REVIEW = gitSpaceSkill('space-review', 'Review current files and Git diffs with durable typed threads.', `
Use repository tools for files and diffs, then use \`space.review.list/create/append/resolve\` inside JavaScript \`eval\` for durable threads. Anchor comments to generation plus Git object identity, and preserve stale threads rather than silently relocating them.`);
const SPACE_ARTIFACTS = gitSpaceSkill('space-artifacts', 'Publish and attach durable workspace evidence artifacts.', `
Use \`local://base/<path>\` and \`local://workspace/<path>\` through normal read/write or JavaScript \`eval\` helpers. Project sessions may write base artifacts. Workspace sessions may read base artifacts and write workspace artifacts; the host rejects every other mount or access. Use \`space.artifacts.listScopes()\` and \`space.artifacts.listPromotions()\` for canonical metadata.`);
const PHASE_JOURNAL = gitSpaceSkill('phase-journal', 'Record phase narrative, decisions, snapshots, and state deltas.', `
Use \`space.journal.list/startPhase/endPhase/append\` inside JavaScript \`eval\`. Start a typed phase before material work and end it with outcome, decisions, surprises, repository identity, and any revert. Append entries instead of rewriting history.`);
const WORKSPACE_SERVICES = gitSpaceSkill('workspace-services', 'Declare and run stable-port workspace services through OMP Hub.', `
Declare durable services in .gitspace/services.json with name, command, args, cwd, env, and named ports. Start and stop them through OMP Hub so it owns the process and GitSpace injects stable PORT values. Verify the local health URL before reporting readiness.`);
const INTEGRATION_CODE_MODE = gitSpaceSkill('integration-code-mode', 'Discover and compose project-granted MCP tools from executable JavaScript.', `
Use the normal JavaScript \`eval\` tool. GitSpace injects one grant-scoped \`mcp\` namespace:

- \`mcp.list()\`
- \`mcp.search({ query, limit? })\`
- \`mcp.describe({ name })\`
- \`mcp.call({ name, args })\`

Search before guessing names. Describe unfamiliar tools before calling them. Compose loops, filtering, joins, pagination, and bounded aggregation in one eval cell so intermediate results stay out of model context. An empty grant set produces an empty catalog. Provider and MCP credentials are never exposed.`);


const DEFAULT_SKILLS: Readonly<Record<string, string>> = {
  'space-goal': SPACE_GOAL,
  'space-chain': SPACE_CHAIN,
  'space-review': SPACE_REVIEW,
  'space-artifacts': SPACE_ARTIFACTS,
  'phase-journal': PHASE_JOURNAL,
  'review-guide-narrator': REVIEW_GUIDE_NARRATOR,
  'workspace-services': WORKSPACE_SERVICES,
  'integration-code-mode': INTEGRATION_CODE_MODE,
};

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
