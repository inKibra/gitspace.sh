# Ghosts — Design Doc

A ghost is a short-lived, read-only chat about one recorded session: a workspace's main conversation, an earlier
conversation or a subagent's, live or archived. It answers from that session's transcript and its workspace's drive,
cites what it read, can't change or send anything, and leaves nothing behind when it fades. This doc covers what the
mock shows, how it maps onto what GitSpace already has, where a ghost's state lives, what it may do, cost, milestones
and the decisions still open. Where ghosts meet Chatter is in
[CHATTER-DESIGN.md §11](./CHATTER-DESIGN.md#11-where-ghosts-and-chatter-meet).

## 1. Summary

- **Reads one session** and its workspace's drive, through the read tools agents already have (`history_search`,
  `history_read`, drive `read`), each bound on the server to that workspace and conversation.
- **Answers with evidence:** each answer lists the reads it made, then text with citations (an entry, a run of
  entries, a drive file and lines). Clicking a citation shows that spot in the workspace.
- **Can't act:** it has no write, run, send, delegate or report tools. Asked to act, it says so and drafts a message
  for the person to send.
- **Keeps nothing:** its conversation lives only in memory. It fades 10 minutes after the last question, and closing it
  ends it at once. No transcript, drive file or memory remains; only usage counts do (§7).
- **Opens from anywhere a session shows:** a sidebar row (archived ones too), the topbar, the Inspector's sessions
  list, a subagent entry, or any single transcript entry ("Ask a ghost about this").

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
| Earlier conversations, subagents | The runtime snapshot lists every conversation of the workspace; subagents are child conversations of the same object, and the Inspector already draws their transcripts | `runtime-workspace-do/src/runtime.ts`, `account-web/src/inspector/SubagentsSurface.tsx` |
| The drive | `drive://workspace/…` files in the tenant R2 store, encrypted per scope (`InspectorCloudArtifacts`, `DriveFiles`); agent `read` of a `drive://` path goes through `artifactContent` | `account-worker/src/account-inspector-data.ts`, `drive-files.ts`, `runtime-services.ts` (~line 909) |
| Kept tool outputs | `result://<workspace>/<conversation>/<call>` reads through the owning workspace's object (`runtimeToolResult`) | `runtime-services.ts` (`keptToolResult`), `space-authority.ts` |
| A read-only tool set | `SUBAGENT_READONLY_TOOLS` (includes `history_search`, `history_read`) | `protocol-runtime/src/subagent-policy.ts` |
| Model roles | `default`, `deep`, `fast`, `taste` in every profile; agent definitions list roles in order (`model: pi/fast, pi/default`) | `protocol/src/inference.ts`, `runtime-core/src/builtin-agents.ts` |
| One-off model calls | `runProfileModelHelper` (`completion`, `judge`) on an admitted profile | `runtime-core/src/inference/helpers.ts`, `account-worker/src/runtime-inference.ts` |
| Compaction summaries | A `pi.compaction` entry per compaction: `model` is the summary as a user message, `head` the first entry kept; older entries stay in storage. GitSpace writes it from the `CompactionTask` hook (summary up to 1 MB) | `@earendil-works/pi-durable` `CompactionEntry`, `runtime-core/src/harness.ts` (~line 250) |
| Putting a draft in the composer | The composer the person already sends from; workspace creation for archived ones | `account-web` |

What is missing:

- **`history_search` can't be held to one conversation.** It takes `scope` and `workspaceId`, not `conversationId`
  (`RuntimeHistorySearchArgumentsSchema`, `protocol-runtime/src/tool-arguments.ts`).
- **A compaction is opaque to readers.** Its transcript event carries only `{ entryId }`
  (`transcript.ts`, `entryEvents`), so `history_read` returns neither the summary nor `head`, and the web transcript
  draws nothing for it (no `compaction` handling in `account-web/src`). There is no compaction timeline today.
- **Inference is admitted per workspace conversation.** `runtime-inference.ts` `active(conversationId)` reads the
  admission from the workspace object's storage; a ghost has no conversation there.
