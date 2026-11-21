# Inbox — Design Doc

The Inbox is one page that lists everything waiting on the person across all their projects. It covers questions
agents ask, approvals, reviews, broken things that need a person, alerts from the projects' own infrastructure, and
reported issues. Each row carries enough context to act on it, and usually the action itself. Decided with the user:

- the Inbox is *the* page for everything waiting on the person;
- it absorbs the Monitoring page's storage incidents;
- the sidebar's **Needs you** becomes a filter that opens it.

This doc covers what the mock shows, each kind of row and where its data comes from today, how a row is cleared and
kept in sync with its source, the Today strip, routes, storage and live updates, links to Ghosts and Chatter,
milestones and the decisions still open.

An earlier Inbox was replaced by Monitoring on 2026-10-27 (`docs/SIMPLIFICATION.md` entry 104). Its cards repeated
what the sidebar shows: 19 of its 23 entries were "1 agent waiting" for agents that had only finished a turn. This
design keeps that lesson. A row exists only for something with a recorded open state at its source: an open question,
an unapproved declaration, a failed operation, an active incident, an open QA item. A workspace's colour never makes
a row.

## 1. Summary

- **One list, across projects.** Rows are ordered by how long they have waited. Bands: *Broken · needs a person*,
  *Waiting on you*, *Reported issues*. Filters: All, Questions, Approvals, Reviews, Problems, Issues.
- **Act in place.** Rows show the chat's own question and approval cards, so most rows are answered without opening
  the workspace. Open goes to the exact spot in the workspace.
- **The source is the truth.** A row is a projection of a record that lives where it lives today: a workspace's
  `QuestionsDoc`, a project operation, an incident in `AccountStateDO`, and so on. Acting on a row calls that source's
  existing procedure. The row goes away when the source says it is closed, whoever closed it and wherever.
- **One account-level table.** Sources push compact rows into the account directory object (`UserProjectIndexDO`),
  where workspace statuses already land. The page reads that one object and never fans out to projects (§6).
- **Counted carefully.** The badge counts what blocks an agent or is broken. It does not count reported issues,
  alerts an automation already took, or anything waiting longer than two days (§2).
- **Monitoring folds in.** Storage incidents become Problem rows, and `/monitoring` goes away (§5).

## 2. What the mock shows

The mock is `account-web/src/inbox-mock/` (`InboxApp.tsx`, `data.ts`, `items.tsx`, `more-rows.tsx`, `dashboard.tsx`,
`identity.tsx`, `conversation.tsx`, `context-data.ts`, `frame.tsx`, `report.tsx`, `screens.tsx`) plus
`mock-inbox.html`. It lives in the design checkout, not in this repository, and uses invented data only. This section
describes behaviour, not layout.

**Frame.** The real `AppSidebar` gains an Inbox entry, first in its navigation row, carrying an orange count
(`frame.tsx`; the real change adds `inbox` to `NAV`). The page header says "N things need you across M projects, and
K reported issues. A agents are working." It has a **Report** button and a Comfortable / Compact density switch.

**List** (`InboxApp.tsx`):
- Rows sit in three bands: *Broken · needs a person* (problem, incident, alert), *Waiting on you* (question, plan,
  approval, review, requirement) and *Reported issues*. Each band heading carries its count.
- Group by **Newest** keeps the bands. Group by **Project** gives one section per project, with the bands inside it.
- Approvals that share a declaration group under one header ("Declared on develop · 3 pending",
  `GROUPS`/`entries`). That header has **Approve all declared**, which opens a dialog listing each item: "Each runs,
  or opens, in every workspace that declares it, now and later, until its content changes."
- Alerts from the projects' infrastructure group the same way under one header.
- The filter pills carry counts. Problems and Questions are tinted when non-zero.

**Ageing.** A row waiting longer than two days (`STALE_AFTER`) drops into a dashed tier at the bottom, "Waiting longer
than 2 days · oldest N days · not counted in the Inbox badge". The tier is folded to one line per row and opens to
compact rows.

**Counting** (`counted`). The badge and header count every fresh row except issues and alerts an automation has
already picked up (`handledBy`).

**Clearing.** Acting on a row turns it into a one-line "cleared" row with the outcome ("Approved for Crumb",
"Answered · 10 minutes", "Plan approved · moves to Code") and **Undo** counting down from 6 seconds (`UNDO_MS`).
After that the row leaves. The selection moves to the next row, so the keys keep working.

**Keys.**
- `j`/`k` move the selection; `↵` opens the row.
- `a` approves the row. For a plan it approves the plan, for a requirement it accepts it, and for an alert it
  acknowledges it.
- `1`–`9` pick an option on the selected row's ask card.
- `e` expands the row; `r` reports, carrying the selected row.

**Row frame** (`ItemFrame`, `items.tsx`):
- The title.
- A place line: project › workspace, branch, phase tag, pull request chip, and "Workspace agent waiting 14m" or
  "Sync since 5h".
- A *doing* line: the agent's last message or its goal.
- The row's body, the row's own actions, and **Open** (to `context.spot`).

