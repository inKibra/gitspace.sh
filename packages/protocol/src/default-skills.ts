const REVIEW_GUIDE_NARRATOR = `---
name: review-guide-narrator
description: Delegate and write a reviewable Change Guide grounded in the typed Journal and current Git diff. Use when asked to generate or refresh the Change Guide.
---

# Review Guide Narrator

Turn the analyzed diff into the PR as a build-order story, not a file inventory.

## Process

1. Use \`space_workspace({ args: { method: 'current' } })\` and the typed goal, workflow, and rubric tools to load context.
2. Call \`space_guide({ args: { method: 'get' } })\`; inspect the current Git diff with repository tools.
3. Delegate one focused narrator subagent with the complete typed context and diff clusters.
4. Narrate stale clusters in reader order. Ground motivation in \`space_journal({ args: { method: 'list' } })\`; never invent missing intent.
5. Read the guide input schema with \`space_guide({ args: { method: 'describe', operation: 'put' } })\`, then submit with method \`put\`.
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
Use the typed cloud tools directly, not a JavaScript space namespace. Pass optional workspaceId inside args to read or edit another workspace in this project, including one that is closed. Instruction edits never open it.

- \`space_goal({ args: { method: 'get', workspaceId } })\`; use space_workflow and space_rubric the same way.
- Each tool accepts \`{ args: { method: 'describe', operation: 'put' } }\` for its input schema.
- To write, supply \`{ args: { method: 'put', workspaceId, expectedRevision, goal } }\` to space_goal; use workflow or rubric with its matching tool. space_goal also supports attachEvidence.
- Preserve the revision returned by get; use 0 only to create an absent record. A stale write rejects: reload and reconcile rather than blindly retry.

The host supplies projectId and spaceId; never send a foreign project or infer workspace identity from a session id. Changes become the affected agent's instructions at its next turn boundary, without interrupting tools or starting an idle turn. Keep requirements observable, attach evidence by stable reference, and never claim a human decision or judge result that did not happen.`);
const SPACE_CHAIN = gitSpaceSkill('space-chain', 'Discover and manage workspaces and their goals within the current project.', `
Use typed workspace tools:
- \`space_workspace({ args: { method: 'current' } })\` inspects this workspace; method list returns project workspace definitions.
- \`space_workspace({ args: { method: 'create', name, branch, phase, sourceKind, sourceRef, dependsOn, goal, workflow, rubric } })\` creates a workspace and optional initial instructions. Omit optional fields rather than passing undefined. All drafts validate before creation. Check ready: a later authority failure returns ready:false, the created identity, completed writes, and an error. Reconcile that workspace rather than recreating it. Phase defaults to plan; explicit phases still enforce dependency ceilings.
- \`space_phase({ args: { phase: 'code' } })\` changes this workspace at its current revision. \`space_workspace\` method setRelations accepts expectedRevision, dependsOn, relatedTo, and stackedOn.
- Lifecycle methods open and restore take expectedGeneration; restore also takes expectedRevision. Use the latest authority values, never invented generations.

Mutating workspace tools act on the conversation's current workspace and primary attachment. An agent cannot close or archive its own workspace from a running tool; use the browser. Cloud goal, workflow, and rubric tools can target other workspaces without opening them.`);
const SPACE_REVIEW = gitSpaceSkill('space-review', 'Review current files and Git diffs with durable typed threads.', `
Use repository tools for files and diffs, then use \`space_review({ args: { method: 'list' } })\` for durable threads. Methods create, append, and resolve accept their typed fields inside args. Read the schema with method describe and operation set to the intended mutation. Anchor comments to generation plus Git object identity, and preserve stale threads rather than silently relocating them.`);
const SPACE_ARTIFACTS = gitSpaceSkill('space-artifacts', 'Publish and attach durable workspace evidence artifacts.', `
Use \`local://base/<path>\` and \`local://workspace/<path>\` through read/write tools. Project sessions may write base artifacts. Workspace sessions may read base artifacts and write workspace artifacts; the host rejects every other mount or access. Successful artifact tool writes publish changes for browser views. Use \`space_artifacts({ args: { method: 'listScopes' } })\` and method \`listPromotions\` for canonical metadata. Copying workspace files into project artifacts and creating or revoking public links are user actions in the browser, not agent APIs. Copies are independent files; do not link or roll up artifact scopes.`);
const PHASE_JOURNAL = gitSpaceSkill('phase-journal', 'Record phase narrative, decisions, snapshots, and state deltas.', `
Use \`space_journal({ args: { method: 'list' } })\` and methods startPhase, endPhase, and append. Read each mutation's schema with method describe and operation set to its name. Start a typed phase before material work and end it with outcome, decisions, surprises, repository identity, and any revert. Append entries instead of rewriting history.`);
const WORKSPACE_SERVICES = gitSpaceSkill('workspace-services', 'Declare stable-port workspace services and use supervised processes.', `
Declare durable services in .gitspace/services.json with name, command, args, cwd, env, and named ports. GitSpace's service manager injects stable PORT values and owns these processes through the machine supervisor. Use the Services controls to start or stop configured services. For separate agent-owned processes, use the proc tool. Never bypass protected lifecycle terminals or infer readiness from process creation; verify the health URL.`);
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

