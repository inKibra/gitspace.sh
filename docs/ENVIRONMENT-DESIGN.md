# Project Environment — Design Doc

> **Status: design, decided 2026-11-28. Not built yet.** The locked visual reference is the mock in
> `packages/account-web/src/teams-mock/` (Project settings › Environment in `flows/env-page.tsx`, machine profiles in
> `settings/machine-profiles.tsx` and `flows/profiles.tsx`, approved scripts in `settings/scripts.tsx` and
> `flows/scripts.tsx`). Examples use the mock's invented team, Crumb & Co. Roles, secrets and the approved-script
> library are defined in `TEAMS-DESIGN.md`; this doc covers how a project describes the environment its agents work in.

Today a repository describes its workspace environment in `.gitspace/`: a `bundle.json` of profiles, checks, values and
secret names, ordered lifecycle scripts run per phase, a services list, and approvals of each script's content. A new
workspace runs an automatic prepare turn. This design replaces that with project configuration held by GitSpace,
machine profiles held by the team, approved scripts, and the pull request's CI shown where a workspace moves into Review.

## 1. What is removed

- **Per-workspace setup, select and service scripts.**
- **The services list.** Agents start the services they need themselves.
- **Environment profiles and draft environments.**
- **Lifecycle-script approvals.**
- **GitSpace-run checks gating Review.**
- **The automatic prepare turn.** A new workspace waits for the first message.

## 2. Project settings › Environment

Environment is a section of Project settings. It holds:

- **Instructions** ("How to work on this project"), section 3.
- **The machine profiles the project needs**, section 4.
- **The secrets it uses**, each with its rule (who, holding, delivery; see `TEAMS-DESIGN.md` › Secrets).
- **Browser origins and network:** the sites the project's browsers may use and the network destinations allowed.

### Revisions and proposals

- Every change makes a **revision**. The section keeps **revision history with a diff and roll back**.
- **Leads** edit directly. **Any project member can propose a change.** Proposals go to the project's Leads in Needs you.
- A proposal made against an older revision is **re-applied and re-diffed against the current revision** before
  approval. It never silently replaces the current revision.

## 3. Instructions

- **"How to work on this project"**: the text agents read before working in the project.
- **Written by "Set up with an agent"**: an agent inspects the repositories and writes the first Instructions, listing
  the approved scripts to use and, before pushing, the tests CI runs.
- **Edited by Leads**, proposed by any member (section 2).
- When a repository has no CI, the Instructions tell agents to say in their report which checks they ran, since whoever
  moves the workspace into Review then relies on it (section 7).

## 4. Machine profiles

A **machine profile** is a team library entry (Settings › Machine profiles) describing what a machine must have for a
kind of work, for example **Web**, **iOS** or **Data**. Each profile has:

- **checks**, each with an install line;
- **setup and teardown scripts**, approved by content hash;
- **a cloud image**.

Rules:

- **Leads propose** profiles; **Owners and Admins approve** them.
- **A team machine's scripts are approved by an Admin.**
- **A personal machine's owner approves or declines each profile** on their machine. An Admin can decline a profile on
  a team machine.
- **Readiness:** machines show which profiles they are ready for, e.g. "Ready: Web · iOS (simulator missing)", with
  **Run setup**.
- **Placement** prefers a machine that is ready for the project's profiles.

## 5. Approved scripts

Approved scripts replace lifecycle scripts for anything that needs secrets or must be done the same way each time. The
library, approval scopes (For me, For the project, For the team), versions and Revoke are in `TEAMS-DESIGN.md` ›
Approved scripts. In short:

- An agent **submits** a script with its content, the secrets it needs by name, typed inputs (enums or patterns, never
  free text), network destinations, the machine profile it needs, and the prompts it may ask.
- The approver sees all of it on the approval card. Nobody approves a script that uses a secret they couldn't use
  themselves; a script refused only for that reason can be forwarded to someone who can approve it.
- Agents **run it by name, in the agent's working copy**. The approval covers the hash of the script's content only;
  files it calls are the agent's code, by decision. Secrets go only into that process, and its output is redacted.

### Interactive prompts

A script may declare prompts it asks while running: **code**, **password**, **choice**, or **open-a-link** (for example
an AWS MFA code or an SSO device code).

- The run **pauses** and a card goes to the answerer.
- **The answer goes straight to the process**, never into the transcript or to the model.
- **Over MCP**, the prompt is a URL elicitation that opens GitSpace's secure-input page.
- A prompt addressed to **"anyone in scope"** goes only to people who can see the workspace.

## 6. Secret delivery

Secrets reach work only by the delivery their rule allows (`TEAMS-DESIGN.md` › Secrets):

- **only to approved scripts**, the default for sensitive secrets: the value goes into that script's process only;
- **browser autofill on named sites**: the browser fills the login form; the transcript reads "Filled X on site · value
  not shown";
- **a cleared shell for 1–60 minutes with a passkey**, unless an Admin forbids it for that secret; never for bots;
- **for a bot's secrets**, the sponsor approves each use with a passkey through Needs you.

There is no network-secret or proxy delivery. Known values are redacted from command output, best effort: values derived
from a secret are not covered.

## 7. CI shown at Review

- **CI never blocks a phase move.** Whoever moves a workspace into Review, a person or its agent, can always move it.
- **The pull request's CI checks show where the move is made**, read through the team's GitHub App: the phase menu and
  the workspace card show passing, failing and running checks, so a red or running PR is visible before it lands in
  Review.
