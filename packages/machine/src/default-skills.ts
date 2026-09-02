import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REVIEW_GUIDE_NARRATOR = `---
name: review-guide-narrator
description: Delegate and write a reviewable Change Guide grounded in the typed Journal and current Git diff. Use when asked to generate or refresh the Change Guide.
---

# Review Guide Narrator

Turn the analyzed diff into the PR as a build-order story, not a file inventory.

## Process

1. Call the GitSpace Change Guide analyze tool for the current space and base ref.
2. Delegate one focused narrator subagent. Give it the complete typed worksheet.
3. Narrate only clusters marked stale, in worksheet order. Unchanged cached sections carry forward automatically.
4. For each stale cluster:
   - inspect only its listed files and diff;
   - ground motivation in the cluster's Journal entries and decisions;
   - treat missing Journal grounding as uncertainty, never invent intent;
   - mark slow-read exhibits only where reviewer judgment is required;
   - use risk, decision, or mechanical callouts deliberately;
   - claim a requirement only when the cluster Journal reports that requirement advanced.
5. Submit the complete stale narration through the GitSpace Change Guide submit tool.
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
Use the GitSpace Goal tools as the source of truth. Keep requirements observable, attach evidence by stable reference, and never mark work accepted without the configured judge or human decision.`);
const SPACE_CHAIN = gitSpaceSkill('space-chain', 'Reason about related project spaces and their ordered goal chain.', `
Use stable project and space identities. Explain dependencies and stack order explicitly; never infer a session id is a durable workspace target.`);
const SPACE_REVIEW = gitSpaceSkill('space-review', 'Review current files and Git diffs with durable typed threads.', `
Use the Inspector repository modes for Current, Working, Staged, and Base. Anchor comments to generation plus Git object identity, and preserve stale threads rather than silently relocating them.`);
const SPACE_ARTIFACTS = gitSpaceSkill('space-artifacts', 'Publish and attach durable workspace evidence artifacts.', `
Treat artifacts as evidence and user outputs, never as hidden authority projections. Use local:// workspace or base scope, preserve media type, and attach the returned hash and generation to Goal, Rubric, or Journal evidence.`);
const PHASE_JOURNAL = gitSpaceSkill('phase-journal', 'Record phase narrative, decisions, snapshots, and state deltas.', `
Start a typed Journal phase before material work and end it with outcome, decisions, surprises, repository identity, and any revert. Append narrative and artifact entries instead of rewriting history.`);
const WORKSPACE_SERVICES = gitSpaceSkill('workspace-services', 'Declare and run stable-port workspace services through OMP Hub.', `
Declare durable services in .gitspace/services.json with name, command, args, cwd, env, and named ports. Start and stop them through GitSpace so OMP Hub owns the process and GitSpace injects stable PORT values. Verify the local health URL before reporting readiness.`);
const INTEGRATION_CODE_MODE = gitSpaceSkill('integration-code-mode', 'Discover and compose project-granted MCP tools from executable JavaScript.', `
Use the discoverable \`mcp_code\` tool when a task needs several MCP calls, filtering, loops, joins, pagination, or bounded aggregation.

The code is an async-function body. Return the final value. The live, grant-scoped API is:

- \`integrations.search(query, { limit? })\`
- \`integrations.describe(name)\`
- \`integrations.call(name, args)\`
- \`integrations.use(connectionId).searchTools(query)\`
- \`integrations.use(connectionId).describeTool(name)\`
- \`integrations.use(connectionId).tool(name, args)\`
- \`tools[ompToolName](args)\`
- \`ALL_TOOLS\`

Search before guessing names. Describe a tool before supplying unfamiliar arguments. Prefer direct named tools for one simple call, questions, approval-sensitive operations, or rich binary output. Use code mode to keep intermediate results out of model context. Provider and MCP credentials are never available to the code. Respect cancellation and output bounds.`);


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