Missing phases need no placeholder scripts. Keep long-running services in .gitspace/services.json under machine supervisor ownership, not background shell processes.

## Bootstrap before publishing workspace changes

Initial setup must support dirty checkouts and workspace branches that do not exist on the remote. Separate provisioning a usable environment from deploying the workspace's changes. Never require a clean checkout, auto-commit, stash, discard edits, or publish unfinished work merely to initialize the environment.

If bootstrap needs an image, schema, or seed, resolve it from the recorded workspace creation source/base commit. Pin immutable artifact identity and record its actual source commit. Do not silently substitute a moving branch tip or infer the creation source from the current branch name. Inspect the available GitSpace metadata; report a missing source identity rather than inventing an environment variable or guessing. A bootstrap preview may run the base image while local development differs; make that distinction visible.

Reuse the repository's existing CI/deployment machinery where practical. An approved cloud/provision flow may ensure a remote bootstrap branch exists at the recorded starting commit, then dispatch an explicit preview-setup workflow with stable project/workspace identity and an explicit commit. Declare branch creation, workflow dispatch, credentials, costs, and resource changes as execution effects. Verify an existing remote branch; never force-update it or silently publish a different commit. Do not require a pull request. Local workflow edits are not remotely runnable until published; identify that rollout prerequisite and obtain separate approval to publish implementation changes.

Correlate the workflow run to the requested workspace and commit. Validate a machine-readable receipt containing confirmed non-secret resource references, immutable image/source identity, and the workflow run identity; publish its bindings through GITSPACE_LIFECYCLE_OUTPUT. Retain partial receipts on failure and reconcile provider state after uncertain interruption. A lost response is not permission to blindly dispatch another provisioning run. Keep credentials and secret output values out of receipts and bindings.

Derive collision-safe resource names from stable project/workspace identity, optionally with a readable name, and persist confirmed ownership. Renaming a workspace or branch must not redirect its resources. Verify existing resources before adoption; a matching name alone is not proof of ownership. Create isolated preview resources: do not copy another stack's infrastructure state or silently adopt staging/production resources. Database cloning or seeding must be an explicitly declared effect, not an assumed copy of base data.

Later workspace/materialize runs consume existing bindings and recreate local files. They must not push branches, dispatch preview deployments, or reprovision resources. Deployment of subsequently published workspace changes is a separate operation; exact-commit publication requirements belong there, not in initial bootstrap.

## Validate without executing effects

