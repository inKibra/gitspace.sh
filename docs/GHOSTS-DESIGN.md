# Ghosts — Design Doc

A ghost is a short-lived, read-only chat about one recorded session: a workspace's main conversation, an earlier
conversation or a subagent's, live or archived. It answers from that session's transcript and its workspace's drive
as the drive was at that time, cites what it read, can't change or send anything, and leaves nothing behind when it
fades. People open ghosts from the web; agents ask them with `ghost_ask`, their own conversation included. This doc
covers what the mock shows, how it maps onto what GitSpace already has, where a ghost's state lives, what it may do,
cost, milestones and the decisions still open.

## 1. Summary

- **Reads one session and the drive.** One conversation's transcript, never the subagent sessions it started (each of
  those is a session with its own ghost), and the workspace's drive, through the read tools agents already have
  (`history_search`, `history_read`, drive `read`), each bound on the server to that workspace and conversation.
- **The drive as it was:** a ghost reads the drive as of its start, or as of its `until` point when it has one (§4.1).
- **Answers with evidence:** each answer lists the reads it made, then text with citations (an entry, a run of
  entries, a drive file and lines). Clicking a citation shows that spot in the workspace.
- **Can't act:** it has no write, run, send, delegate or report tools. Asked to act, it says so and drafts a message
  for the person to send.
- **Keeps nothing:** its conversation lives only in memory. It fades 10 minutes after the last question, and closing it
  ends it at once. No transcript, drive file or memory remains; only usage counts do (§7).
- **Opens from anywhere a session shows:** a sidebar row (archived ones too), the topbar, the Inspector's sessions
  list, a subagent entry, or any single transcript entry ("Ask a ghost about this").
- **Agents ask ghosts too:** `ghost_ask` runs one read-only answer about any session of the agent's project, its own
  conversation included, which is how an agent gets knowledge out of another workspace or back what its compaction left
  out. Follow-ups reuse the same ghost while it lives (§5.1).

## 2. What the mock shows

The mocks are `account-web/src/ghost-chat-mock/` (`ghost.tsx`, `ghost-script.ts`, `data.ts`, `workspace.tsx`,
`frame.tsx`) and `mock-ghost-chat.html`, in the design checkout rather than this repository. Behaviour only:

**What it reads.** A ghost is "of" one session (`Session.kind`: `main`, `earlier`, `subagent`) and reads that
session's numbered transcript entries and its workspace's drive, and nothing else. The header shows the workspace,
the session title and entry count, an Archived badge, a "read-only" chip whose tooltip lists the tools (`history_search`,
`history_read`, the drive) and what it can't do (write, edit, run, send to agents, delegate, report issues), and a
countdown.

**Where it opens.**
- A ghost button on every sidebar row, archived rows included, and "Ask a ghost…" in the row menu (`frame.tsx`).
  Rows a live ghost is reading carry a small ghost.