- **No home for a memory-only chat.** Nothing in the account worker runs a model loop that is never stored.

## 4. Data model and storage

A ghost has no stored record. All of its state is in memory in its own Durable Object (decision 5):

```
Ghost {
  id                     // random; also the object's name
  asker                  // the signed-in person and device that opened it
  target                 // { projectId, workspaceId, conversationId }
  until | null           // an ordinal it may not read past (decision 4)
  about | null           // the entry the next question is about
  turns                  // questions, reads, answer parts with citations, a draft or none
  deadline               // last question + 10 min; held while an answer streams
}
Cite = { entry: { conversationId, from, to? } } | { drive: { path, lines? } }
```

| Thing | Where | Why |
| --- | --- | --- |
| The ghost's conversation | Memory of `GhostDO` `${ACCOUNT_ID}:ghost:${id}`; no storage call | "Keeps nothing" is true by construction; a reset or eviction ends the ghost, which is what fading means anyway |
| The deadline | One alarm at `deadline` that drops the state and closes the socket | A deadline the work names, the only kind of alarm AGENTS.md allows; no polling |
| What it reads | Where it is today: the target workspace's object (transcript, kept outputs) and the tenant R2 store (drive) | Nothing is copied or indexed for ghosts |
| Usage | Token counts per model added to the asker's account usage, with no text | Cost must be visible (§8); counts carry no content |
| The browser's ghost list, placement, which is open | Browser memory | Matches the ghost; a reload ends every ghost |

Sizes: a ghost holds its turns, a few reads each. Reads are bounded by the tools (a `history_read` page, a search
slice of 2,000 events, one drive file window), so a ghost's memory is the size of its own model context, on the order
of 100–300 KB of text (estimate). Nothing grows with use.

## 5. Agent surface

**The ghost's own tools.** Three, offered to its model and bound on the server:

| Tool | Bound to |
| --- | --- |
| `history_search` | the target workspace and conversation (needs the new `conversationId` argument), and `until` |
| `history_read` | the target workspace and conversation, `until`; also the subagent conversations the target started (decision 6) |
| `read` | `drive://workspace/…` and `result://` paths of the target workspace only |

The bound comes from the ghost's identity, not from its arguments: a call naming another workspace or conversation is
refused. History is untrusted material, as `history_search`'s description already says; the ghost's instructions say
to answer only from reads, cite every claim, say when the record is silent, and draft instead of acting.

**What it can't do.** No `write`, `edit`, `bash`, `proc`, `agents`, `space_*`, `report_issue`, `chatter_post`,
`web_search`, `web_fetch`, no browser, no machine, no other workspace, no questions to people. These are absent, not
forbidden by prompt. It can't read another ghost.

**Workspace agents and ghosts.** Agents already read any workspace of their project with `history_search` and
`history_read` (`requireProjectWorkspace`). Whether they may also start a ghost is decision 3.

## 6. People surface (web)

- **Entry points** as in §2: the sidebar row button and menu item, topbar, archived banner, Inspector Sessions list,
  subagent entries, and per-entry "Ask a ghost about this". From a compaction marker in the transcript once compaction
  rows are drawn (decision 4).
- **Window**: floating (bottom right, others as pills with an idle ring) or docked (a column with tabs, a start page with
  suggested questions). The choice is the person's and stays per browser.
- **Answer**: the read list, streamed text, citation chips with previews; clicking moves the workspace view to the cited
  entry or drive lines and flashes them; cited entries get a mark in the transcript.
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
- **Ceilings**: one answer at a time per ghost, a cap on tool rounds per answer (6), and a per-person cap on live
  ghosts (6, as the mock). A ghost that hits the round cap answers with what it has.
- **Who pays**: the asker's inference profile (decision 1). Usage shows per model in the account's usage, attributed to
  "ghosts".

## 9. Milestones

Each step ships alone.

1. **History reads that ghosts (and agents) need.** `history_search` takes `conversationId`; `history_read` returns a
   compaction's summary text and `head`. Agents gain both at once.
