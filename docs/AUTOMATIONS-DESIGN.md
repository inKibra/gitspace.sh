# Automations: when something happens in a project, do something

> **Status: Draft for planning (2026-10-20).** Decisions from the 2026-10-20 discussion; the UI follows the Oct 17 mock (`packages/account-web/mock-automations.html`, `src/AutomationsMock.tsx`; see SIMPLIFICATION Batch 20 for where it differs from this design).

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

- **Automation:** name, enabled, trigger, conditions, action, and what to do when the same subject comes again.
- **Trigger:** a GitHub event with chosen actions (`pull_request` `opened`/`ready_for_review`/`synchronize`/..., `issues`, `issue_comment`, `pull_request_review`, `push`, `check_suite`), a schedule (cron expression, as project crons today), or manual only.
- **Conditions:** field, operator, value: base branch, head branch, author, draft, label, changed paths; `is`, `is not`, `matches`. All must pass.
- **Subject:** what an event is about: a pull request, an issue, or a commit. One subject has at most one workspace per automation.
- **Action:**
  - *Start a workspace for the subject*: mode (Plan, Code, Review), agent, and an instruction template (`{{pull_request.html_url}}`, `{{pull_request.base.ref}}`, ...). The rendered instruction plus the event is the workspace's first message.
  - *Message the subject's workspace*, *message a workspace*, or *message the project agent*.
  - *Ask the project agent*: the event and its provenance (§6) go to the project agent, which decides with its tools to start a workspace, message one, or skip. For judgement calls ("is this release worth a blog post?"); it costs one agent turn per event.
- **Same subject again:** send the event to the subject's workspace (the default), or ignore it.
- **Run:** one event as seen by one automation: the event, which conditions passed, the outcome (started, sent, queued, skipped and why, failed and why) and a timeline. Every event is recorded, skipped ones included.

## 5. Trust

Outsiders' text must not reach an agent that has write tools, secrets or your machine.

- An event runs only if its **actor** has write access to the repository (checked through the GitHub App when the event arrives) or is on the project's **trust list** (GitHub logins kept in GitSpace).
- The actor is the author for an issue or pull request, and the commenter for a comment: a comment on a trusted pull request from an untrusted account is untrusted.
- An untrusted event is recorded as "Skipped: author not trusted" with **Approve this run** and **Trust this author**.
- Schedules and manual runs are trusted.

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

- `ProjectAutomationsDO` (one per project) replaces `ProjectCronsDO`: automations, runs (the last N per automation), the trust list, per-subject round counts and the subject→workspace map. One alarm drives schedules and the queue.
- `GitHubAppDO` keeps recording deliveries and routes each one to the projects whose `repositoryReference` matches the delivery's repository.
- Runs hold their event payload trimmed to the fields conditions and templates read.

## 11. UI

As the mock: summary (on, working now, queued, failed today), automation cards (when / only if / then, last run), recent runs with a detail dialog (checks and timeline), and the editor (When, Only if, Then, instruction). Additions: the trust list and **Approve this run** on untrusted runs.

## 12. Milestones

| ID | Milestone | Exit criteria |
|---|---|---|
| **A0** | Schedules | `ProjectAutomationsDO`; crons migrated; schedule and manual triggers; message the project agent / a workspace; runs and history; Automations page replaces Crons. |
| **A1** | GitHub events | Deliveries routed to projects; triggers and conditions; start a workspace for the subject; same-subject routing; trust and approval; concurrency and queue. Golden test: a trusted PR into `main` starts a Review workspace; an outsider's PR is skipped with Approve. |
| **A2** | Loops and decisions | Provenance; round and daily caps; *ask the project agent*. Golden test: CI fails on a run's PR, the workspace is told, the fix pushes, CI passes; a release produced by a run does not start a new run. |
| **A3** | Lifecycle | Subject-closed notices; 7-day auto-close and checkout release. |

## 13. Open questions

1. Should approving an untrusted run also allow later events on the same subject?
2. Template language: plain `{{path}}` substitution, or a few helpers (truncate, join labels)?
3. Do runs need a cost cap of their own (inference spend per run), or is concurrency enough?
