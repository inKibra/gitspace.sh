# Automations: when something happens in a project, do something

> **Status: Draft for planning (2026-10-20; subject links, mentions, label triggers and replay decided 2026-10-27).** Decisions from the 2026-10-20 and 2026-10-27 discussions; the UI follows the Oct 17 mock (`packages/account-web/mock-automations.html`, `src/AutomationsMock.tsx`; see SIMPLIFICATION Batch 20 for where it differs from this design).

## 1. Summary

An **automation** belongs to a project: *when* a trigger fires and *only if* its conditions pass, *then* GitSpace sends the event to an agent. Each firing is a **run**, recorded even when it is skipped. Runs execute in the cloud: they message the project agent, an existing workspace, or a new workspace, which attaches a machine only if its work needs one.

Examples: review every pull request into `main`; triage new issues; tell the pull request's workspace when CI fails so its agent fixes it; a nightly dependency audit.

## 2. Scope

In scope (first version):
- triggers: GitHub events, schedules, manual;
- conditions on the event;
- actions: start a workspace for the subject, message the subject's workspace, message the project agent, or ask the project agent to decide;
- trust, loop limits, concurrency, run history;
- project crons become schedule automations (one-time migration);
- automations are defined in the UI.

Out of scope: automations defined in repository files; non-GitHub event sources; automations across projects.

## 3. What exists today