- "Ask a ghost" in the topbar, and in the banner of an archived workspace ("Its agent is gone; the sessions and drive
  stay readable").
- A ghost button per session in the Inspector's Sessions list (main, earlier conversations, subagents), and on each
  subagent entry beside "Open transcript".
- "Ask a ghost about this" on hovering any transcript entry: the ghost opens about that entry with "Why did the agent
  do this?" in its composer (`newGhost(sessionId, openedAt, about)`).
- Docked with no ghost chosen, a start page for the session on screen with up to three suggested questions.

Summoning a session that already has a live ghost brings that ghost back (it glows) instead of opening a second.

**How it answers.** Each answer starts with an activity list of its reads, shown one by one ("searched “polling” · 9
hits", "read transcript 93–117", "read drive://…/plan.md"), then the text streams in. Citations are chips: `#118`,
`#93–117`, `plan.md:19–20`. Hovering a chip previews the entry or lines; clicking selects the cited workspace and
session, scrolls to the entry and flashes it, or opens the Inspector's Drive at the lines. The transcript marks entries
the open ghost has cited. Asked about one entry, it uses what the agent said about it, or else describes the entry and
its neighbours and says plainly that the transcript does not explain it (`aboutEntry`). When nothing matches it says so,
and says it can only answer from this one session (`search`).

**Asked to act.** A question that asks it to run, fix, merge, deploy, tell the agent anything and so on
(`isRequestToAct`) gets a refusal ("I can only read: its transcript and the workspace drive…"), a reason that fits the
session (the subagent already yielded; the workspace is archived; this conversation is closed), and a draft card: the
request cleaned up, plus where the session left off (entry number, time, last tool or reply). The card says "for the
agent in <workspace>" with **Put in composer** (fills the workspace composer and focuses it; nothing is sent) when the
workspace is live, or **New workspace with it** when it is archived. **Copy** is always there, with "you send it, not the
ghost".

**Lifetime.** `LIFETIME = 600` seconds after the last question; the clock holds while an answer streams. With 60
seconds left (`WARN`) the window fades and warns "Fading in 0:45. Nothing it said will be kept." with **Keep 10 min**.
At zero it dissolves into a tombstone: when it faded, what it read, how many questions it answered, "Nothing was kept:
no transcript, no drive file, no memory", with **Summon a new one** and **Dismiss**. Closing says "Ghost closed. Nothing
it read or said was kept."

**Several at once.** Floating, the open ghost is a window at the bottom right and the others are pills with a ring
that empties as their time runs out; the transcript pads right so cited entries are never under the window. Docked, a
column on the right of every workspace with a tab per ghost (the Inspector folds away). The mock keeps at most six
(`MAX_GHOSTS`), dropping faded ones first.

## 3. How it maps onto GitSpace

| Ghost needs | Exists today | File |
| --- | --- | --- |
| A session's entries, numbered | Transcript events with ordinals `entryId * 1024 + n`; `history_read` pages them forward or newest first, by role, text only, or one event whole | `runtime-core/src/history.ts`, `runtime-workspace-do/src/transcript.ts` (`entryEvents`), `account-worker/src/runtime-services.ts` (history tools, ~line 916) |
| Search a session | `searchHistory`: a bounded newest-first scan (2,000 events or 4 M characters a call, `cursor` to go on), ranked by words, then a judge model keeps the substantive matches | `runtime-core/src/history.ts` |
| Another workspace's transcript | `SpaceAuthorityDO.runtimeTranscript` on the other workspace's object, allowed for any workspace of the same project (`requireProjectWorkspace`) | `account-worker/src/space-authority.ts`, `runtime-services.ts` |
| Archived sessions | Reads pass for archived workspaces; only writes are refused (`authorizeWorkspaceRuntime(…, write)`) | `account-worker/src/workspace-metadata.ts` |
| Earlier conversations, subagents | The runtime snapshot lists every conversation of the workspace; subagents are child conversations of the same object, and the Inspector already draws their transcripts. Each is a session a ghost can be of | `runtime-workspace-do/src/runtime.ts`, `account-web/src/inspector/SubagentsSurface.tsx` |
| The drive | `drive://workspace/…` (a worktree session's scope `space:<workspaceId>`) and `drive://base/…` (the project session's) in the tenant R2 store, encrypted per scope (`InspectorCloudArtifacts`, `DriveFiles`); agent `read` of a `drive://` path goes through `artifactContent` | `account-worker/src/account-inspector-data.ts`, `drive-files.ts`, `runtime-services.ts` (~line 909) |
| Drive versions | Every drive write commits a new generation of its scope: a manifest (path → blob digest or streamed object) stored content-addressed in the tenant store (`persistManifest` → `DriveFiles.put`), then `ProjectAuthorityDO.putArtifactScope` moves the scope's one row in `artifact_scopes` (`scope_id`, `workspace_id`, `generation`, `manifest_hash`, `updated_at`) under an expected-generation check; `commitArtifactCopies` commits through it too. Removing files writes a generation without them and keeps their bytes ("other generations and copies may name the same object"); the only tenant-store deletes are of abandoned uploads. Reading a manifest checks its scope and generation (`entries`) | `account-worker/src/project-authority.ts` (`artifact_scopes`, ~line 943; `putArtifactScope`, ~line 1975), `account-inspector-data.ts`, `drive-files.ts` |
| Media pins | A message shows an embedded drive file as it was when the message was stored: the version's digest is kept in `MediaPinsDoc`, and a read by digest finds an earlier version (`version(url, hash)`) | `runtime-core/src/media-pins.ts`, `account-inspector-data.ts` |
| Kept tool outputs | `result://<workspace>/<conversation>/<call>` reads through the owning workspace's object (`runtimeToolResult`) | `runtime-services.ts` (`keptToolResult`), `space-authority.ts` |
| A read-only tool set | `SUBAGENT_READONLY_TOOLS` (includes `history_search`, `history_read`) | `protocol-runtime/src/subagent-policy.ts` |
| Model roles | `default`, `deep`, `fast`, `taste` in every profile; agent definitions list roles in order (`model: pi/fast, pi/default`) | `protocol/src/inference.ts`, `runtime-core/src/builtin-agents.ts` |
| One-off model calls | `runProfileModelHelper` (`completion`, `judge`) on an admitted profile | `runtime-core/src/inference/helpers.ts`, `account-worker/src/runtime-inference.ts` |
| Compaction summaries | A `pi.compaction` entry per compaction: `model` is the summary as a user message, `head` the first entry kept; older entries stay in storage. GitSpace writes it from the `CompactionTask` hook (summary up to 1 MB) | `@earendil-works/pi-durable` `CompactionEntry`, `runtime-core/src/harness.ts` (~line 250) |
| Putting a draft in the composer | The composer the person already sends from; workspace creation for archived ones | `account-web` |

Built since this doc was written (milestones 1–3): `history_search` takes `conversationId` (one conversation of the
searched workspace); a compaction's transcript event and `history_read` carry `{ entryId, reason, head, summary }`
(`compactionPayload`, `runtime-workspace-do/src/transcript.ts`; `head` is the first kept entry's ordinal, so the
summarized entries are those before it, back to the previous compaction's `head`); the web transcript draws a
compaction as "Compacted here · N earlier turns summarized" with the summary fetched on demand, its root marked
`data-compaction="<entryId>"` for milestone 8; drive reads take `asOf` over `artifact_scope_history` (§4.1).

Milestone 4 is built (2026-11-20, not deployed): a person's ghost of a workspace's main conversation.
- **Where it runs.** `GhostDO` (`account-worker/src/ghost.ts`, binding `GHOSTS`, migration `account-v8-ghosts`), one
  object per ghost named `${ACCOUNT_ID}:ghost:<uuid>`. Its model loop and tools (`ghost-session.ts`, `ghost-tools.ts`)
  load on the first socket, not at worker startup. It never writes storage; its one alarm is the deadline.
- **The calls are one socket, not RPC procedures** (§6 planned `ghost.open/ask/keep/close` beside
  `runtimeWatchContract`). `GET /api/ghost?projectId&workspaceId[&conversationId]` (`GHOST_PATH`,
  `protocol-runtime/src/ghost.ts`), upgraded and signed in `Sec-WebSocket-Protocol` as the dictation socket is, by a
  browser device with `rpc.read` and `session.prompt` that reaches the workspace (archived ones pass). The browser
  sends `ask`, `keep`, `close`; the ghost sends `ready`, `read`, `text`, `answer` (parts with citations, `draft`,
  `rounds`, `truncated`), `failed`, `expires`, `ended`. One socket is the ghost's whole life, so closing the window, a
  reload or a lost connection ends it with no registry of ghosts.
- **Admitted and billed.** The model is the account's default inference profile (`DEFAULT_INFERENCE_PROFILE_ID`),
  role `fast` with `default` as fallback (`resolveModelSelection`), on a catalog built in the ghost's object with
  credential pins in memory; requests run in that object's isolate. Each answer's tokens and cost go to the vault's
  `service_usage` as service `ghost` (day, profile, service, model; `CredentialVaultDO.recordServiceUsage`, through
  `acrossRelease`, logged when it fails). `history_search`'s judge calls are decisions, counted there as service
  `decision` by the model that answered. The usage view does not show them yet.
- **Bound tools.** `history_search`, `history_read` and `read`, closed over the target workspace, conversation and
  `driveAsOf` (the ghost's start); their schemas take no workspace or conversation, and arguments naming another are
  refused. `read` takes the target workspace's drive (`drive://workspace/…`, the project drive only for the project
  agent's ghost) at `driveAsOf`, and the conversation's `result://` outputs; images are named, not shown. Reads carry
  entry numbers, which answers cite.
- **Lifetime.** 10 minutes after the last answer, held while one runs; Keep 10 min; the window fades and warns in the
  last minute; a tombstone says "Ghost ended. Nothing was kept." Six tool rounds per answer, one question at a time.
- **Web.** A ghost button on sidebar rows (archived too), Ask a ghost in the topbar, one floating window bottom right
  (`account-web/src/ghost/`). A citation opens the ghost's workspace and jumps the transcript to the entry
  (`jumpToOrdinal`, which flashes the row) or opens the Drive at the lines; the Drive shows the current file, not the
  generation the ghost read. The draft card has Put in composer (live workspaces) and Copy.
- **Not yet.** Several ghosts, pills and the dock (milestone 7); a ghost of an earlier conversation or subagent from
  the web (the socket takes `conversationId`; no entry point sends one yet); "New workspace with it" (milestone 6). A
  live ghost keeps the code it started on until it ends: it is not in the release restart list, having no registry.

Milestone 5 is built (2026-11-21, not deployed): agents ask ghosts with `ghost_ask` (§5.1).
- **The tool.** `ghost_ask { question, workspaceId?, conversationId?, ghostId? }` (`RuntimeGhostAskArgumentsSchema`,
  `protocol-runtime/src/tool-arguments.ts`). Both ids left out, the ghost reads the asking conversation itself; only
  `workspaceId`, that workspace's main conversation; `ghostId` alone asks a live ghost again. It is offered to main
  conversations and the project agent as a direct tool, not code-only as §5.1 planned: its call is then a row of its
  own, which the transcript draws as a ghost card, and its answer enters the asker's context whole. Scripts can call it
  too. Subagents can't (it is not a subagent tool). Replay is safe: it changes nothing.
- **Where it runs.** The asking workspace's object (`runtime-services.ts` `ghostAsk`) checks the session with the rule
  `history_read` uses, then calls `GhostDO.ask` through `acrossRelease`. The ghost is the same `GhostSession` a person's
  is, in its own object `${ACCOUNT_ID}:ghost:<id>`, with the same three bound read tools and the drive at its start;
  its instructions name an agent as the asker and cap answers at 8,000 characters (`GHOST_ANSWER_MAX`, cut and marked
  `truncated` beyond it). With no socket it hears each question as one `ask` call and returns the answer whole.
- **Follow-ups.** The ghost's object keeps the asker (project, workspace, conversation) and answers only that
  conversation; a follow-up from anyone else, after the deadline or after the object restarted is answered `faded`, and
  the tool says "That ghost has faded; ask without ghostId to start a new one." Each answer moves the deadline 10 minutes
  on (the one alarm), and the ghost keeps its earlier turns and reads, so a follow-up sends them again as its prefix.
- **Caps.** Six tool rounds per answer and one question at a time, as for people; at most 3 live ghosts per asking
  conversation (`GHOST_AGENT_LIVE_MAX`), counted in the asking object's memory (a reset forgets the count; the ghosts'
  objects still refuse other askers).
- **Paid by the asker.** The ghost resolves the `fast` role (else `default`) in the inference profile the asking
  conversation's admitted run uses (`profileId` in `runtime-inference.ts`), on its own catalog with credential pins in
  memory, as a person's ghost does with the default profile. Each answer's usage goes to the vault's `service_usage` as
  service `ghost` with the asking workspace (`ServiceUsage.workspaceId`, column `workspace_id`; '' for a person's
  ghost and for rows recorded before, which move in once), and into the result's `usage`, so the asking conversation's
  transcript holds it too.
- **Result.** `GhostAskResult` (`protocol-runtime/src/ghost.ts`): `ghostId`, `expiresAt`, `session` (workspace id and
  name, conversation, title, whether it is the main one, archived), `answer` citing inline as the ghost wrote it,
  `cites` with a `ref` each (`history://<workspace>/<conversation>#<entry>[-<entry>]`; a drive file as the asker reads
  it, another workspace's under `drive://workspaces/<id>/`), `reads`, `driveAsOf`, `draft`, `rounds`, `truncated`,
  `usage` (model, requests, tokens, cost). Asked to act, the answer is the refusal and `draft` the message the agent may
  send itself.
- **Web.** A `ghost_ask` call is a card of its own in the asking transcript (`account-web/src/ghost/GhostAskCall.tsx`):
  the session asked about, the question, the answer with citation chips, the draft with Copy, what it read, model, cost
  and when it fades. A chip opens the asked workspace and jumps to the entry, as a person's ghost's do; entries of a
  conversation the workspace view doesn't show (an earlier one, a subagent's) are named, not linked. Drive chips open
  the Drive at the lines.
- **Not yet** (as built in milestone 5). `driveNote` (the drive-history note reaches the ghost in its read, not the
  result). `until` came with milestone 8.

Milestones 6–8 and the milestone-4 follow-ups are built (2026-11-21, not deployed).
- **Entry points (6).** "Ask a ghost about this" on every entry of the workspace's main transcript (hover; the ghost
  icon beside the row, `ghost/GhostEntry.tsx` `GhostEntry` in `VirtualTranscript`), which opens the conversation's ghost
  with the entry as `about` and "Why did the agent do this?" in its composer; the question goes as `ask { text, about }`
  and the model hears "About entry #N: …" with the `aboutEntry` rule in its instructions. A ghost button on each
  subagent: its transcript entry (the Execution card and the Subagents list in the transcript) and its card in the
  Inspector's Subagents tab (`GhostSessionButton`, the socket's `conversationId`). The Inspector has no list of earlier
  conversations, so those are reached by `ghost_ask` and the socket only. The archived banner says "Its agent is gone;
  the sessions and drive stay readable" with Ask a ghost. New workspace with it: an archived workspace's draft opens
  the project's create dialog with a note, and the created workspace's composer gets the draft
  (`onCreateWorkspace` resolves to the new id).
- **Several ghosts and the dock (7).** The browser keeps up to 6 live ghosts (`GHOST_PERSON_MAX`; past it the one
  opened longest ago ends, ended ones are dropped first). Summoning a session already read (same workspace,
  conversation and `until`) focuses that ghost and it glows. Floating: the open ghost's window at the bottom right,
  the others as pills with a ring that empties over the 10 minutes (amber in the last one), ended ones struck through;
  Minimize shows only pills. Docked: a 384 px column right of the workspace (the Inspector folds away when docking and
  can be opened beside it), a tab per ghost with its ring, and a `+` tab whose start page offers the workspace on
  screen with three suggested questions (asked as soon as the ghost is ready) or an empty ghost. The choice is kept in
  this browser (`localStorage` `gitspace.ghosts.placement`).
- **From a point in time (8).** The socket and `ghost_ask` take `until` (an entry number). The ghost's reads are capped
  at its ordinal (`before` = (until+1)·1024 on every transcript range; a content read past it is refused), its size is
  counted up to it, and its `asOf` (the drive's) is the newest event's time at or before it. A compaction row
  in the transcript carries "Ghost from here" (`until` = the row's entry), whose suggestions start with "What did
  this summary leave out?"; the header shows "up to #N". `GhostAskResult.until` says what it read up to.
- **Usage view (4 follow-up).** `providers.serviceUsage { profileId, days }` reads the vault's `service_usage` for one
  profile (`CredentialVaultDO.serviceUsage`, newest day first); Inference → Providers shows "Ghosts and decisions"
  under the providers: totals per service and a row per day, service, model and workspace (workspace names from the
  account directory; '' is "You" for ghosts and "No workspace" for decisions), last 30 days.
- **The version a ghost read (4 follow-up).** A drive read records the file's hash at `asOf`
  (`InspectorCloudArtifacts.versionAt`); drive cites carry `hash`, and their chip opens that version in the Inspector
  (`ResourceRequest.hash` → `inspector.artifacts.read` with the hash), labelled "· as read" with a note that it is the
  version the ghost read.

## 4. Data model and storage

A ghost has no stored record. All of its state is in memory in its own Durable Object (decision 4):

```
Ghost {
  id                     // random; also the object's name
  asker                  // a person (account, device) or an agent (workspace, conversation)
  target                 // { projectId, workspaceId, conversationId }: one session
  until | null           // an ordinal it may not read past (decision 3)
  asOf                   // the drive time: until's entry time, else when the ghost started; fixed for its life
  about | null           // the entry the next question is about
  turns                  // questions, reads, answer parts with citations, a draft or none
  deadline               // last question + 10 min; held while an answer runs
}
Cite = { entry: { conversationId, from, to? } } | { drive: { path, lines?, generation } }
```

| Thing | Where | Why |
| --- | --- | --- |
| The ghost's conversation | Memory of `GhostDO` `${ACCOUNT_ID}:ghost:${id}`; no storage call | "Keeps nothing" is true by construction; a reset or eviction ends the ghost, which is what fading means anyway |
| The deadline | One alarm at `deadline` that drops the state and closes the socket | A deadline the work names, the only kind of alarm AGENTS.md allows; no polling |
| What it reads | Where it is today: the target workspace's object (transcript, kept outputs) and the tenant R2 store (drive manifests and files) | Nothing is copied or indexed for ghosts |
| Drive history | `artifact_scope_history` in `ProjectAuthorityDO`, beside `artifact_scopes` (§4.1) | Written in the commit that moves the generation, so it can't disagree with it |
| Usage | A person's ghost: token counts per model in the account's usage. An agent's ghost: the same row keyed by the asking workspace (`service_usage.workspace_id`), and the answer's counts in its tool result, so in the asking conversation's transcript. No text either way | Cost must be visible and land on whoever asked (§8) |
| The browser's ghost list, placement, which is open | Browser memory | Matches the ghost; a reload ends every ghost |

Sizes: a ghost holds its turns, a few reads each. Reads are bounded by the tools (a `history_read` page, a search
slice of 2,000 events, one drive file window), so a ghost's memory is the size of its own model context, on the order
of 100–300 KB of text (estimate). Nothing grows with use.

### 4.1 The drive as of a point in time

A ghost reads the drive as it was at `asOf`: when the ghost started, or at its `until` entry's time when it has one.
An answer about entry #118 then cites the plan file as the agent saw it at #118, not as it was rewritten an hour later,
and follow-ups see the same drive as the first answer.

**History.** An append-only table in the project object, written in the same transaction that moves a scope's
generation (`putArtifactScope`, which `commitArtifactCopies` also goes through):

```
artifact_scope_history(
  scope_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  manifest_hash TEXT,              -- null only for generation 0, the empty drive
  committed_at TEXT NOT NULL,
  PRIMARY KEY(scope_id, generation)
)
```

The first history row written for a scope also records the generation it replaces, with that row's `updated_at` as its
`committed_at`, so a scope's history starts one generation before its first write after this ships.

**Reading.** A drive read takes an optional `asOf` time and resolves it to the latest generation with
`committed_at <= asOf`, then reads that generation's manifest and files exactly as a current read does: `entries`
already takes a scope's id, generation and manifest hash and checks the manifest against them, and caches manifests by
all three. A time before the scope's history began reads the oldest recorded generation, and the result says so ("the
drive's history starts at 2026-12-02 09:14; this is the oldest version recorded"). A scope with no history row reads its
current generation with the same note. Citations carry the generation they read, so the web opens the cited lines in
that version. A ghost's `read` always passes its `asOf`; an agent's `read` of a `drive://` path accepts `asOf` too, the
same option on the same path.

**Media pins.** Pins and history name stored versions in two ways: a pin by a file's digest (`MediaPinsDoc`), history
by a whole manifest. Both rely on the same fact: nothing deletes a committed manifest or blob while its workspace
exists. Any future drive cleanup must keep every manifest a recorded generation names and every blob those manifests
name, as well as every pinned digest, or first bound the history (drop rows older than a retention period) and collect
only what no remaining row, manifest or pin names. An `asOf` before the retained history then reads the oldest kept
generation and says so, as above.

**Deletion and size.** A workspace's history rows are deleted with its `artifact_scopes` row, and the project's with
all of them (`project-authority.ts` ~lines 1688 and 1802). A row is about 120 bytes. A busy project writing its drives
1,000 times a day (browser captures write the drive too) adds about 120 KB a day, 45 MB a year (estimate); this is the
cost the project object takes for drive history, and a retention bound caps it if it matters.

## 5. Agent surface

**The ghost's own tools.** Three, offered to its model and bound on the server:

| Tool | Bound to |
| --- | --- |
| `history_search` | the target workspace and conversation (needs the new `conversationId` argument), and `until` |
| `history_read` | the target workspace and conversation, and `until`; no other conversation, not even a subagent the target started |
| `read` | the target workspace's drive scope at `asOf`, and its `result://` paths |

The bound comes from the ghost's identity, not from its arguments: a call naming another workspace or conversation is
refused. A subagent entry in the target shows what the subagent was asked and what it yielded; its own transcript is
another session, with its own ghost. History is untrusted material, as `history_search`'s description already says;
the ghost's instructions say to answer only from reads, cite every claim, say when the record is silent, and draft
instead of acting.

**What it can't do.** No `write`, `edit`, `bash`, `proc`, `agents`, `space_*`, `report_issue`,
`ghost_ask`, `web_search`, `web_fetch`, no browser, no machine, no other workspace or session, no questions to people.
These are absent, not forbidden by prompt. It can't read another ghost.

### 5.1 Agents ask ghosts: `ghost_ask`

Agents already read any workspace of their project with `history_search` and `history_read`
(`requireProjectWorkspace`), but they read into their own context, page by page. `ghost_ask` hands the reading to a
ghost and returns only its answer: the way to get knowledge out of another workspace, and, asked of the agent's own
conversation, to get back what a compaction left out (the entries before a compaction's `head` stay in storage).

```
ghost_ask {
  question       // up to 4,000 characters
  workspaceId?   // a workspace of the asker's project; default: the asker's own
  conversationId?// default: that workspace's main conversation, or the asking conversation when workspaceId is left out too
  ghostId?       // a follow-up to a live ghost this conversation started; the fields above then must be left out
}
→ {
  ghostId, expiresAt,           // for follow-ups; 10 minutes after this answer
  session,                      // the workspace (id, name), conversation, title, main, archived
  answer,                       // text with citations inline, as the ghost wrote them: [#118], [#93-117], [drive://workspace/notes/plan.md:19-20]
  cites,                        // the same citations, structured, each with ref: history://<workspace>/<conversation>#118, or the drive:// path the asker reads
  reads,                        // what it read: searches with hit counts, transcript ranges, drive files
  driveAsOf,                    // the drive time it read
  draft,                        // asked to act: the refusal is the answer, and the message it would send is here; else null
  rounds, truncated,            // tool rounds used; true when the round cap or the 8,000-character cap cut it short
  usage                         // model, requests, input and output tokens, cost
}
```

`until` (an ordinal the ghost reads nothing after) comes with milestone 8; `driveNote` is not in the result (the note
reaches the ghost in its read).

- **Who has it:** main conversations and the project agent, as a direct tool (scripts can call it too), so each ask is
  a row of its own that the transcript draws as a ghost card. Subagents are not offered it; the agent that started them
  can ask.
- **Bound to the asker's project.** `workspaceId` must pass the rule `history_read` uses (`requireProjectWorkspace`);
  the asker's own conversation is allowed, and is the default target when both ids are left out. The ghost is bound to
  that one session and the drive `asOf`, exactly as a person's ghost is.
- **Follow-ups.** The result's `ghostId` asks the same ghost again until `expiresAt`, each question moving it 10
  minutes on; the ghost keeps its earlier reads and turns, so a follow-up costs less than a fresh ghost. A `ghostId`
  belongs to the conversation that started it; another conversation's call, or one after it faded, is refused with
  "That ghost has faded; ask without ghostId to start a new one."
- **Cost guard.** At most 6 tool rounds per answer (a ghost at the cap answers with what it has and says
  `truncated`), one question at a time per ghost, at most 3 live ghosts per asking conversation, and an answer of at
  most 8,000 characters, so a result fits the asker's context.
- **Paid by the asker.** The ghost resolves the role chosen by decision 1 in the inference profile of the asking
  conversation's admitted run (`profileId` in `runtime-inference.ts`), and its usage counts for the asking workspace.
- **Kept where the asker keeps it.** The ghost keeps nothing; its answer is a tool result in the asker's transcript,
  kept there like any other.
- **Read-only.** `ghost_ask` changes nothing, so a replay after a reset may run it again; a follow-up whose ghost was
  lost with the reset gets the faded refusal and starts a new one.

## 6. People surface (web)

- **Entry points** as in §2: the sidebar row button and menu item, topbar, archived banner, Inspector Sessions list,
  subagent entries, and per-entry "Ask a ghost about this". From a compaction marker in the transcript once compaction
  rows are drawn (decision 3).
- **Window**: floating (bottom right, others as pills with an idle ring) or docked (a column with tabs, a start page with
  suggested questions). The choice is the person's and stays per browser.
- **Answer**: the read list, streamed text, citation chips with previews; clicking moves the workspace view to the cited
  entry, or opens the cited drive lines in the generation the ghost read, and flashes them; cited entries get a mark in
  the transcript. A note under the header says which drive time the ghost reads, and when the drive's history starts
  later than that.
- **Draft card**: Put in composer (live workspace), New workspace with it (archived), Copy. Nothing is sent by the
  ghost.
- **Lifetime**: countdown, fade and warning at 60 s with Keep 10 min, tombstone with Summon a new one and Dismiss.
- **Calls**: `ghost.open { workspaceId, conversationId, about?, until? }`, `ghost.ask { ghostId, text, about? }`,
  `ghost.keep`, `ghost.close`, and a stream of answer events, as a new RPC contract beside `runtimeWatchContract`
  (`account-worker/src/account-runtime-rpc.ts`).

## 7. Security and privacy

- **Read-only by construction.** The model is offered three read tools, each bound to one workspace and conversation.
  The refusal text is product copy; the guarantee is the tool set.
- **No wider reach than the person.** A ghost reads only what its asker could open in the transcript view and Drive of
  that workspace. Starting one needs a browser device with `rpc.read` over the project (or that workspace, for a
  workspace-scoped device), and `session.prompt`, because it spends inference (`protocol/src/device-grant.ts`). API
  clients may not start ghosts at first.
- **An agent's ghost reaches what the agent reaches.** `ghost_ask` is held to the asker's project by the rule
  `history_read` already applies (`requireProjectWorkspace`), so it opens nothing the agent could not read itself; it
  only spends the reading outside the agent's context. Its answer is kept in the asker's transcript, as any tool result
  is.
- **Older drive versions become readable.** Today a file removed from the drive keeps its bytes but is reachable only
  through a media pin that names its digest. With drive history, a ghost (and an agent's `read` with `asOf`) can read it
  again at a time it existed. A file removed because it should never have been written, a secret say, stays readable
  that way until a cleanup drops the history rows and objects that name it (§4.1); that cleanup is the way to erase it.
- **Keeps nothing.** No storage writes in `GhostDO`, no ghost text in logs (ids, counts and timings only), nothing in
  the target workspace's object, nothing in the drive. Usage counts are kept; the tombstone says "no transcript, no
  drive file, no memory", which stays true.
- **Secrets.** A ghost reads the transcript as `history_read` returns it and adds no new path to secret values: a
  secure input's value is filled by GitSpace and never reaches the agent, and secret-looking answers to MCP
  elicitations are redacted from what the agent hears (`McpElicitationsDoc`, `runtime-core/src/documents.ts`). The
  model provider sees what the ghost reads, as for any agent turn.
- **Untrusted transcripts.** A transcript can contain instructions; the ghost has nothing to act with, and its draft is
  shown to the person, never sent.
- **Archived and deleted.** Archived workspaces are readable (reads pass `authorizeWorkspaceRuntime`); a deleted
  workspace has no transcript and no ghost. A ghost of a workspace that is deleted while open fails its next read and
  says so.

## 8. Inference cost

- **Per answer** (estimates): one model request to plan reads, two to four tool rounds, one to write; each round
  carries the system prompt, the question, earlier turns and the reads so far. With `history_read` pages and a drive
  window, that is about 20–60 K input tokens and 0.5–1.5 K output per answer on the `fast` role. Each
  `history_search` also makes one judge call (`searchHistory`'s `HistoryJudge`) of a few thousand tokens.
- **No prompt-cache reuse** with the session's own agent: a ghost's prefix is its own. Within one ghost, each follow-up
  reuses the ghost's earlier rounds as a cached prefix.
- **Ceilings**: one answer at a time per ghost and at most 6 tool rounds per answer; a ghost at the cap answers with
  what it has. People: at most 6 live ghosts each, as the mock. Agents: at most 3 live ghosts per asking conversation
  and answers of at most 8,000 characters (§5.1).
- **Who pays**: a person's ghost, the person's inference profile (decision 1), shown in the account's usage as
  "ghosts"; an agent's ghost, the asking conversation's inference profile, counted under the asking workspace.

## 9. Milestones

Each step ships alone.

1. **History reads that ghosts (and agents) need.** `history_search` takes `conversationId`; `history_read` returns a
   compaction's summary text and `head`. Agents gain both at once.
2. **Drive history.** `artifact_scope_history` written in `putArtifactScope`, deleted with the scope rows, and `asOf`
   on drive reads, agents' `read` included (§4.1).
3. **Compaction rows in the transcript.** The web draws a compaction where it happened, with its summary on demand.
4. **A ghost of one session, people only.** `GhostDO`, the RPC contract, the bound tools with the drive at the ghost's
   start, floating window, the sidebar row and topbar entry points, citations that jump, the fade and tombstone, the
   draft card with Copy and Put in composer.
5. **Agents ask ghosts.** `ghost_ask` with follow-ups by `ghostId`, the caps, and usage counted to the asker (§5.1).
   Built (§3).
6. **Entry points everywhere.** Per-entry "Ask a ghost about this", Inspector Sessions list, subagent entries, the
   archived banner, New workspace with it. Built (§3).
7. **Several ghosts and the dock.** Pills, idle rings, the docked column with tabs and its start page. Built (§3).
8. **From a point in time.** Start from a compaction row or any entry with `until`, the drive read as of that entry
   (decision 3). Built (§3).

## 10. Open decisions

**1. Model, role and profile.**
- a. The `fast` role, falling back to `default` (the order builtin agents use: `model: pi/fast, pi/default`).
- b. A new profile role `ghost`, unset meaning Default, so people can tune it.
- c. The model the session itself ran on.

*Recommendation:* a. A person's ghost resolves it in the person's default inference profile
(`DEFAULT_INFERENCE_PROFILE_ID`), not the target workspace's, which may be deleted or belong to an archived run; an
agent's ghost resolves it in the asking conversation's admitted profile (§5.1). Add b only when people ask for it. c
ties cost to whatever model the agent happened to use.

**2. Lifetime.**
- a. Ten minutes after the last question, held while streaming, Keep 10 min (the mock).
- b. Until the page closes.
- c. A budget: a number of questions or tokens.

*Recommendation:* a, and it also ends when the browser's socket closes (a reload loses the in-memory ghost either way,
so saying so is honest). Keep the round cap from §8 as the cost guard instead of c. An agent's ghost already follows a:
10 minutes after its last question (§5.1).

**3. Starting from a point on the compaction timeline.**
- a. *As known then:* the ghost may not read past the chosen compaction (`until` = its entry); it sees that summary and
  everything before it, and answers as the agent could have known at that time.
- b. *What got compressed:* the ghost compares the chosen summary with the entries it replaced (from the previous
  compaction's `head` to this one's) and answers what was kept, shortened or lost.
- c. Both, as a choice when starting.

*Recommendation:* one mechanism, the `until` bound (a), usable from any entry and from compaction rows; "What did this
summary leave out?" is then a suggested question on a ghost started from a compaction, which reads both sides and needs
no separate mode. Needs milestone 1 (summary and `head` in `history_read`). The drive is read as of the same point.

**4. Where a ghost runs.**
- a. Its own `GhostDO` per ghost, memory only, one alarm at the deadline.
- b. In the target workspace's `SpaceAuthorityDO`, in memory.
- c. In the asker's `UserRelayDO`, which already holds the browser socket.

*Recommendation:* a. b competes with the workspace's own runtime for memory and would open archived workspaces' objects
for their whole conversation; c puts model loops in the object every request of the account passes through. The new
class adds no module-scope work to the account worker, whose startup is near Cloudflare's 1 s limit.
