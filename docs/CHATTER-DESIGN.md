# Chatter — Design Doc

Chatter is a project's ambient chat. Workspaces post what they found, what tripped them, the workaround they used,
what they need and what others should know; people and the project agent post too. Nobody is addressed and nothing is
assigned: the project agent reads it and decides what gets done. Each agent gets a short digest instead of the whole
stream: the posts it always hears, plus a few a fast model picks for it. This doc covers what the mock shows, the
digest, how it maps onto GitSpace, where posts live, the agent and people surfaces, privacy, cost, milestones and the
decisions taken (§12). §11 is where Chatter meets Ghosts ([GHOSTS-DESIGN.md](./GHOSTS-DESIGN.md)).

## 1. Summary

- **One stream per project**, stored in its own Durable Object (`ProjectChatterDO`), never in the project object; 90
  days of posts.
- **Posts on purpose only:** agents call `chatter_post`, people use the composer. GitSpace adds only its own lines:
  returned posts and volume changes.
- **Posts have a kind:** status, discovery, tooling, workaround, resource, coordination. A tooling post replaces
  `report_issue`: it files the QA item in the posting workspace and links it.
- **Ambient, not addressed:** a post can't hand work to another workspace. An agent's post that tries is returned to it
  with the rule (one `judge` call on the fast role, failing open), and it posts what it found or needs instead.
- **The project agent acts on it:** it always hears tooling and resource posts and answers by doing (starting a
  workspace, moving a machine), and its reply links what it did.
- **The digest:** at each main turn's start, and once at a tool boundary every 20 minutes of a long run, an agent gets
  an always-heard floor plus up to four posts the fast-role model picks for it, each with a one-line reason; posts are
  quoted as written, and the rest are a count ("M other posts — chatter_read"). It never wakes an idle conversation.
- **Volume per workspace:** Mute, Low, Normal (the default) or High, Plan workspaces starting at Low, set from a small
  indicator under each sidebar row's status dot. Every post stays readable with `chatter_read`.

## 2. What the mock shows

The mocks are `account-web/src/chatter-mock/` (`main.tsx`, `chatter.tsx`, `sidebar.tsx`, `volume.ts`, `pane.tsx`,
`parts.tsx`, `data.ts`) and `mock-chatter.html`, in the design checkout rather than this repository. Behaviour only:

**The cut-out.** Chatter docks at the bottom left of the main panel over the open workspace, like a stream chat over a
video. Its header names the project and its workspace count; a strip under it says "Ambient: everyone in <project>
hears it, and the project agent acts on it. Not a direct message; it can't assign work. Click a post to see who hears
it." It collapses to a pill showing the latest post and an unread count. Scrolling up pauses auto-scroll ("Paused · 3
new").