- **Project crons** (`ProjectCronsDO`, `@gitspace/protocol/cron-contract`): a schedule and a prompt sent to the project agent or a given workspace. A run is submitted to the workspace runtime with request id `cron:<run>`, so a lost reply cannot submit twice; runs that wait past the queue limit are withdrawn as "Skipped: workspace busy".
- **The GitHub App** (`GitHubAppDO`): receives signed webhooks, records every delivery (event, action, installation, repository, outcome) and acts only on `push` and installation events. Everything else is recorded and dropped.
- **Projects** name their repository (`repositoryReference`); workspaces have a branch and start in Plan, Code or Review.
- **Cost protection** (SIMPLIFICATION #32): the storage breaker, the watchdog and the spend digest cover every run's objects.

## 4. Concepts

- **Automation:** name, enabled, trigger, conditions and action. Automations start new work; activity on a subject that already has a workspace goes to it through its subject link (below), with no automation.
- **Trigger:** a GitHub event with chosen actions (`pull_request` `opened`/`ready_for_review`/`synchronize`/..., `issues`, `issue_comment`, `pull_request_review`, `push`, `check_suite`), a **label** added to an issue or pull request (the starter automations use `gitspace:plan`, `gitspace:code` and `gitspace:review`, starting a workspace in that mode), a schedule (cron expression, as project crons today), or manual only.
- **Conditions (filters):** each event offers its own filters, at most one of each: a pull request has base branch, head branch, author, draft, labels and changed files; an issue or comment has author and labels; a push has branch, author and changed files; a check suite has branch and conclusion; a review has base branch, author and review state. Branches and authors are *one of* / *not one of* a list, labels *any of* / *none of*, changed files *touch any of* / *touch none of*; values may be patterns (`release/*`, `docs/**`) and are suggested from the repository through the GitHub App. All must pass. The editor reads them back as a sentence ("Runs for pull requests into main, not drafts, not by dependabot[bot].").
- **Subject:** what an event is about: a pull request, an issue, or a branch (a commit's or a check's subject is its branch, or the pull requests GitHub names on it).
- **Subject link:** per project, a subject has at most one workspace. A link is made, strongest first:
  1. by a workspace's agent or the project agent, with a tool (link this workspace, or a named one, to a pull request, issue or branch; unlink), or by a person on the workspace (**Link a pull request or issue**);
  2. when GitSpace starts a workspace for the subject (an automation, a label, the project agent);
  3. by branch: a pull request whose head branch is a workspace's branch, and an issue the pull request closes ("Fixes #388").

  A stronger link replaces a weaker one; two workspaces on one branch resolve to the one active most recently, and the run records the choice. A link to a closed workspace reopens it.
- **Follow-through:** an event on a linked subject goes to its workspace without an automation, within the round cap (§6). Proposed (to decide): human review comments, mentions of the tenant's bot and failed checks wake the agent; approvals, merged or closed, and passing checks are notices that do not.
- **Mentions:** a comment mentioning the tenant's own bot (`@gitspace-<handle>`, e.g. `@gitspace-bradleat`; there is no shared GitSpace bot) goes to the subject's linked workspace; with no link, to the project agent, which may start or link one.
- **Action:**
  - *Start a workspace for the subject*: mode (Plan, Code, Review), agent, and an instruction template (`{{pull_request.html_url}}`, `{{pull_request.base.ref}}`, ...). The rendered instruction plus the event is the workspace's first message.
  - *Message the subject's workspace*, *message a workspace*, or *message the project agent*.
  - *Ask the project agent*: the event and its provenance (§6) go to the project agent, which decides with its tools to start a workspace, message one, or skip. For judgement calls ("is this release worth a blog post?"); it costs one agent turn per event.
- **Run:** one event as seen by one automation or by a subject link: the event, which conditions passed, the outcome (started, sent, queued, skipped and why, failed and why) and a timeline. Every event is recorded, skipped ones included.
- **Replay:** **Test with a past event** runs an automation's trigger and conditions against a recorded delivery and shows the run it would make (rendered instruction, target workspace) without acting; **Run it** acts on that event once.

## 5. Trust

Outsiders' text must not reach an agent that has write tools, secrets or your machine.

- An event runs only if its **actor** has write access to the repository (checked through the GitHub App when the event arrives) or is on the project's **trust list** (GitHub logins kept in GitSpace).
- The actor is the author for an issue or pull request, and the commenter for a comment: a comment on a trusted pull request from an untrusted account is untrusted.
- An untrusted event is recorded as "Skipped: author not trusted" with **Approve this run** and **Trust this author**.
- Schedules and manual runs are trusted.

## 5a. Agents and automations (decided 2026-10-27)

- The project agent manages automations with its own tools (below). Workspace agents cannot: they link and unlink subjects, and ask the project agent for an automation. A workspace an automation started therefore cannot create automations. This is the rule `start` already follows (only the project agent starts workspaces).
- An automation the project agent creates is **Proposed**: it does nothing until a person switches it on. Its card names the agent, its reason and a link to the conversation. An agent's edit to an approved automation returns it to Proposed; turning one off or deleting it needs no approval.
- People act directly, through the web app or the GitSpace MCP server (decided 2026-10-27): the account operations `automations.list`, `create`, `update`, `delete`, `runNow`, `test` and `history` take effect at once, with no Proposed step, because an MCP client acts as the person who connected it. They replace `crons.*` in the account operations and as MCP tools (descriptions and annotations alongside the current ones in `packages/mcp-server`), and the `crons.*` tools are removed in the same cutover. The Proposed step applies only to agents running inside GitSpace.
- Only people (the web app, MCP) change the trust list and the limits (concurrency, daily run cap, rounds per subject). Every automation runs under them, whoever made it.
- A mention of the tenant's bot by a trusted person ("audit dependencies nightly") reaches the project agent, which may propose an automation.
- The project agent's tools: `automations.list`, `automations.propose` (a new automation, or a change to an existing one; both arrive as Proposed), `automations.test` (replay against recent recorded events, §4) and `automations.delete` / switching one off. You ask for an automation in the project agent's conversation like anything else; the page has no separate place to describe one. A proposal carries what was asked, the agent's explanation and its test results (which events would run, which would be skipped and why).

## 6. Loops

Some loops are the point (CI fails, the agent fixes it, pushes, CI runs again); others must be cut (a release triggers a blog post whose publication is itself a release).

- **Provenance.** Every workspace an automation starts works on its own branch. An event is *caused by* run R when it is on R's branch, comes from a commit pushed from it, or is a release or tag whose commit came from it. Events from GitSpace's own App identity are caused by the run that acted. The sender field alone is not enough: agents may push as you.
- **Continuing the same subject** is allowed, up to a cap of rounds per subject per day (5 by default). Past it the run is "Skipped: round limit" and the workspace is told to ask you.
- **Starting a new subject from our own output** is skipped by default ("Skipped: caused by run #123"); an automation can allow it explicitly.
- *Ask the project agent* receives the provenance (caused by run #123, round 3 on this subject) and decides within these limits; it cannot exceed them.
- Every automation has a daily run cap (50 by default).

## 7. Execution

- Runs execute in the cloud runtime: the project agent, an existing workspace, or a new workspace. A workspace that needs a machine (a build, a browser on your Chrome) attaches one as usual.
- **Concurrency:** at most N runs work at once per project (2 by default). A run holds a slot only while its agent works; a workspace waiting for you does not. Further runs queue; a queued run older than 24 hours is skipped.
- Submission reuses the cron path: the run's request id makes a submission idempotent.
- **Cost:** each new workspace is a runtime object plus inference. Runs count toward the storage watchdog and appear in the spend digest; the concurrency limit bounds them.

## 8. Lifecycle

- When the subject closes (pull request merged or closed, issue closed) its workspace gets a notice and stays open.
- An automation-made workspace with no activity for 7 days after its subject closed is closed, and its machine checkout is released.

## 9. Crons become schedule automations

One-time migration: every project cron becomes an automation with a schedule trigger, no conditions, and the action *message the project agent* or *message a workspace* (its target), keeping name, schedule, prompt, scopes and enabled state. Cron run history moves to runs. The Crons page is removed; the Automations page replaces it.

## 10. Storage

- `ProjectAutomationsDO` (one per project) replaces `ProjectCronsDO`: automations, runs (the last N per automation), the trust list, per-subject round counts and the subject links. One alarm drives schedules and the queue.
- `GitHubAppDO` keeps recording deliveries and routes each one to the projects whose `repositoryReference` matches the delivery's repository.
- Runs hold their event payload trimmed to the fields conditions and templates read; replay reads the delivery GitHubAppDO recorded.

## 11. UI

A top-level page that replaces Crons in the sidebar, with the project chosen in its header; **All projects** shows the summary and recent runs of every project, and choosing a project shows its automations, links, trust list and runs. The sidebar item shows a count of runs waiting for approval or failed. As the mock: summary (on, working now, queued, failed today), automation cards (when / only if / then, last run), recent runs with a detail dialog (checks and timeline), and the editor (When, Only if, Then, instruction). Additions: the trust list and **Approve this run** on untrusted runs; **Test with a past event** in the editor; a workspace's linked pull requests and issues, with **Link a pull request or issue**. The page adds a Linked pull requests and issues section (links, how each was made, and the follow-through settings) and a Trusted authors section; at phone width its tables become stacked lists.

## 12. Milestones

| ID | Milestone | Exit criteria |
|---|---|---|
| **A0** | Schedules | `ProjectAutomationsDO`; crons migrated; schedule and manual triggers; message the project agent / a workspace; runs and history; Automations page replaces Crons. |
| **A1** | GitHub events | Deliveries routed to projects; triggers (events and labels) and conditions; start a workspace for the subject; subject links (tool, start, branch) and follow-through; mentions of the tenant's bot; trust and approval; concurrency and queue; replay. Golden test: a trusted PR into `main` starts a Review workspace; an outsider's PR is skipped with Approve; a PR opened from a workspace's branch links to it and a review comment reaches its agent; `gitspace:plan` on an issue starts a Plan workspace. |
| **A2** | Loops and decisions | Provenance; round and daily caps; *ask the project agent*. Golden test: CI fails on a run's PR, the workspace is told, the fix pushes, CI passes; a release produced by a run does not start a new run. |
| **A3** | Lifecycle | Subject-closed notices; 7-day auto-close and checkout release. |

## 13. Open questions

1. Should approving an untrusted run also allow later events on the same subject?
2. Template language: plain `{{path}}` substitution, or a few helpers (truncate, join labels)?
3. Do runs need a cost cap of their own (inference spend per run), or is concurrency enough?
4. Follow-through: which events on a linked subject wake its agent and which are notices only (proposed in §4), and is it one switch per project?
5. Pull requests as the requester: author mode (`docs/GITHUB-INTEGRATION-DESIGN.md` §6) is decided but not built, so every pull request is the bot's; its tenant default and per-project setting need a place in the UI (Settings → GitHub).