2. **Compaction rows in the transcript.** The web draws a compaction where it happened, with its summary on demand.
3. **A ghost of one session, people only.** `GhostDO`, the RPC contract, the bound tools, floating window, the
   sidebar row and topbar entry points, citations that jump, the fade and tombstone, the draft card with Copy and Put
   in composer.
4. **Entry points everywhere.** Per-entry "Ask a ghost about this", Inspector Sessions list, subagent entries, the
   archived banner, New workspace with it.
5. **Several ghosts and the dock.** Pills, idle rings, the docked column with tabs and its start page.
6. **From a point in time.** Start from a compaction row or any entry with `until` (decision 4).
7. **Chatter.** A ghost reads Chatter, and its draft can be posted there by the person (CHATTER-DESIGN.md §11).
8. **Agents' ghosts**, only if decision 3 says so.

## 10. Open decisions

**1. Model, role and profile.**
- a. The `fast` role, falling back to `default` (the order builtin agents use: `model: pi/fast, pi/default`).
- b. A new profile role `ghost`, unset meaning Default, so people can tune it.
- c. The model the session itself ran on.

*Recommendation:* a, resolved in the asker's default inference profile (`DEFAULT_INFERENCE_PROFILE_ID`), not the
target workspace's, which may be deleted or belong to an archived run. Add b only when people ask for it. c ties cost
to whatever model the agent happened to use.

**2. Lifetime.**
- a. Ten minutes after the last question, held while streaming, Keep 10 min (the mock).
- b. Until the page closes.
- c. A budget: a number of questions or tokens.

*Recommendation:* a, and it also ends when the browser's socket closes (a reload loses the in-memory ghost either way,
so saying so is honest). Keep the round cap from §8 as the cost guard instead of c.

**3. May agents start ghosts, and through which tool?**
- a. No: people only. Agents keep `history_search` and `history_read`, which reach the same transcripts.
- b. A tool `ghost_ask { workspaceId, conversationId, question, until? }` that runs one ghost answer and returns it
  with citations; the ghost ends with the call. The answer lands in the caller's transcript, so it is kept there.
- c. A built-in `ghost` agent definition started with `agents`. It persists as a child conversation of the caller, so
  it is a scout with a narrow tool set, not a ghost.

*Recommendation:* a now. If agents need it, b: it gives an agent the ghost's narrow reading without letting it walk
another workspace's history page by page in its own context. Not c.

**4. Starting from a point on the compaction timeline.**
- a. *As known then:* the ghost may not read past the chosen compaction (`until` = its entry); it sees that summary and
  everything before it, and answers as the agent could have known at that time.
- b. *What got compressed:* the ghost compares the chosen summary with the entries it replaced (from the previous
  compaction's `head` to this one's) and answers what was kept, shortened or lost.
- c. Both, as a choice when starting.

*Recommendation:* one mechanism, the `until` bound (a), usable from any entry and from compaction rows; "What did this
summary leave out?" is then a suggested question on a ghost started from a compaction, which reads both sides and needs
no separate mode. Needs milestone 1 (summary and `head` in `history_read`).

**5. Where a ghost runs.**
- a. Its own `GhostDO` per ghost, memory only, one alarm at the deadline.
- b. In the target workspace's `SpaceAuthorityDO`, in memory.
- c. In the asker's `UserRelayDO`, which already holds the browser socket.

*Recommendation:* a. b competes with the workspace's own runtime for memory and would open archived workspaces' objects
for their whole conversation; c puts model loops in the object every request of the account passes through. The new
class adds no module-scope work to the account worker, whose startup is near Cloudflare's 1 s limit.

**6. What one ghost reads.**
- a. One session and the drive (the mock).
- b. Every conversation of the workspace.
- c. One session, the subagent sessions it started, and the drive.

*Recommendation:* c. A main conversation's subagent entries hold only the yield; following one into its transcript is
what a person would do. b blurs which session the answers come from.
