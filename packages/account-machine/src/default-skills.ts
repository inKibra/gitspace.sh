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
Use JavaScript \`eval\` and the injected typed cloud authority. All methods default to the current workspace; pass \`workspaceId\` to read or edit another workspace in this project, including one that is closed or running elsewhere. Instruction edits never open it.

- \`space.goal.get({ workspaceId })\`, \`space.workflow.get({ workspaceId })\`, \`space.rubric.get({ workspaceId })\`
- \`space.describe({ method: 'goal.put' })\` (or \`workflow.put\`, \`rubric.put\`, \`goal.attachEvidence\`, \`rubric.judge\`) returns the exact input schema.
- \`space.goal.put({ workspaceId, expectedRevision, goal })\`, \`space.workflow.put({ workspaceId, expectedRevision, workflow })\`, \`space.rubric.put({ workspaceId, expectedRevision, rubric })\`
- Preserve the revision returned by get; use 0 only to create an absent record. A stale write rejects: reload and reconcile rather than blindly retry.

The host supplies projectId and spaceId; never send a foreign project or infer workspace identity from a session id. Changes become the affected agent's instructions at its next turn boundary, without interrupting tools or starting an idle turn. Keep requirements observable, attach evidence by stable reference, and never claim a human decision or judge result that did not happen.`);
const SPACE_CHAIN = gitSpaceSkill('space-chain', 'Discover and manage workspaces and their goals within the current project.', `
Use JavaScript \`eval\` with the injected \`space\` namespace:
- \`space.current()\` inspects this workspace; \`space.get({ workspaceId })\` inspects an explicit same-project workspace without opening it.
- \`space.list()\` (also \`space.chain.list()\`) lists canonical definitions, lifecycle, placement state/generation, and goals, including closed workspaces.
- \`space.create({ name, branch, phase, sourceKind, sourceRef, dependsOn?, goal?, workflow?, rubric? })\` creates a real workspace through the project lifecycle and writes optional initial typed instructions with revision 0. Call \`space.describe({ method: 'create' })\` for draft schemas. All drafts validate before creation. Check \`ready\`: a later authority failure returns \`ready: false\`, the created identity, completed instruction writes, and an error; reconcile that workspace rather than recreating it. phase is plan/code/review/ship; sourceKind is base/branch/workspace/pull-request.
- \`space.setPhase({ workspaceId, expectedRevision, phase })\` and \`space.setRelations({ workspaceId, expectedRevision, dependsOn, relatedTo, stackedOn })\` manage a workspace held open here. Dependencies enforce phase ceilings and reject cycles or foreign projects.
- \`space.open({ workspaceId, expectedGeneration })\` and \`space.close({ workspaceId, expectedGeneration })\` use checkpoint-backed lifecycle, not filesystem workarounds.
- \`space.archive({ workspaceId, expectedGeneration, expectedRevision })\` and \`space.restore({ workspaceId, expectedGeneration, expectedRevision })\` manage archived workspaces.

Use revision and generation from the latest discovery result. Targets default to current where optional. An agent cannot close/archive its own workspace from a running tool; use another workspace or the UI. Do not move or delegate agents, link projects, or invent separate planned-goal objects. Goal, Workflow, and Rubric editing is cloud-only and does not require opening the target.`);
const SPACE_REVIEW = gitSpaceSkill('space-review', 'Review current files and Git diffs with durable typed threads.', `
Use repository tools for files and diffs, then use \`space.review.list/create/append/resolve\` inside JavaScript \`eval\` for durable threads. Anchor comments to generation plus Git object identity, and preserve stale threads rather than silently relocating them.`);
const SPACE_ARTIFACTS = gitSpaceSkill('space-artifacts', 'Publish and attach durable workspace evidence artifacts.', `
Use \`local://base/<path>\` and \`local://workspace/<path>\` through normal read/write or JavaScript \`eval\` helpers. Project sessions may write base artifacts. Workspace sessions may read base artifacts and write workspace artifacts; the host rejects every other mount or access. Successful artifact tool writes publish changes for browser views. Use \`space.artifacts.listScopes()\` and \`space.artifacts.listPromotions()\` for canonical metadata. Copying workspace files into project artifacts and creating or revoking public links are user actions in the browser, not agent APIs. Copies are independent files; do not link or roll up artifact scopes.`);
const PHASE_JOURNAL = gitSpaceSkill('phase-journal', 'Record phase narrative, decisions, snapshots, and state deltas.', `
Use \`space.journal.list/startPhase/endPhase/append\` inside JavaScript \`eval\`. Start a typed phase before material work and end it with outcome, decisions, surprises, repository identity, and any revert. Append entries instead of rewriting history.`);
const WORKSPACE_SERVICES = gitSpaceSkill('workspace-services', 'Declare and run stable-port workspace services through OMP Hub.', `
Declare durable services in .gitspace/services.json with name, command, args, cwd, env, and named ports. Start and stop them through OMP Hub so it owns the process and GitSpace injects stable PORT values. Verify the local health URL before reporting readiness.`);
const WORKSPACE_LIFECYCLE = gitSpaceSkill('workspace-lifecycle', 'Inspect a repository and configure approved, portable workspace lifecycle scripts. Use for repository setup, machine preparation, cloud resource adoption, and lifecycle migration.', `
Configure the repository from its normal workspace agent. Do not create a separate setup agent, provisioning system, approval store, or resource ledger. Selecting a workspace or creating its cloud definition is not permission to set it up.

## Inspect before proposing

1. Read the repository instructions, package manifests and lockfiles, CI workflows, tool-version files, infrastructure definitions, existing .gitspace/bundle.json, lifecycle scripts, and service declarations. Inspect only relevant paths. Do not execute repository scripts during discovery.
2. Read the current environment through the shared environment API. Inspect its selected profile, effective values, secret names, approvals, durable resource bindings, successful provisioning record, and run logs. Use the cloud ledger rather than inferring resource ownership from this checkout or a local database.
3. Identify existing resource IDs and remote infrastructure state before proposing new resources. Preserve canonical repository origin. Never assume a missing local checkout means a resource is absent.
4. Propose exact files, profiles, checks, values, secret references, service declarations, phase split, expected costs, external effects, and recovery/destruction behavior. Distinguish disposable caches and ignored files from durable data.

## Obtain approval to edit

Ask the human to approve the proposed repository changes before editing. This approves configuration edits only, not installs, checks, cloud operations, or destruction. Do not infer approval from the setup request, a previous approval for different content, or your own tool permissions.

Keep .gitspace/bundle.json version 1. The base profile is required; selected profiles add its checks, secrets, and values. Reuse existing declarations rather than adding a second manifest. Scripts belong in .gitspace/lifecycle/<phase>/<ordered-name>[.<profile>].sh, for example 10-dependencies.sh or 20-preview.preview.sh. Use zero-padded ordering. Unqualified and .base.sh scripts apply to every profile.

Split effects by lifetime:
- cloud/provision: create or adopt workspace-owned remote resources once per durable workspace identity.
- machine/prepare: prepare tools for this account, project, machine, profile, and approved content.
- workspace/materialize: recreate checkout-local dependencies, generated configuration, and caches on each arrival.
- workspace/dematerialize: flush local state and release local leases before a checkpoint and checkout removal. Never destroy remote resources here.
- cloud/destroy: delete only the explicitly recorded workspace-owned resources, after separate retirement authorization.
- checks: verify prerequisites through bundle checks; it is not a lifecycle directory.

Missing phases need no placeholder scripts. Keep long-running services in .gitspace/services.json under OMP Hub ownership, not background shell processes.

## Validate without executing effects

After edit approval, make the agreed changes, inspect the diff, parse the manifest with the existing schema, and check shell syntax without running script bodies. Read CI commands before deciding they are safe. Do not use a script's dry-run flag as proof that it has no effects. Report what validation actually ran and any missing prerequisites.

Show the final commands, content hashes, selected profile, target workspace/machine, required secret names, resource IDs to adopt, and planned external changes. Ask for separate execution authorization. The human grants content approval through the existing Environment controls; never self-approve a new hash, forge an approval, or bypass the shared runner with bash.

Explain that content approval permits repository code to run as the machine user; it is not sandboxing. Review invoked helpers, install hooks, tools, and remote payloads too. Hashing an entry script does not pin its transitive dependencies. Redaction does not prevent arbitrary secret exfiltration or make unsafe output safe.

## Execute and inspect shared state

Use JavaScript eval with space.environment.get to inspect current state. Discover input schemas with space.describe({ method: 'environment.runPhase' }) and the other environment method names before calling them. The shared namespace exposes get, setProfile, putValue, deleteValue, runChecks, runPhase, and runLog. Use these for execution and durable logs; never write the lifecycle ledger directly. Content approval, uncertain-run recovery, and cloud/destroy are browser-only actions, not agent APIs.

Initial setup is an explicit cloud/provision request. It enables the automatic policy, then runs approved machine/prepare, checks, cloud/provision, and workspace/materialize in order, stopping on failure. An empty provisioning phase still records successful local-only setup. Successful provision is durable and must not repeat just because the workspace moved, reopened, changed profile, or changed script content. Automatic local preparation on later arrivals requires both the policy and successful provision; it runs machine/prepare, checks, and workspace/materialize without gating workspace access on failure. A failed or uncertain cloud run requires inspection and an explicit recovery decision, not a background retry. An explicit rerun needs fresh authorization for its effects.

Scripts receive GITSPACE_LIFECYCLE_BINDINGS as a phase-start JSON snapshot. Publish non-secret resource IDs or URLs to the shared GITSPACE_LIFECYCLE_OUTPUT file as JSON with a bindings object. The runner persists observed partial bindings during execution and reads them again at phase completion, including failure. Record each resource immediately after creation with an atomic temporary-file rename. Later scripts in that phase must read the shared output file and preserve earlier bindings. Keep it within 64 KiB. A resource created before its ID reaches the cloud still needs provider-side reconciliation.

Use GITSPACE_PROJECT_ID and GITSPACE_WORKSPACE_ID for durable identity, GITSPACE_MACHINE_ID for runner identity, GITSPACE_WORKSPACE_GENERATION for the checkout, and GITSPACE_ENVIRONMENT_PROFILE for the selected profile. Reuse and verify existing resource IDs; never silently replace them. Do not put credentials or secret values in bindings, logs, repository files, or command arguments. Declare secret names in the profile and use the existing project secret store.

Each run has a clean temporary HOME and runner-controlled PATH. Machine preparation should install durable tools into GITSPACE_MACHINE_TOOLS; its bin directory leads the lifecycle PATH. Do not assume user dotfiles, home-directory tools, or ambient credentials are present.

Lifecycle .sh files execute approved bytes with /bin/bash; command checks use /bin/sh. The working directory is the checkout root. Use $0 for an entry script's location, not BASH_SOURCE, when finding adjacent helpers.

Inspect the durable run result and logs after execution. Report partial resources even if the phase failed. Keep the last successful provisioning identity after a failed rerun. On ambiguous interruption, inspect provider state before the human authorizes recovery. Closing, moving, archiving, or selecting a workspace does not authorize cloud/destroy.

## Migrate legacy hooks

Treat pre/setup/select/remove configuration as migration work, not executable aliases. Classify every old command by effect; do not mechanically rename directories. Lift remote creation into cloud/provision, machine installs into machine/prepare, checkout-local work into workspace/materialize, local flush/release into workspace/dematerialize, and remote deletion into cloud/destroy. Remove obsolete hooks after approval. Adopt existing resource IDs before any execution so migration cannot create a second stack.

Explain persistence before handoff: checkpoints preserve tracked changes and non-ignored untracked files, not ignored .env files, node_modules, machine packages, or arbitrary home-directory files. Rebuild local state on materialization. Keep durable data in explicit remote resources. Preparation failure must not block access to the workspace; failed dematerialization or checkpointing must not delete its checkout.`);
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
  'workspace-lifecycle': WORKSPACE_LIFECYCLE,
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