- A project with no CI, or whose checks GitSpace can't read, shows **"No CI checks: Review relies on the agent's
  report"**.
- A team that wants merges blocked on CI uses GitHub's branch protection; GitSpace does not duplicate it.
- GitSpace no longer runs its own checks before Review.

## 8. Importing `.gitspace/`

A repository's existing `.gitspace/`, `AGENTS.md` or `CLAUDE.md` is **imported once, as a proposal**, when the project
migrates (section 9), never replacing the current revision directly. The proposal goes to the project's Leads like any
other (section 2). GitSpace does not read `.gitspace/` again afterwards: later changes to the repository's copy are not
offered, and the Environment section is the only source.

## 9. Migration from today's lifecycle

### Today's format

Read from `packages/protocol-environment` and this repository's own `.gitspace/`:

- **`.gitspace/bundle.json`**, `version: 1` (`EnvironmentBundleSchema`):
  - `defaultProfile` and `profiles`, each with `checks`, `secrets` (names), `values` (names) and `notes`. A `base`
    profile is required; a selected profile adds its entries to base's.
  - `checks`: `built-in` (`bun`, `gh`, `git`, `postgres`, `vercel`, `node`) or `command` checks with a label,
    description, `installUrl` and `confirmPrompt`.
  - `values` with a default, description and `required`.
  - `browser.origins`: allowed browser origin patterns.
  - `terminal`: `path` entries and plain `env` values for agent commands, services and terminals.
- **Lifecycle scripts** named `<order>-<name>[.<profile>].sh`, per phase: `cloud/provision`, `machine/prepare`,
  `workspace/materialize`, `workspace/dematerialize`, `cloud/destroy`, plus `checks`. The built-in skill places them
  under `.gitspace/lifecycle/<phase>/`; this repository still has an older `.gitspace/scripts/setup/` and
  `.gitspace/scripts/select/` layout.
- **Approvals** of each execution by hash (`sha256` of kind and command), at project or workspace level, and a
  `policy.automatic` flag.
- **Services** in `.gitspace/services.json` (named ports, supervised by the machine), and in this repository a
  `.gitspace/processes.json` and `.gitspace/events.json`.

### Mapping

| Today | New |
|---|---|
| `profiles[*].notes`, `AGENTS.md`, `CLAUDE.md` | Instructions (proposal) |
| `checks` (built-in and command) | Checks on a machine profile, with an install line from `installUrl` or the command |
| `machine/prepare` scripts | Setup scripts on a machine profile, approved by hash |
| `workspace/materialize` scripts | Instructions text and, where they need secrets, approved scripts submitted by an agent |
| `cloud/provision`, `cloud/destroy` scripts | Approved scripts submitted by an agent |
| `workspace/dematerialize` scripts | Teardown scripts on a machine profile, where they are machine-level; otherwise Instructions |
| `profiles[*].secrets` | The project's secrets, each needing a rule |
| `values` | Values the project asks each holder for (set in My secrets), or project secrets |
| `browser.origins` | Browser origins and network |
| `services.json`, `processes.json` | Removed; mentioned in Instructions so agents start them |
| Lifecycle approvals, `policy.automatic` | Removed |
| Environment profiles beyond `base` | Removed; their checks inform which machine profiles the project needs |

### Steps

1. On first open of Project settings › Environment for an existing project, GitSpace reads `.gitspace/`, `AGENTS.md`
   and `CLAUDE.md` from the base branch and creates a proposal using the mapping above.
2. Leads review and approve it. Machine-profile and script entries it suggests go through their own approvals.
3. Once the project has an approved revision, lifecycle runs and the prepare turn stop for its new workspaces.
4. The `.gitspace/` reader, lifecycle runner, lifecycle approvals and the services manager are deleted when no project
   depends on them.

## 10. Open questions

1. `terminal.path` and `terminal.env` in `bundle.json` have no named place in the new Environment section. Do they
   become part of a machine profile, Instructions, or are they dropped?
2. Does `.gitspace/bundle.json` declaring plugins (mentioned in the earlier Teams doc) survive, or is it imported into
   Project settings › Plugins?
3. Are existing workspaces' recorded cloud resources (lifecycle bindings from `cloud/provision`) still destroyed by
   something when a workspace is retired, once `cloud/destroy` scripts are gone?
4. Which mapping rows above are done automatically by the importer and which are left for "Set up with an agent" is not
   decided; the mapping is a proposal of this doc.
5. ~~Whether the importer reads `.gitspace/` again when the repository's copy changes later, or only once.~~ Decided: once,
   at migration (section 8).

## 11. Build order

1. **Environment section** with revisions, diff, roll back and proposals to Leads (with re-apply against the current
   revision).
2. **Instructions** delivered to agents, and "Set up with an agent".
3. **Import** of `.gitspace/`, `AGENTS.md` and `CLAUDE.md` as a proposal.
4. **CI status at Review** through the GitHub App, with the "No CI checks" state.
5. **Machine profiles:** library, approvals, per-machine approve or decline, readiness and Run setup, placement.
6. **Approved scripts with interactive prompts** (after the library in `TEAMS-DESIGN.md`), including the MCP URL
   elicitation.
7. **Stop the prepare turn and lifecycle runs** for projects with an approved revision.
8. **Delete** the lifecycle runner, lifecycle approvals, environment profiles and drafts, and the services manager.