After edit approval, make the agreed changes, inspect the diff, parse the manifest with the existing schema, and check shell syntax without running script bodies. Read CI commands before deciding they are safe. Do not use a script's dry-run flag as proof that it has no effects. Report what validation actually ran and any missing prerequisites.

Show the final commands, content hashes, selected profile, target workspace/machine, required secret names, resource IDs to adopt, and planned external changes. Ask for separate execution authorization. The human grants content approval through the existing Environment controls; never self-approve a new hash, forge an approval, or bypass the shared runner with bash.

Explain that content approval permits repository code to run as the machine user; it is not sandboxing. Review invoked helpers, install hooks, tools, and remote payloads too. Hashing an entry script does not pin its transitive dependencies. Redaction does not prevent arbitrary secret exfiltration or make unsafe output safe.

## Execute and inspect shared state

Use \`environment({ args: { method: 'get' } })\` to inspect current state. The environment tool accepts get, setProfile, putValue, deleteValue, runChecks, runPhase, cancelRun, and runLog as its method. Supply a runId for execution and reuse it when retrying the same request. For runPhase also supply phase; runLog takes runId and optional offset. Execution returns the durable accepted run, not its final outcome; inspect shared state and runLog for completion. An optional deadlineAt bounds execution. cancelRun records a cancellation request; the run remains active until the runner confirms termination. Never write the lifecycle ledger directly. Content approval, uncertain-run recovery, interactive execution, and cloud/destroy require human control. Never fabricate human approval.

Initial setup is an explicit cloud/provision request. It enables the automatic policy, then runs approved machine/prepare, checks, cloud/provision, and workspace/materialize in order, stopping on failure. An empty provisioning phase still records successful local-only setup. Successful provision is durable and must not repeat just because the workspace moved, reopened, changed profile, or changed script content. Automatic local preparation on later arrivals requires both the policy and successful provision; it runs machine/prepare, checks, and workspace/materialize without gating workspace access on failure. A failed or uncertain cloud run requires inspection and an explicit recovery decision, not a background retry. An explicit rerun needs fresh authorization for its effects.

Prefer unattended, repeatable scripts. Check existing state before authentication, supply explicit flags for ordinary setup questions, and verify the result afterward. Use interactive execution only for unavoidable human authentication or decisions. Declare it with the exact line # gitspace: interactive in the script's leading comment header, before executable commands; the marker changes the approved content hash. Automatic preparation never opts in. After execution authorization, the human uses the browser's Run interactively control. Agents cannot request interactive execution. Checks remain noninteractive; detached recovery cannot accept interactive execution. Never rerun partially completed effects merely because a prompt failed.

Interactive runs use a protected Environment terminal attached only to the approved scripts. The first browser attachment releases execution; the run deadline includes that wait. The terminal shows ordered script progress and exit codes. On success or failure, input stops and bounded visible output stays in the open pane for inspection. Closing or reloading discards private output. A broken live connection also clears it; reconnection attaches to the same process with current safe progress but no raw-output replay. Input echo is disabled; raw input/output are not retained in Hub logs, run logs, browser history caches, or transcripts. Agents can inspect safe run metadata but cannot read or answer the protected terminal stream. Cancellation still requires confirmed process termination; closing a pane is not cancellation. Keep scripts foreground-owned and do not daemonize.

This is supervised machine-local authentication, not a central session store. Approved scripts may write a .env or provider credentials into ignored workspace-local files with restrictive permissions. Add ignore rules before writing and never log the values. Ignored credentials do not survive checkpoints or moves; expired sessions may require another human login. Do not promise automatic refresh, project-wide reuse, or cross-machine continuation.

Scripts receive GITSPACE_LIFECYCLE_BINDINGS as a phase-start JSON snapshot. Publish non-secret resource IDs or URLs to the shared GITSPACE_LIFECYCLE_OUTPUT file as JSON with a bindings object. The runner persists observed partial bindings during execution and reads them again at phase completion, including failure. Record each resource immediately after creation with an atomic temporary-file rename. Later scripts in that phase must read the shared output file and preserve earlier bindings. Keep it within 64 KiB. A resource created before its ID reaches the cloud still needs provider-side reconciliation.

Use GITSPACE_PROJECT_ID and GITSPACE_WORKSPACE_ID for durable identity, GITSPACE_MACHINE_ID for runner identity, GITSPACE_WORKSPACE_GENERATION for the checkout, and GITSPACE_ENVIRONMENT_PROFILE for the selected profile. Reuse and verify existing resource IDs; never silently replace them. Do not put credentials or secret values in bindings, logs, tracked or non-ignored repository files, or command arguments. Declare injected secret names in the profile and use the existing project secret store.

GITSPACE_WORKSPACE_SOURCE_COMMIT is the immutable resolved commit recorded when the workspace was created, not its current HEAD or the current source branch. It survives commits, renames, moves, and reopens. It is empty for legacy or base identities without proven creation provenance. If an exact starting commit is required and the value is empty, stop and report the missing provenance; never infer it from HEAD, sourceRef, a moving branch, or user-supplied environment values.

Lifecycle scripts inherit the machine user's HOME, PATH, and ordinary environment. GITSPACE_MACHINE_TOOLS/bin leads PATH, so managed tools take precedence over existing tools. Declared values and granted secrets override inherited values; internal GITSPACE_* bootstrap variables are excluded and the runner supplies its own workspace metadata. Run logs and output use a separate temporary directory, not a temporary HOME. Existing home configuration and credentials may be accessible: secret grants control GitSpace-injected secrets, not every credential on the machine. Use checks to verify tool versions and machine/prepare to install missing tools; do not reinstall tools solely because they live in the user's home. A cloud machine uses its own home, not a copy of the user's personal machine.

Lifecycle .sh files execute approved bytes with /bin/bash; command checks use /bin/sh. The working directory is the checkout root. Use $0 for an entry script's location, not BASH_SOURCE, when finding adjacent helpers.

Inspect the durable run result and logs after execution. Report partial resources even if the phase failed. Keep the last successful provisioning identity after a failed rerun. On ambiguous interruption, inspect provider state before the human authorizes recovery. Closing, moving, archiving, or selecting a workspace does not authorize cloud/destroy.

## Migrate legacy hooks

Treat pre/setup/select/remove configuration as migration work, not executable aliases. Classify every old command by effect; do not mechanically rename directories. Lift remote creation into cloud/provision, machine installs into machine/prepare, checkout-local work into workspace/materialize, local flush/release into workspace/dematerialize, and remote deletion into cloud/destroy. Remove obsolete hooks after approval. Adopt existing resource IDs before any execution so migration cannot create a second stack.

Explain persistence before handoff: checkpoints preserve tracked changes and non-ignored untracked files, not ignored .env files, node_modules, machine packages, or arbitrary home-directory files. Rebuild local state on materialization. Keep durable data in explicit remote resources. Preparation failure must not block access to the workspace; failed dematerialization or checkpointing must not delete its checkout.`);
const INTEGRATION_CODE_MODE = gitSpaceSkill('integration-code-mode', 'Discover and compose project-granted MCP tools from executable JavaScript.', `
Use \`codemode({ args: { code: '...' } })\`. The Pi Sandbox exposes grant-scoped MCP calls alongside completion and judge:

- \`mcp.list()\`
- \`mcp.search({ query, limit? })\`
- \`mcp.describe({ name })\`
- \`mcp.call({ name, args })\`

Search before guessing names. Describe unfamiliar tools before calling them. Compose loops, filtering, joins, pagination, and bounded aggregation in one codemode execution so intermediate results stay out of model context. An empty grant set produces an empty catalog. Provider and MCP credentials are never exposed. The removed eval tool and space JavaScript namespace are not available.`);


export const DEFAULT_SKILLS: Readonly<Record<string, string>> = {
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