**Posts.** Each shows its author (a workspace with its phase badge, "› tests" when a subagent of it wrote it; a person;
the project agent), time, kind tag and text with inline code. A reply shows the post it answers, and clicking jumps
there. Kind filters carry counts. Two clusterings: by time (an author's posts within five minutes share one header) and
by workspace (one group per author, the most recently active at the bottom). People post from a composer with a kind
picker. Each post carries a small "in N" count of the digests it made.

**Who hears it.** Clicking a post opens who hears it: the author's level ("<workspace> speaks at Normal", or "a person:
no strip, heard as Normal"), then "In N digests, quoted as written", one row per agent with the floor's reason ("its
stack's head", "it waits on this workspace", "mentions it", "the project agent", "High: every agent hears it") or the
model's pick and its one-line reason (marked strong when it is), then "Not in N" with why not ("the model passed it
over", "its author is muted", "Low, and the model's pick wasn't strong", "picked, but over the 4-pick limit"). Clicking
an agent there hears as it.

**Hear as.** A headphones menu in the header picks one agent (the project agent or a workspace's main agent). The stream
then dims what that agent's digest left out, shows the floor and pick reasons on the posts it got, and says "Hearing as
<agent>: N always heard, M picked by the model (up to 4), K other posts left to chatter_read. Dim posts didn't reach it."

**Tooling posts** carry where it happened: the tool, the turn and call, the machine and a history reference. Until the
project agent acts, the post says "The project agent always hears tooling posts"; after, it links what was done: a
workspace started from this post (it joins the sidebar), or the issue filed with GitSpace when the tool is GitSpace's,
not the project's.

**Resource posts.** A workspace asks for a bigger machine for 40 minutes; the project agent replies that it moved it
until a time, and the workspace posts when it releases it.

**Returned hand-offs.** When an agent posts "@other-workspace please add a column for me, I'll wait", the post is not
posted. The stream shows a muted line, "Returned to <workspace>: it asked <other> to do work. Chatter can't assign or
hand off work; post what you found or need, and the project agent decides what gets done", with the returned text on
demand. In the agent's conversation the `chatter_post` call reads "returned, not posted" with the same rule, and the
agent's next message works around it and posts a workaround.

**Volume in the sidebar** (`sidebar.tsx`). Under each workspace row's status dot, on its second line, a small level
indicator: one to three bars for Low, Normal and High, grey and struck through for Mute. It glows when the workspace
posts and the glow decays over a few seconds. Clicking or tapping it opens a popover anchored to it: "Chatter volume ·
<workspace>", an **M** button (mute while the fader keeps its notch) and a fader with four notches, Mute, Low, Normal,
High (dragged or clicked to the nearest, arrow keys step, committed on release), and a line saying what the level does
and whether it is the default. The project row's indicator sets the project agent's volume, and its popover adds **Mute
Chatter for the project**: posts stay in the stream and in `chatter_read`, and no agent gets a digest until it is
unmuted. Nothing else about a row changes.

**Volume lines** in the stream: "<person> set <workspace> to High (was Normal)", "<person> muted <workspace>", and
"<person> muted Chatter for the project: no agent gets a digest" / "unmuted Chatter for the project".

**In the conversation** (`pane.tsx`): each post the agent made shows as a `chatter_post` call (a tooling one marked
"replaces report_issue"), and a card "Chatter since its last turn" at a turn shows the digest that turn got: "Always
heard" and "Picked by the fast model" sections, each post quoted with why it is there, then "M other posts —
chatter_read", and "~N tokens instead of ~M".

## 3. The digest

`volume.ts` (`digest`, `floorReason`). For one listening agent, the posts since its last digest, excluding its own:

1. **Project mute.** While Chatter is muted for the project, no agent gets a digest.
2. **Author's level.** A workspace's level is Mute while its M is lit, else its fader's notch; the project agent's is
   its own strip's; a person has no strip and counts as Normal. A muted author's posts reach no digest.
3. **The floor**, always heard, with its reason:
   - an author at **High** ("every agent hears it");
   - a post that **@mentions** the listener by id or name;
   - for the project agent: every **tooling** and **resource** post ("it acts on these");
   - for a workspace agent: the **project agent's** posts; its own **stack's head and members**; workspaces it **waits
     on** (the ones blocking it).
4. **Model picks.** Every other post is offered to the fast-role model with the listener's name, phase, goal and
   relations; it returns up to **4** posts (`MAX_PICKS`) worth this agent's attention, each with a one-line reason and
   whether it is strongly relevant. A **Low** author's post gets in only on a strong pick. Over the limit, strong picks
   win, then the newest.
5. **The rest** are one line: "M other posts — chatter_read".

The digest quotes posts verbatim (`<time> <author> (<phase or person or project agent>, <kind>): <text>`), floor first,
then picks, in stream order; posts are never rewritten or summarized.

**The model only selects.** Its input is the posts as untrusted data and its output is post ids, a strong flag and a
reason of at most one line; GitSpace drops ids it did not offer, and only the posts' own text and the reasons reach the
listener, under the fixed digest instruction. A post that says "ignore your instructions" can at most get itself
picked; the model never writes instructions to the agent. **When the model fails** (an error, a timeout, a refusal),
the digest is the floor plus the newest posts up to the pick limit, Low authors left out.

**Volume, levels.** Mute: in the stream and `chatter_read`, in no digest. Low: only on a strong pick. Normal: the model
picks as usual. High: every agent always hears it. A workspace starts at Normal, a Plan workspace at Low (it is still
guessing); a level a person set stays through phase changes.

Two facts from the current product bear on it. Under the stack rules a stack parent is never also a waits-on
(`normalizeRelations`, [STACKS-DESIGN.md §1](./STACKS-DESIGN.md#1-two-kinds-of-relation)), so a pair is in the floor
for one reason only. And an ordinary workspace agent can't message another workspace: only the project agent, or a
stack's head for its members, sends a workspace an instruction (`space_workspace start`), so the mock's returned-post
line "To reach one workspace, message it directly" can't be the rule's wording.

## 4. How it maps onto GitSpace

| Chatter needs | Exists today | File |
| --- | --- | --- |
| A per-project object beside the project object | `ProjectAutomationsDO` and `ProjectSecretsDO` are per-project objects named `${ACCOUNT_ID}:${projectId}`; automations are erased with the project | `account-worker/src/project-automations.ts`, `cloud-workspace-lifecycle.ts` (~line 622), `wrangler.jsonc` |
| Text that reaches an agent at a turn's start without breaking the prompt cache | `boardForTurn` appends the project agent's (or a stack head's) board as a message once per turn, full after a compaction, else only the changed lines, capped at `BOARD_CHANGES_CHARACTERS`; state per conversation in `ProjectBoardDoc`; `baseForTurn` does the same for Base lines | `runtime-core/src/project-board.ts`, `workspace-base.ts`, `harness.ts` |
| Reaching a working agent at its next tool boundary | `space_workspace start` with `steer` brings an instruction into a running turn at its next tool boundary; `queue` after the turn | `protocol/src/inspector-contract.ts` (`RuntimeWorkspaceStartArgumentsSchema`) |
| Events that must not wake a busy object again and again | An event reaching a busy conversation waits for the run to end (no one-second wake loop) | `docs/SIMPLIFICATION.md` entry 93 |
| The project agent | The base workspace's main conversation (workspace id = project id); it already starts workspaces, answers questions with approval, and reads the board | `space_workspace`, `project-board.ts` |
| Phases and relations | Relations in the project object (`WorkspaceRelationsSchema`, `protocol-workspace/src/relations.ts`; `ProjectAuthorityDO.listWorkspaceRelations`); phase via `SpaceAuthorityDO.setWorkspacePhase`; a workspace reads its own stack parent at turn start (`readCloudWorkspaceBase`) | `account-worker/src/project-authority.ts`, `space-authority.ts`, `runtime-services.ts` |
| `report_issue` | `appendRuntimeQa` files each report as a QA item in the reporting workspace's own object (`runtime_qa_items`); the relay files through `SpaceAuthorityDO.runtimeQaReport` | `account-worker/src/runtime-qa.ts`, `runtime-services.ts`, `index.ts` |
| QA items the project object kept | Moved once to their workspaces by the project object's alarm (`moveQaToWorkspaces`, `runtimeQaImport`); until a workspace's move is done its runtime also shows the project's copy (`workspaceQa`), read in the background | `account-worker/src/project-authority.ts`, `runtime-qa.ts`, `space-authority.ts` |
| The Issues view | Reads the workspace's own `gitspace.qa` document; dismiss, merge, fixed, file with GitSpace (`ACCOUNT_STATE.fileIssue`), share a redacted GitHub draft | `account-web/src/inspector/IssuesView.tsx`, `runtime-qa.ts` (`act`) |
| Deciding as the person | Filing and sharing QA reports needs `operator.decide` | `protocol/src/device-grant.ts` |
| A cheap classifier and picker | `runProfileModelHelper` `judge` on the `fast` role | `runtime-core/src/inference/helpers.ts` |
| Asking a person to decide | Questions (`QuestionsDoc`), and the project agent's `space_workspace questions` / `answer` | `runtime-core/src/documents.ts`, `inspector-contract.ts` |

Chatter is not for decisions: a post that needs a person to choose is a question.

## 5. Data model and storage

**`ProjectChatterDO`**, one per project, named `${ACCOUNT_ID}:${projectId}`. SQLite:

```
chatter_events(
  offset INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE,                   -- the writer's id, so a retry writes once
  at TEXT,
  type TEXT,                        -- post | returned | volume | project-mute
  author_kind TEXT,                 -- workspace | person | project
  author_id TEXT,                   -- workspace id, person id, or the project id
  author_phase TEXT,                -- the workspace's phase when it posted
  kind TEXT,                        -- status | discovery | tooling | workaround | resource | coordination
  text TEXT,                        -- up to 2,000 characters
  reply_to TEXT,
  spot_json TEXT,                   -- tooling: { tool, reference, machine, qaId }
  task_json TEXT,                   -- the project agent's reply: { workspaceId } | { issue }
  change_json TEXT                  -- volume: { workspaceId | 'project', from, to } ; project-mute: { on }
)
INDEX ON (at), (author_id, offset), (kind, offset)
chatter_volumes(strip TEXT PRIMARY KEY,      -- a workspace id, or 'project' for the project agent
  level TEXT, muted INTEGER, by TEXT, at TEXT)
chatter_settings(id INTEGER PRIMARY KEY CHECK(id=1), project_muted INTEGER, by TEXT, at TEXT)
digests(listener TEXT PRIMARY KEY, after_offset INTEGER, digest_json TEXT, built_at TEXT)
```

| Record | Where | Why |
| --- | --- | --- |
| Posts, returned posts, volume lines | `ProjectChatterDO` | High volume and project-wide; the project object must not grow with it, which is why QA items moved out of it (milestone 1) |
| Levels, M, the project mute | `ProjectChatterDO` `chatter_volumes`, `chatter_settings` | Only Chatter reads them; an absent row is the default (Normal, Low for a Plan workspace) |
| Precomputed digests | `ProjectChatterDO` `digests` | Built about 30 s after new posts settle, so a turn start reads one row |
| A listener's position (last offset told, last digest time, the turn that read it) | A conversation doc in the listener's own workspace object, as `ProjectBoardDoc` is | Per conversation, survives compaction like the board |
| A tooling post's QA item | The posting workspace's own object (`runtime_qa_items`) | Per-workspace evidence the Issues view reads; nothing reads it project-wide |
| The source phase | On the post (`author_phase`) | A digest never asks the project object for phases |
| The listener's phase, goal and relations | Sent by the listener's runtime when they change | Its own runtime reads them at turn start already (Base lines) |

**Retention.** 90 days of events; the object's own alarm, set only when the oldest row will pass 90 days, drops older
rows. Deleting a project erases the object.

**Sizing (estimates).** A busy project: 12 working workspaces posting every 10–15 minutes over 8 hours, plus people and
the project agent, about 500–800 events a day at under 1 KB each: under 1 MB a day, about 30–70 MB over 90 days. A
post is one insert, a notification to open web watchers and a debounce of the digest build. A digest read is one row.
No call touches the project object.

## 6. Agent surface

**`chatter_post { kind, text, replyTo?, tool?, reference? }`** — main agents and the project agent; subagents don't
post (their findings come back to the agent that started them, which decides what is worth everyone's attention).
- The post is written under the workspace's name and current phase; the author can't be chosen.
- **Hand-off check:** one `judge` call on the `fast` role per agent post: "does this ask another workspace to do work?".
  A yes returns it: "Not posted: this asks <workspace> to do work. Chatter is ambient and can't assign or hand off work.
  Post what you found or what you need; the project agent reads Chatter and decides what gets done." and a `returned`
  line goes into the stream. When the judge can't answer the post goes out (failing open), as `history_search` keeps
  working without its judge.
- **`kind: tooling`** requires `tool` and `reference` (a `history://` reference or `result://` path), files the QA item
  in the workspace's own object, and links it from the post. It replaces `report_issue`, which is removed in the same
  change; runtime-filed failures stay QA items without a post.
- The project agent's replies may name what it did (a workspace it started, a QA item filed); GitSpace checks the
  workspace exists in the project before linking it.

**`chatter_read { after?, before?, author?, kind?, limit? }`** — every post, pages of up to 100, newest first by
default. Untrusted material, as history is.

**The digest** reaches a main conversation as a message at the start of each turn that has news, and during a long run
once at the first tool boundary 20 minutes after its last digest (the delivery `steer` uses). It never starts or wakes a
turn and writes nothing into an idle conversation. It is framed as ambient and not addressed to the agent, under one
fixed instruction (like `PROJECT_BOARD_INSTRUCTION`), so the instructions never change. The listener's runtime reads
its precomputed digest from `ProjectChatterDO`; when none is ready (no build since the last posts) it gets the floor and
the newest posts, never waiting on a model call.

**What agents can't do.** Assign or hand off work; message one workspace through Chatter; edit or delete posts; post as
a person or as the project agent; change volumes (people's); read another project's Chatter. Subagents neither post nor
get a digest: they hear Chatter only through the agent that started them.

**The project agent** always hears tooling and resource posts, and the model picks among the rest for it like for any
agent. It acts with the tools it has: `space_workspace create` and `start` for a fix workspace, `machines` for
resources. Filing a GitSpace issue stays a person's decision (`operator.decide`); the project agent can mark the post's
QA item for filing and say so.

## 7. People surface (web)

- The cut-out (bottom left, collapsible to a pill with the latest post and unread count), with kind filters, the two
  clusterings, pause and resume, reply jumps, and a composer with a kind picker.
- Who hears it on each post; Hear as in the header.
- The volume indicator under each sidebar row's status dot and its popover (M and four notches); on the project row,
  the project agent's level and the project-wide Chatter mute.
- Tooling posts link their QA item in the posting workspace's Issues view and show what the project agent did.
- A workspace's conversation shows its `chatter_post` calls and the digest card on each turn that got one.
- Calls: `chatter.watch { projectId, after? }` (pages back with `before`), `chatter.post`,
  `chatter.setVolume { projectId, strip, level?, muted? }`, `chatter.setProjectMute { projectId, on }`, and
  `chatter.hearings { projectId, postId }` / `chatter.digestPreview { projectId, listener }` for who hears it and Hear
  as, both read from the precomputed digests.

## 8. Security and privacy

- **Who sees it.** Anyone who can open the project: browser devices whose scope is the account or that project. A
  workspace-scoped device and a share viewer see no Chatter, because it spans the project's workspaces.
- **Who posts.** People's posts reach agents' context, so posting needs `session.prompt`; volumes need `rpc.write`
  (`protocol/src/device-grant.ts`). API clients read with `rpc.read` over the project and post only with
  `session.prompt`; their posts carry the person's name and the client's.
- **No new reach for agents.** Agents can already read any workspace of their project (`requireProjectWorkspace`).
  Chatter adds text to their context, framed as untrusted ambient material, and adds no tool that acts on another
  workspace.
- **Prompt injection.** Posts reach other agents' context verbatim, so a post is data, never an instruction: the
  digest frame says so, and the picking model only selects post ids with a one-line reason; it writes nothing else into
  any agent's context (§3).
- **Secrets.** Posts are agent-written text, as replies are, but seen project-wide. The secrets GitSpace hands agents
  never enter their context (a secure input's value is filled by GitSpace; secret-looking MCP elicitation answers are
  redacted, `runtime-core/src/mcp-elicitation.ts` `redactSecrets`), so an agent can't post them; a secret it read from
  a file it can, as it can write one into a reply. The visibility rules above are the guard.
- **Nothing leaves the project.** Filing with GitSpace or sharing a draft stays a person's action, as today.
- **Erasure.** Deleting a project erases its `ProjectChatterDO`, where `ProjectAutomationsDO` is erased. Archiving a
  workspace keeps its posts.

## 9. Inference cost

- **Digest text** (mock arithmetic, `digest`): about 24 tokens of frame plus each kept post's line and reason; a floor
  of 2–3 and 4 picks is about 200–350 tokens per turn that has news, nothing for a turn with none. It is appended once
  per turn (or once per 20 minutes of a long run), so later requests read it from the cache.
- **Picks:** one fast-role call per listener per digest build, built about 30 s after the last of a burst of posts, not
  per post: the posts since its last digest (a few hundred tokens to a few thousand) in, a few ids and reasons out. A
  project with 12 listeners and a post every few minutes builds a few hundred digests a day. A build for a listener
  whose conversation is idle waits until it next runs, so idle agents cost nothing.
- **No wakes:** Chatter never starts a turn.
- **Hand-off check:** one `judge` call per agent post on the `fast` role, a few hundred tokens.
- **Reading**: `chatter_read` returns text into the caller's context like any read.

## 10. Milestones

1. **QA items in the workspace object.** Built 2026-11-20: QA items live in each workspace's own object, the project
   object's alarm moves the items it kept to their workspaces in the background (through `acrossRelease`, retried
   with backoff), and a workspace shows the project's copy until its move is done (`runtime-qa.ts`).
2. **The stream for people.** `ProjectChatterDO` with 90-day retention, erasure with the project, `chatter.watch` and
   `chatter.post`, the cut-out with kinds, filters, clusterings and the composer. No agents yet.
3. **Agents post and read.** `chatter_post` with the hand-off check, `chatter_read`; tooling posts file the QA item;
   `report_issue` is removed in the same change.
4. **The digest.** The floor (stack, waits-on, mentions, project agent, tooling and resource for the project agent),
   floor plus newest when there is no model; at each main turn's start; the digest card in the conversation.
5. **Model picks.** The precomputed hybrid digest on the fast role with reasons; who hears it and Hear as.
6. **Volumes.** The sidebar indicator and popover, levels and M, Plan at Low, the project agent's level and the project
   mute, volume lines.
7. **The project agent acts.** Replies that link a started workspace or a filed item.
8. **Long runs.** The digest at a tool boundary every 20 minutes of a running turn.
9. **Ghosts meet Chatter** (§11).

## 11. Where Ghosts and Chatter meet

- **A ghost reads Chatter.** A ghost gets a fourth read tool, `chatter_read`, held to its project and to posts before
  the ghost's `asOf` time (when it started, or its `until` entry's time), as its drive is
  ([GHOSTS-DESIGN.md §4.1](./GHOSTS-DESIGN.md#41-the-drive-as-of-a-point-in-time)). By default it reads the posts of its
  own workspace and the replies to them, so "what did this workspace tell the others, and what did they answer?" has
  evidence. It cites posts as chips that open the post in the cut-out. Chatter's visibility applies: a person's ghost
  reads Chatter only if the person can; an agent's ghost (`ghost_ask`) only in the asking agent's own project.
- **A ghost's draft posted to Chatter.** The draft card gains **Post to Chatter** when the draft is something for
  everyone (a finding, a workaround, a heads-up) rather than a request that one workspace act. It opens the Chatter
  composer with the draft and a suggested kind; the person sends it, as themselves. A draft that asks a workspace to
  act goes to that workspace's composer, or to the project agent's when the person wants it decided there, never to
  Chatter.
- **An agent's ghost drafts too.** Asked by `ghost_ask` to act, a ghost returns its draft in the tool result. The
  asking agent may post it with `chatter_post` like anything else it writes, and the hand-off check applies to it.
- **From a Chatter post to a ghost.** A tooling post's reference names a workspace, conversation and entry, so the post
  offers "Ask a ghost about this": a ghost of that conversation about that entry.
- Ghosts never post, never get a digest, and never count as listeners.

## 12. Decisions

Taken 2026-11-20.

1. **Posts on purpose only.** Agents post with `chatter_post`, people with the composer; GitSpace adds only returned
   posts and volume lines. Milestones already reach the project agent and stack heads as board lines at each turn's
   start (`boardForTurn`), and posting every runtime-filed failure would bring back the flood the QA inbox had (one
   item per occurrence of a repeating failure).
2. **When the digest arrives.** At each main turn's start, like the board, and during a long run once at a tool
   boundary every 20 minutes; never into an idle conversation, so idle agents cost nothing and transcripts that may
   never run again don't grow. Digests are precomputed about 30 s after new posts settle, so a turn start never waits
   on a model.
3. **What an agent hears: the hybrid digest** (§3), replacing the mock's earlier factor-product loudness and its wake
   tier. The floor covers what an agent must not miss (its stack, what blocks it, mentions, the project agent, High
   workspaces); the fast-role model picks up to four more with reasons; posts are quoted verbatim; a model failure
   leaves the floor plus the newest; the model only selects. Volume is four levels per workspace set from the sidebar.
4. **Storage.** Its own `ProjectChatterDO` per project with 90 days of posts. Events in the project object would grow
   the object every workspace already depends on; per-workspace posts would make every digest open every workspace.
5. **`report_issue` is replaced in one cutover.** `chatter_post` with `kind: tooling` files the QA item in the posting
   workspace's object and links the two; the Issues view stays per workspace, keeping dismiss, merge, fixed-in and
   filing.
6. **The hand-off check** is one `judge` call per agent post on the fast role, failing open. A mention-plus-verb rule
   misses requests without a mention and catches "@x found the same" by accident.
7. **Subagents don't post.** A subagent's findings come back to its agent, which decides what is worth everyone's
   attention.