**Context** (`identity.tsx`) has three styles, switched in the mock:
- *Compact*: the kind's icon and the place line.
- *Goal-first*: a stable workspace tile (the goal's emoji or the name's initial, in a per-workspace colour, with the
  sidebar row's status dot), the goal as the lead line, and requirements met and plan step under it.
- *Rich*: goal-first plus the requirements as a meter and the plan as a row of steps.

**Row kinds** (`InboxKind` in `data.ts`):

| Kind | What the row shows and does |
| --- | --- |
| `question` | The conversation before it, folded to the agent's last two lines, with "Show the last N items". Under that, "What the agent said it will do" for each option, any screens the agent pointed at, then the chat's own `AskBlockView`. Compact shows one **Answer** button |
| `plan` | The same, with the plan ask (`planQuestions`): Approve or Reject with a note. The outcome is "Plan approved · moves to Code" |
| `approval` | A kind label: lifecycle script (new or changed), environment check, browser site with level, signed-caller route, or proposed automation. Then where it is declared ("On develop and in 3 workspaces: …") and who waits ("slot-picker-ui's agent waiting 9m", or "No agent waiting · pending 26m"). **Why now** gives the plan step, the call that stopped and what is blocked, or the commit that declared it. The buttons are Not now / Only this workspace / Approve for the project. Expanded, a lifecycle row shows the real `LifecycleApprovalCard` with its diff. A browser row shows the tab the agent wants, what it will click next, and a Read / Interact / Full picker ("you can give less"). A route row shows the `services.json` diff. An automation row shows schedule, prompt, why and limits, with **Run once first** |
| `review` | A Change Guide ready to read: sections read N of M, requirements to accept, checks. Actions: Later (snooze), Open PR, Read the guide. With no guide: "Ask for a guide" |
| `requirement` | The goal, the requirement, required or optional, and evidence (an inline block or a link). Actions: Reopen, Accept |
| `problem` | Red or orange. Covers sync (push refused), update base failed, lifecycle script failed with its last log line, agent stopped on an error, machine offline. Each has one primary action (Ask the agent to drop it, Discard edit, Retry, Retry turn, Start machine) and one secondary. A GitSpace-side fault (`platform`) offers **Report to GitSpace** after 2 hours (`REPORT_AFTER`) |
| `incident` | The Monitoring page's card: object, reason, the watchdog's signals ("1.2M rows written · 10 min"), class and id, **Open Monitoring**, Resume or Dismiss. Incidents the watchdog resolved in the last 7 days fold into one line under the Problems band (`ResolvedIncidents`) |
| `alert` | Severity, source and service, first seen, last seen and count. Either "investigate-errors automation started fix-checkout-500s 4m ago" or nothing. The payload as it arrived, and **Ask an agent to investigate**: start a workspace from the base branch, or message an existing one ("Its agent gets the alert next turn"). Also Route with an automation, Acknowledge ("stays open in the alert source") and Resolve |
| `issue` | Reports that say the same thing, as one row: "Reported by 3 agents in 2 workspaces". A GitSpace badge or a "<project> code" badge. A Reports tab draws each report with the workspace Issues view itself (`IssuesView`, one `gitspace.qa` item per report). A GitSpace issue has **What GitSpace gets** (the redacted outgoing fields, with "Code, transcripts, secrets · Stay here", and an editable excerpt). A project bug has **GitHub draft** and **Mark fixed** (pick the commit; "every report closes with it, in each workspace"). Also Dismiss and Merge into… |

**Report** (`report.tsx`). Report opens from the header, from `r`, or from a problem that has sat too long. You write
what went wrong, choose About (GitSpace, or the project's code and which project), and switch on or off each piece of
captured context: where, evidence, how long unresolved, app version and browser, errors in this tab. It files into
Issues: "nothing has left your account" until File with GitSpace or Open GitHub draft on the issue.

**Today strip** (`dashboard.tsx`). It sits above the list and collapses to one line:
- tiles: agents working, waiting on you (with the longest wait), open approvals, problems (with how many came from
  alerts), spend today against budget, machines online;
- tool calls per hour since midnight as bars, with turns as a line over them;
- one health chip per project: red with problems, orange while something waits, green otherwise.

**Empty.** "Nothing needs you. N agents are working. They will land here when they ask, finish, or get stuck." with
**Open the board**. The stale tier still shows below it.

## 3. Row types and where their data is today

Paths are under `packages/`. Today nothing above the workspace sees a question's text. The account directory gets one
status row per workspace, and the browser's copy of that row carries only the colour summary and a preview.

| Row | Source record today | Reaches the browser today | Cleared today by | UI today |
| --- | --- | --- | --- | --- |
| **Agent ask (block ask)** | A `gitspace-ui` block with `ask=required` and an `id` in the agent's reply (`requiredBlockAsks`, `protocol/src/gitspace-ui.ts`). `repairBlockAsks` posts it as a `kind: 'ask'` question in `QuestionsDoc` (`runtime-core/src/questions.ts`, `documents.ts`) in the workspace object. There is no `ask` tool any more (SIMPLIFICATION 277) | `RuntimeSnapshot.questions` through `runtime.watch` for an open workspace. The account index keeps the main conversation's first open question as `waitingOn` (kind, first 200 characters), in `workspace_statuses.waiting_json` (`runtime-workspace-do/src/runtime.ts` ~588, `account-worker/src/project-authority.ts` `setWorkspaceStatus`), but the socket's `status` message leaves it out | `stageAnswer`, then `prompt { answers }` (`answerFromMessage`); `dismissQuestion`; any person's message closes the conversation's other open questions as `replied` (SIMPLIFICATION 277, 280) | `chat/AskCards.tsx`, `blocks/UiBlock.tsx` "Needs your answer" |
| **Plan approval** | `propose_plan` posts `kind: 'approval'` with no `tool`, plus `PlanDoc` (`runtime-core/src/tools.ts`) | As above | Staged `{ approved, note }` sent with the next message; approving moves the workspace to Code | `blocks/src/approval.ts` `planQuestions`, `goal/PlanSection.tsx` |
| **Tool approval** | `kind: 'approval'` with `tool`. There are two producers: machine attach (`tool.name: 'machines'`, `account-worker/src/runtime-services.ts`) and the project agent's batch of answers (`space_workspace`, `project-answers.ts`) | As above. It shows above the composer through `pendingAsk` (`RuntimeWorkspace.tsx`) | `runtime.answer` at once (a permission prompt is not staged) | `QuestionCards.tsx` |
| **Lifecycle approval** | `kind: 'lifecycle-approval'` from the agent's `environment` call (`account-worker/src/lifecycle-approval-card.ts`). Approvals are stored as `LifecycleState.approvals[]` by `executionHash`, at project or workspace scope (`protocol-environment/src/schema.ts`, `space-environment.ts`, project-shared through `ProjectAuthorityDO`) | As above | `runtime.answer` → `approveExecutionsAsPerson` (`lifecycle-approvals.ts`; checks each hash is still current; needs `lifecycle.control`). Choices: Approve for the project, Only this workspace, Not now (`LIFECYCLE_APPROVAL_CHOICES`) | `LifecycleApprovalCard.tsx` |
| **Declared but unapproved** (browser site, signed-caller route, script no agent has hit yet) | Origins in `.gitspace/bundle.json` (`committed-browser-origins.ts`) with a `level`. Routes are the `ingress` execution (`account-machine/src/workspace-environment.ts`, `ApprovalRequired`). **No question is posted** for these | Only through the workspace's Environment view (`environment/EnvironmentView.tsx` `needs-approval`, `signedCallers`) | `environment.approve` / `revokeApproval` (`account-environment-rpc.ts`, `lifecycle.control`) | `environment/LiveEnvironment.tsx` |
| **Takeover** | `kind: 'takeover'` from `ask_takeover` (`protocol-runtime/src/browser-takeover.ts`) | As above | Not now (`answerAsk`), Take over (`browserTakeOver`), handback | `TakeoverCard.tsx` |
| **Secure input** | `ask_secure_input` posts `kind: 'secure-input'`. The vault records the request in `CredentialVaultDO` `secure_input_requests` (`account-worker/src/application.ts`). It expires after 15 minutes (`SECURE_INPUT_TTL_MS`) | As above, plus the page `/secure-input/<id>` | The value is typed on that page, behind a passkey step-up (`secure-input.open` / `.answer`), and filled into the tab; it never reaches the agent. A card can only Decline (`answerAsk`) | `SecureInputCard.tsx`, `SecureInputPage.tsx` |
| **MCP elicitation** | A person's MCP server asks during `mcp_invoke`. `runtime-core/src/mcp-elicitation.ts` posts `kind: 'mcp-elicitation'` and waits 30 s (`MCP_ELICITATION_WINDOW_MS`). If unanswered, the server gets `cancel` and the call resumes once the question is answered (`McpElicitationsDoc`; SIMPLIFICATION 307). A form that looks like it asks for a secret takes only a person's answer in GitSpace | As above | `answerAsk` with the form as JSON, or Decline, Cancel, Done | `McpElicitationCard.tsx` |
| **Passkey approval** (issue #239) | Does not exist. #239 has two parts. Part 1: an agent's "use passkey for <origin>", answered with the person's passkey step-up. Part 2: `/approve/<id>` for an outside client attempting something its grant lacks. Both say the request "also appears in Needs you". Step-up today: `CredentialVaultDO.consumeStepUp` with a `purpose` and targets (`account-worker/src/passkeys.ts`, `StepUpPrompt.tsx`, `docs/PASSKEYS-DESIGN.md`) | — | A new step-up purpose naming the request id, spent in the same vault transaction as the action | — |
| **Requirement to accept** | `inspector_goal_requirements` in the workspace's `SpaceContextDO`. Status `review` means evidence is attached and a person must act (`protocol/src/inspector-contract.ts`, `space-context.ts`) | Per workspace only: `inspector.overview` | `inspector.requirement.setAcceptance` (`operator.decide`, browser devices; it journals a decision) | `inspector/GoalSurface.tsx`, `goal/RequirementsSection.tsx` |
| **Guide to review** | `inspector_guide_revisions` plus `inspector_guide_reviewer_state` (decision per revision and head commit). **There is no "ready for review" signal**: `ChangeGuideView` has no status | Per workspace only | `inspector.guide.setApproval` (`account.admin`; needs every section read) | `inspector/ChangeGuideSurface.tsx` |
| **Agent stopped on an error** | The main conversation is `failed` with `error` (`protocol-runtime/src/base.ts`). `WorkspaceReport.failure` exists, but the index does not store it | Only `agents.red` in the summary (red dot) | Retry in the workspace | `RuntimeWorkspace.tsx` |
| **Lifecycle script failed** | `RuntimeCacheObservation.setup[]` with `state: 'failed'`, plus `lifecycle_runs`/`lifecycle_logs` in the workspace object | Machine detail inside the workspace. The summary does not count it | Retry in Environment | `environment/LiveEnvironment.tsx`, `LifecycleLogDialog` |
| **Sync problem / push refused** | `syncProblem` or `RuntimeAttachment.failure` from the machine heartbeat (`space-authority.ts` `runtimeHeartbeat`). A conversation notice goes out once it has lasted 5 minutes | Only `sync.problems` (a count) and `sync.conflicts` in the summary | In the workspace | `GitSpaceShell.tsx` "sync problem" |
| **Update base failed** (and other project operations) | `CloudProjectOperation` rows in `ProjectAuthorityDO` (`protocol/src/project-authority.ts`), kept until dismissed | **Already account-wide**: `operations` on the directory snapshot and `directory.project` slices | `project.operations.retry` / `.dismiss` | `OperationProgress.tsx`, `AccountWorkPages.tsx` |
| **Machine offline** | `FleetCatalogDO` machine `state` (`offline`, `error`, …) | **Already account-wide**: `directory.machines` | Start or move, in Settings → Machines | `SettingsPage.tsx` |
| **Automation proposed** | `automations.proposal_json` in `ProjectAutomationsDO`. It never runs until approved | **Count already account-wide**: `automation_summaries.proposed` in the index, read by `automations.overview` | `automations.approve` / `automations.delete` | `automations/AutomationCard.tsx` |
| **Watchdog incident** | `AccountStateDO` key `storage-incidents` (`account-worker/src/account-state.ts`). Written by an object's own breaker (`storage-quarantine.ts`) and by the platform watchdog's posts (`platform/src/storage-watchdog.ts`, `POST /__platform/storage`). Alerts resolve on their own (`healthy`) | `storageIncidents.list` plus live key `storage-incidents` | `storageIncidents.resume` (Resume, or Dismiss for an alert; snoozes that object's alerts 6 h), `.pause`, `.inspect`; all need `account.admin`. `list` needs only `rpc.read` | `MonitoringPage.tsx`, `StorageIncidents.tsx` |
| **Infrastructure alert** | **Does not exist.** The only inbound webhook is the GitHub App's (`account-worker/src/github-app.ts`). `docs/AUTOMATIONS-DESIGN.md` lists other event sources as out of scope | — | — | — |
| **Reported issue** | `RuntimeQaItem` (`protocol-runtime/src/workspace-controls.ts`), from `report_issue` and runtime failures. Today it is stored as a project event `entity: 'qa'` in `ProjectAuthorityDO` and filtered per workspace (`appendRuntimeQa`, `createRuntimeQaServices`, `runtime-services.ts`). Moving it into the workspace object was built (`9600abf5`), taken out (`1e02d968`), and is Chatter's milestone 1 | The workspace's `documents['gitspace.qa']` | `runtime.qa` actions `dismiss`, `merge`, `fixed`, `file` (to `AccountStateDO.fileIssue`), `share` (a GitHub draft; `operator.decide` plus `account.admin`) | `inspector/IssuesView.tsx` (the Inspector's Issues tab) |

Account-level items the mock leaves out also wait on the person, and already reach the browser:

| Item | Source |
| --- | --- |
| A failed automation run | `automation_summaries.failed_today` |
| A provider account that is out or refused sign-in | `providers.list` |
| A plugin that needs sign-in | `mcp.connections.status` |
| An expired Composio connection | Its `expired` status, cleared by `mcp.composio.reconnect` (SIMPLIFICATION 304) |
| An uninstalled or removed GitHub App | `github.state` |

They are Problem rows under the project, or under "Account" when no project applies.

## 4. How a row is cleared and kept in sync

**Rule.** A row is the source's open record, projected. Each source publishes its whole current list of open items,
which is small, and the index replaces that source's rows with it. The row leaves when the next publication no longer
has it. Nothing in the Inbox stores "done". So a question answered in the workspace, by the project agent's relayed
answer, or by an outside MCP client (`answeredBy`) clears from the Inbox the same way as one answered in the Inbox. So
does a question closed as `replied` because the person wrote in the chat. A lost publication is corrected by the next
one, as `docs/SIMPLIFICATION.md` Rules 10 asks ("a lost message is corrected by the next change or by one small read on
reconnect").

**Acting.** Each action calls the existing procedure of the source, under the device's existing grant:

| Row | Action → procedure |
| --- | --- |
| Ask, plan | Pick an option and add an optional note, then send: one `prompt { answers: [...], text? }` to that conversation (decision 4). Dismiss → `dismissQuestion` |
| Tool approval, lifecycle approval | `runtime.answer` |
| Declared approval | `environment.approve { executionHash, scope, level? }`. Approve all declared → one call per hash |
| Takeover | Not now → `answerAsk`. Take over → Open (the takeover needs the workspace's browser view) |
| Secure input | Open `/secure-input/<id>` (its step-up stays). Decline → `answerAsk` |
| MCP elicitation | Form → `answerAsk` with the form's JSON, or Decline. A URL request → open the link |
| Passkey approval | Step-up in place (`StepUpPrompt`), with the new purpose |
| Requirement | `inspector.requirement.setAcceptance` |
| Guide | Open (approval needs every section read) |
| Problem | The source's own retry: `project.operations.retry`/`.dismiss`, a turn retry, an environment re-run, machine start |
| Incident | `storageIncidents.resume`; Inspect and Pause in the expanded row |
| Automation | `automations.approve`. Run once first → a manual run |
| Issue | `runtime.qa` on each report. Mark fixed closes every report the row holds, in each workspace |

**Undo.** The mock clears at once and offers Undo for 6 s. Most sources can't undo: an approved script runs, an
answered question starts a turn. The Inbox therefore holds the call in the tab for the Undo window and sends it when
the window ends, or at once when the page is hidden or left (decision 5). Until the source's next publication, the row
shows as cleared, so a second tab does not show it as open.

**Conflicts.** A source may refuse because the item already closed: `questionRefusal`, a lifecycle hash no longer
current, an approval revision that moved. The row then shows what happened ("Already answered in the workspace",
"Content changed since you looked") and leaves with the next publication.

**One row per conversation, not per question.** Answering any question of a conversation closes that conversation's
other open questions as `replied` (`closeRepliedQuestions`, SIMPLIFICATION 280). The Inbox therefore groups a
conversation's open asks and plan into one row whose send carries every answer. Answers the person staged in the
workspace and has not sent yet show on that row as staged (`gitspace.comments` `answers`), with Send.

**Expiry.**
- Secure input expires at `expiresAt`, and the row counts down.
- An MCP elicitation keeps its row while the question is open. Its 30-second window only decides whether the call
  waits or resumes later.
- Stale rows (over two days) stay listed but leave the count.

## 5. Routes and navigation

Today:
- `routes.ts` has `AppView` = agent, kanban, projects, inference, plugins, skills, automations, secrets, monitoring.
  `/` is the agent view.
- `NAV` (`AppSidebar.tsx`) lists kanban … monitoring. Only automations carries a badge (`failedAutomationRuns`).
- The sidebar header's filters are All, Needs you, Running, Review, Ship. Needs you keeps rows whose colour is orange.
  `workspaceStatusColor` (`GitSpaceShell.tsx`) also makes rows orange when the holder is unknown or the status is
  stale, so today Needs you includes "status not confirmed" rows.

Changes:
- **`/inbox`**: a new `AppView` `inbox` with its `PRODUCT_ROUTE_LABELS` label, `PATH_BY_ROUTE` path, `NAV` entry
  (first, with the count badge, as in `frame.tsx`) and a branch in `AccountProductRoute` (`LiveApp.tsx`). It is global
  (`isGlobalView`), so `project`/`workspace` params are stripped.
- **Page parameters:**
  - `?filter=questions|approvals|reviews|problems|issues`
  - `?group=project`
  - `?for=<projectId>` to narrow to one project, the param name Automations already uses (`AUTOMATIONS_PROJECT_PARAM`)
  - `?item=<key>` to select a row
- **Open** goes to `/?project=…&workspace=…` and scrolls to the row's spot (the question's card, Environment, Goal,
  Issues tab), as the mock's `href` does.
- **Needs you** in the sidebar opens `/inbox`, and the sidebar list keeps filtering to the workspaces that have
  counted Inbox rows. Its count becomes the Inbox count, so unconfirmed status stops counting as Needs you. Unconfirmed
  status gets its own line on the Inbox instead: "Status not confirmed for N workspaces". This follows
  `docs/AGENT-SURFACES-DECISIONS.md` §7: missing or stale status is explicit, not an empty inbox (decision 3).
- **Monitoring** is removed:
  - `/monitoring` redirects to `/inbox?filter=problems`, and the `monitoring` view and `NAV` entry go away.
  - Incident rows keep Inspect, Pause, Resume and Dismiss, which stay administrator procedures.
  - The 7-day resolved list becomes the folded "Resolved by the watchdog" line under Problems.
  - The `storageIncidents.*` RPCs and MCP tools stay as they are.
- **Default page.** `/` with no workspace selected opens the Inbox (decision 11).

## 6. Storage and live updates

**Where rows live.** A new table in `UserProjectIndexDO`, the account directory object. It already receives every
workspace's status row (`setWorkspaceStatus`) and every project's automation summary (`setAutomationSummary`), and it
is the one account object browsers hold a socket to (`GET /v1/directory/events`).

```
inbox_items(
  key TEXT PRIMARY KEY,        -- source-scoped: q:<workspaceId>:<conversationId>, env:<projectId>:<executionHash>,
                               -- op:<operationId>, inc:<objectId>, qa:<projectId>:<dedupKey>, …
  source TEXT NOT NULL,        -- workspace:<id> | project:<id> | account
  project_id TEXT,             -- null for account-level rows
  workspace_id TEXT,
  kind TEXT NOT NULL,          -- question | plan | approval | review | requirement | problem | incident | alert | issue | mention
  band TEXT NOT NULL,          -- problems | waiting | issues
  title TEXT NOT NULL,         -- ≤ 200 characters
  since TEXT NOT NULL,         -- when it began waiting on the person, from the source
  counted INTEGER NOT NULL,    -- 0 for issues, handled alerts, mentions
  body_json TEXT NOT NULL,     -- what the collapsed row and its action need: ids, choices, prompt ≤ 200, the hash,
                               -- the operation kind; never transcript text, never a secret
  revision INTEGER NOT NULL    -- the source's cursor; an older send is dropped, as status_cursor does
)
INDEX ON (project_id, since), (counted, since)
inbox_counts(project_id TEXT PRIMARY KEY, counted INTEGER, problems INTEGER, waiting INTEGER, issues INTEGER)
```

**Who writes.** Each writer replaces its source's rows in one transaction, with a growing cursor:

| Source | Writer |
| --- | --- |
| A workspace: open questions of **every** conversation (today `waitingOn` is the main conversation's first only), failed main conversation, failed setup step, lasting sync problem, and later its open QA items | The status send it already makes: `WorkspaceStatusSend` gains `inbox` items, sent when they change (`account-runtime-host.ts` already compares `waitingOn` before sending). The status call is reused, not a second call per publication. Old index code reads fields by name (`workspaceStatusRowSchema` is a plain `z.object`), so a send carrying the new field to an object still on the previous release loses only the new rows. That fits the rollout rule |
| A workspace's goal and guide: requirements in `review`, a guide revision ready | `SpaceContextDO` after a requirement or guide write, through a new `setWorkspaceInbox` call, made `acrossRelease` |
| A project: failed operations, automation proposals and failed runs, declarations without approval (one row per execution hash, listing the workspaces and base that declare it) | `ProjectAuthorityDO` and `ProjectAutomationsDO`, beside `publishDirectory` / `setAutomationSummary` |
| The account: storage incidents, provider, plugin and GitHub problems | `AccountStateDO.saveStorageIncidents`, where it already calls `notifyBrowsers`, and the other owners at their existing notice points |
| Chatter mentions (§8) | `ProjectChatterDO` |
| Alerts (§3, decision 9) | Where alerts are stored |

**What the browser gets.**
- **On socket open:** an `inbox.counts` message with `inbox_counts`, a few bytes per project, beside the existing
  `statuses`. This feeds the nav badge, Needs you and the Today tiles in every tab.
- **On change:** one message per changed row, `{ type: 'inbox.row', row }` or `{ type: 'inbox.removed', key }`, plus
  the new counts. The same pattern as `status` messages: small, about one thing, corrected on reconnect by one read.
- **The page:** `inbox.list { filter?, for?, before?, limit }` reads the index's rows, newest-waiting first, 200 to a
  page. The stale tier is a second page fetched when opened. No project or workspace object is opened.
- **On expand only:** the conversation before a question, a lifecycle diff, a guide's sections or a report's text
  come from the source (`runtime.snapshot`/`history_read` of that conversation, `environment` views,
  `inspector.overview`, `runtime.qa`). That is one object for the one row opened. It may wake that workspace's object;
  it starts no agent.

**Sizing (estimates).**
- An account with 50 projects of 20 live workspaces has 1,000 status rows, which it carries today.
- Open items are mostly 0–3 per workspace, so 0–3,000 rows at about 600 bytes: under 2 MB.
- A cap of 20 rows per workspace source plus "and N more" bounds a runaway at 20,000 rows, about 12 MB, still paged.
- Writes ride sends that happen already. The new calls are per requirement or guide write, per operation, per
  incident.
- A tab gets the counts once and then only row changes.
- Today's heavy per-project boot reads (a `ProjectGraphReader` per project running `space.view` and `automations.list`,
  `sidebar/project-graph.tsx`; `space.view` took 4.5–6 s for 122 workspaces, SIMPLIFICATION 314) are not used by the
  Inbox.

**Who sees what.** `inbox.list` and the socket messages are filtered by the device's scope:
- account devices see every row;
- a project-scoped device sees that project's rows;
- a workspace-scoped device sees that workspace's rows;
- share viewers see none.

Account-level rows need account scope. Actions are shown only when the device holds their capability
(`session.prompt`, `operator.decide`, `account.admin`, `lifecycle.control`; `protocol/src/device-grant.ts`). Otherwise
the row is read-only, as incidents are today for non-administrators.

**Erasure.** Deleting a project deletes its rows and counts. Deleting or archiving a workspace sends an empty list for
its source. Archived projects' rows are hidden, as the sidebar hides their counts (SIMPLIFICATION 286).

## 7. The Today strip

| Tile | Data today | New |
| --- | --- | --- |
| Agents working | Sum of `status.agents.green` over the status rows, client-side | — |
| Waiting on you, longest wait | — | `inbox_counts` and the oldest counted `since` |
| Open approvals | Automation `proposed` only | Approval rows |
| Problems, from alerts | — | Problem rows |
| Machines online | `directory.machines` (`state === 'online'`), client-side (`LiveApp.tsx`) | — |
| Spend today of budget | **None at account level.** Cost is per session (`SessionUsageReport.costUsd`, `runtime.session { type: 'usage' }`). `providers.usage` gives subscription windows, not dollars. The credit ledger is operator-only | A per-account daily usage roll-up and a budget setting |
| Tool calls and turns per hour | **None** (no metrics store) | Hourly counters per account |
| Project health chips | Derivable from the status rows | From `inbox_counts` per project |

Decision 10 covers which of these ship first.

## 8. Ghosts and Chatter

**Ghosts** (`docs/GHOSTS-DESIGN.md`):
- **"Ask a ghost why it asked"** on question, plan and approval rows opens a ghost of the asking conversation. It uses
  `ghost.open { workspaceId, conversationId, about, until }`, with `about` and `until` both set to the asking entry,
  so it answers from what the agent knew when it asked (Ghosts decision 3). It opens with "Why did the agent ask
  this?" in its composer.
- The row needs the asking entry's ordinal. `RuntimeQuestion` has `conversationId` but no entry. A block ask's id
  comes from its message row (`blockAskQuestionId`), and an approval carries its call id. So the workspace's inbox
  item carries `entry`, computed when the item is published.
- A ghost's **draft** goes into the row's note field instead of a workspace composer. The person sends it with the
  answer.
- An issue row's reports each carry a `historyRef`. Each offers "Ask a ghost about this", as Chatter tooling posts do
  (`CHATTER-DESIGN.md` §11).
- Requires Ghosts milestones 4 and 6.

**Chatter** (`docs/CHATTER-DESIGN.md`):
- **Tooling posts → issue rows.** Under Chatter decision 5b, `chatter_post { kind: 'tooling' }` files the QA item in
  the posting workspace's object and links the post. The issue row shows that link and what the project agent did
  ("started fix-sync-stall", "marked for filing"), as an alert row shows `handledBy`. A row the project agent has
  acted on is listed but not counted. Filing with GitSpace stays the person's decision (`operator.decide`).
- **@mentions of the person.** Chatter addresses no one, and a post that needs a person to choose is a question
  (Chatter §4). A post that names the person (people's posts and agents' posts alike) makes an uncounted `mention` row
  in Waiting on you, with Reply (the Chatter composer) and Open in Chatter. The row clears when the person replies or
  opens the post. `ProjectChatterDO` keeps a per-person read offset and publishes the rows (decision 12).
- **Refused hand-offs.** A returned post (`type: 'returned'`) goes back to the agent, which works around it. The Inbox
  makes no row per returned post. A project with returned hand-offs today shows one folded line ("3 hand-offs returned
  today · Open Chatter") under its section when grouped by project (decision 12).

## 9. Milestones

Each step ships alone.

1. **The page, from data the browser has.**
   - `/inbox`, the `NAV` entry and badge; `/monitoring` redirects; Needs you opens it.
   - Rows from what already reaches the browser: storage incidents (`storageIncidents.list`), failed project operations
     (`directory` operations), offline machines (`directory.machines`), automation proposals and failed runs per
     project (`automations.overview`, linking to Automations), account problems (§3).
   - One row per workspace whose main conversation waits: add `waitingOn` (kind and 200 characters) to the socket's
     `status` message, from `waiting_json`. The row has Open only.
   - The bands, filters, group by project, keys, stale tier and empty state.
2. **Inbox items in the index.** `inbox_items`, `inbox_counts`, `inbox.counts`/`inbox.row`/`inbox.removed`,
   `inbox.list`, device-scope filtering. Workspaces publish every conversation's open questions on the status send.
   Rows for incidents and operations move to server rows. The badge and Needs you read `inbox_counts`.
3. **Answer in place.**
   - Asks and plans: one row per conversation, send with a note, staged answers shown.
   - Permission prompts through `runtime.answer`; Dismiss, Undo, refusals.
   - Secure input (open the page, Decline) and MCP elicitation forms.
4. **Approvals by content.** Declarations without approval, one row per execution hash with where it is declared and
   who waits. Lifecycle, browser site (with level), route, and Approve all declared. Automation proposals inline.
5. **Problems from workspaces.** Failed main conversation (store `failure`, which the report already has), failed
   setup step with its last log line, sync problem after 5 minutes, each with its retry. Report to GitSpace after 2
   hours.
6. **Reviews.** `SpaceContextDO` publishes requirements in `review`, plus a guide revision whose head commit has no
   decision from the person while the workspace is in Review. Accept and Reopen inline.
7. **Issues.**
   - Needs Chatter milestone 1 (QA items in the workspace object).
   - Workspaces publish open QA items. Rows group reports by the dedup rule (decision 7).
   - Dismiss, merge, mark fixed, File with GitSpace, GitHub draft.
   - The Report dialog, filing into the selected workspace's object, or into the base workspace's (workspace id =
     project id) when no workspace applies. `RuntimeQaItem` gains `scope: 'gitspace' | 'project'`.
8. **Today strip and context.** Tiles from existing data and `inbox_counts`, and project health chips. Goal-first
   identity: the goal's title, emoji and requirement counts are pushed to the index as journals are
   (`setWorkspaceJournal`). The conversation before a question loads on expand.
9. **Ghosts and Chatter.** "Ask a ghost why it asked" and drafts into the note (after Ghosts milestones 4 and 6).
   Tooling-post links, mention rows and returned hand-off lines (after Chatter milestones 3 and 6).
10. **Infrastructure alerts** (decision 9): intake, grouping, Investigate, Acknowledge, routing by automation.
11. **Passkey approvals** (#239): the step-up purpose and the approval rows.
12. **Spend and activity** (decision 10), if chosen.

Any step where a source calls a new method on the index goes through `acrossRelease` (`account-worker/src/release-worker.ts`)
or fails soft, because objects may serve the previous code for a few minutes after a release.

## 10. Open decisions

**1. Where Inbox rows live.**
- a. A table in `UserProjectIndexDO`, pushed by each source with its full open list (§6).
- b. No stored rows: `inbox.list` asks every project and workspace object at read time.
- c. The browser derives rows from per-workspace watches.

*Recommendation:* a. b opens every object of the account per page view (`space.view` alone takes seconds for a large
project). c needs a watch per workspace and still can't see projects the tab hasn't opened. a reuses the status send
and the one socket every tab already holds.

**2. What the badge counts.**
- a. The mock's rule: every fresh row except reported issues and alerts an automation took. Rows over two days old
  leave the count.
- b. Only what blocks an agent: questions and approvals.
- c. Every row.

*Recommendation:* a, with mention rows and returned hand-off lines uncounted too. b hides a paused object or a failed
update base, which also stop work. c brings back a badge nobody believes, the failure of the old Inbox.

**3. What Needs you in the sidebar does.**
- a. Opens `/inbox` and keeps filtering the sidebar to workspaces with counted rows. Its count is the Inbox count.
- b. Opens `/inbox`, and the sidebar filter goes away.
- c. Stays a colour filter (orange), separate from the Inbox.

*Recommendation:* a. It is the decided "filter that opens it", and it stops counting rows whose status is merely
unconfirmed (`workspaceStatusColor`). Those get their own explicit line on the Inbox.

**4. Answering a question from the Inbox, given that answers stage (SIMPLIFICATION 280).**
- a. The row is its own composer: pick, add an optional note, send. One `prompt { answers, text? }` to that
  conversation.
- b. The row only stages. The person sends from the workspace.
- c. The row answers directly with `answerAsk`, as before staging.

*Recommendation:* a. b makes the Inbox a list of links. c brings back the turn that starts before the person can add
anything, the reason staging exists. a is staging and sending in one place, and the answer arrives as one message,
exactly as from the workspace.

**5. Undo.**
- a. Hold the call in the tab for 6 s, then send. Send at once when the page is hidden or left.
- b. Send at once. Undo calls a compensating action where one exists (revoke an approval, reopen a requirement).
- c. No Undo. Confirm the risky actions.

*Recommendation:* a. Most actions have no inverse (a script ran, a turn started). b promises what it can't keep. c
slows the common case.

**6. One approval row per what.**
- a. One row per distinct content (execution hash), grouped by where it is declared, with Approve all declared.
- b. One row per workspace that asks.

*Recommendation:* a, as the mock. A project-scope approval is by hash already (`LifecycleState.approvals`). b shows
the same script once per workspace and invites approving it piecemeal.

**7. How reports become one issue row.**
- a. Exact match on normalized title and tool, within a project.
- b. A `judge` call on the `fast` role groups reports that say the same thing.
- c. No grouping: one row per QA item.

*Recommendation:* a first, plus the person's Merge into… (`runtime.qa` `merge`), and b once a project shows
duplicates a misses. c repeats the QA flood SIMPLIFICATION 43 cleaned up.

**8. Monitoring.**
- a. Removed. Incidents become Problem rows with Inspect, Pause, Resume and Dismiss inline, and `/monitoring`
  redirects.
- b. Kept as an administrator page for Inspect and history, with incidents also in the Inbox.
- c. Kept as it is. The Inbox links to it.

*Recommendation:* a, as decided. Two pages with the same incidents would drift. Inspect is per row anyway.

**9. Infrastructure alert intake.**
- a. A signed webhook per project and source (`POST /alerts/<projectId>/<sourceId>` with a per-source secret). Small
  adapters map Sentry, deploy and budget payloads to `{ fingerprint, severity, title, service, payload }`. Alerts are
  stored in `ProjectAutomationsDO`, deduplicated by fingerprint (count, first and last seen), and are a new automation
  trigger, so an automation can take one (`handledBy`).
- b. Agents poll the providers through the person's MCP plugins.
- c. Email intake, through workspace inboxes (SIMPLIFICATION Batch 11).

*Recommendation:* a. Alerts are events, and automations already turn events into runs. b costs a turn per poll. c
waits on a feature not built. Resolve in the alert's own tool waits for a per-provider integration. Until then
Acknowledge and Resolve are GitSpace's state only, and the row says so.

**10. The Today strip.**
- a. Only tiles from existing data and the Inbox's counts: agents working, waiting, approvals, problems, machines,
  project health.
- b. Also spend today against a budget (a per-account daily usage roll-up and a budget setting), and calls and turns
  per hour (new hourly counters).
- c. No strip.

*Recommendation:* a now, spend next. Spend is the tile people will look at, but it needs a usage roll-up that does not
exist. The per-hour activity chart adds counters to every tool call for a picture no decision rests on.

**11. The default page.**
- a. `/` with no workspace selected opens the Inbox.
- b. The Inbox is one `NAV` page among others.

*Recommendation:* a. It is "the page" by decision. A workspace link and the sidebar still go straight to a workspace.

**12. Chatter in the Inbox.**
- a. Mentions of the person as uncounted rows, cleared on reply or open. Returned hand-offs as one folded line per
  project.
- b. A row for every returned hand-off.
- c. Neither: Chatter stays in Chatter.

*Recommendation:* a. A mention is aimed at the person, and Chatter has no other way to reach them. A returned
hand-off is resolved by the agent and the project agent, and a row each would be noise.

**13. Context on each row.**
- a. Compact: kind and place line.
- b. Goal-first: the workspace tile, the goal as the lead, requirements and step.
- c. Rich: goal-first plus the plan's steps.

*Recommendation:* b. Across many projects the goal is what the person recognizes, and the workspace name isn't. Its
data is small (title, emoji, two counts, current step) and is pushed to the index once per change. c's step track
belongs on expand.
