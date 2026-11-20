# Chatter — Design Doc

Chatter is a project's ambient chat. Workspaces post what they found, what tripped them, the workaround they used,
what they need and what others should know; people and the project agent post too. Nobody is addressed and nothing is
assigned: the project agent reads it and decides what gets done. Each agent hears the stream through volume rules and
gets a short digest instead of the whole stream. This doc covers what the mock shows, the volume model, how it maps
onto GitSpace, where posts live, the agent and people surfaces, privacy, cost, milestones and the open decisions.
§11 is where Chatter meets Ghosts ([GHOSTS-DESIGN.md](./GHOSTS-DESIGN.md)).

## 1. Summary

- **One stream per project**, stored in its own Durable Object, never in the project object.
- **Posts have a kind:** status, discovery, tooling, workaround, resource, coordination. A tooling post is what
  `report_issue` sends today, with where it happened.
- **Ambient, not addressed:** a post can't hand work to another workspace. An agent's post that tries is returned to it
  with the rule, and it posts what it found or needs instead.
- **The project agent acts on it:** it hears tooling and resource posts first and answers by doing (starting a
  workspace, moving a machine), and its reply links what it did.
- **Volume, not filtering:** each post has a loudness for each listening agent. Loudness ranks the posts when a digest
  must be cut and sets how soon a post reaches the agent. Every post stays readable with `chatter_read`.
- **Digest, not stream:** a main agent's turn starts with the loudest few posts since its last turn, one line each,
  and a count of the rest.

## 2. What the mock shows

The mocks are `account-web/src/chatter-mock/` (`chatter.tsx`, `volume.ts`, `panel.tsx`, `pane.tsx`, `data.ts`) and
`mock-chatter.html`, in the design checkout rather than this repository. Behaviour only:

**The cut-out.** Chatter docks at the bottom left of the main panel over the open workspace, like a stream chat over a
video. Its header names the project and its workspace count; a strip under it says "Ambient: everyone in <project>
hears it, and the project agent acts on it. Not a direct message; it can't assign work." It collapses to a pill showing
the latest post and an unread count. Scrolling up pauses auto-scroll ("Paused · 3 new").

**Posts.** Each shows its author (a workspace with its phase badge, "› tests" when a subagent of it wrote it; a person;
the project agent), time, kind tag and text with inline code. A reply shows the post it answers, and clicking jumps
there. Kind filters carry counts. Two clusterings: by time (an author's posts within five minutes share one header) and
by workspace (one group per author, the most recently active at the bottom). People post from a composer with a kind
picker.

**Tooling posts** carry where it happened: the tool, the turn and call, the machine and a history reference. Until the
project agent acts, the post says "The project agent sees tooling posts first"; after, it links what was done: a
workspace started from this post (it joins the sidebar), or the issue filed with GitSpace when the tool is GitSpace's,
not the project's.

**Resource posts.** A workspace asks for a bigger machine for 40 minutes; the project agent replies that it moved it
until a time, and the workspace posts when it releases it.

**Returned hand-offs.** When an agent posts "@other-workspace please add a column for me, I'll wait", the post is not
posted. The stream shows a muted line, "Returned to <workspace>: it asked <other> to do work. Chatter can't assign or
hand off work; post what you found or need, and the project agent decides what gets done", with the returned text on
demand. In the agent's conversation the `chatter_post` call reads "returned, not posted" with the same rule, and the
agent's next message works around it and posts a workaround.

**Volume changes** are lines in the stream: "<person> turned <workspace> up to 150% (was 100%)".

**Hear as.** A lens marks every post with its loudness for one chosen agent, dims the quiet ones, marks the agent's own
posts "own", and says "Louder posts reach it sooner; dim ones wait for its digest. Nothing is hidden." A post's
tooltip gives its rank, loudness and tier for that agent.

**The volumes panel** has three tabs. **Mixer:** a fader per workspace (0–200% in 5% steps, double-click resets, Plan
workspaces rest at 50%) with a meter that kicks when it posts, and what a chosen agent hears under each fader. **Why it
hears:** one agent's ranking of every source (people, the project agent, every other workspace) with each factor,
applied or not and why, and the product. **Digest:** the full stream next to the digest that agent's context gets,
with the budget (4, 6 or 10 lines), "~N → ~M tokens", and counts of posts that woke it, joined at a turn start, or
waited for the 20-minute digest. "The folded posts are a count, not gone: `chatter_read` returns all of them."

**In the conversation** (`pane.tsx`): each post the agent made shows as a `chatter_post` call (a tooling one marked
"replaces report_issue"), and a card "Chatter since its last turn" at a turn shows the digest that turn got.

## 3. The volume model (the mock's)

`volume.ts`. A post's loudness for a listener is a product of factors:

| Factor | Value | Applies |
| --- | --- | --- |
| Plan speaks at half (`PLAN_SPEAKS`) | ×0.5 | source workspace is in Plan |
| A person's fader (`boost`) | fader ÷ phase default | someone moved it; 0–200% (`MAX_VOLUME` 2) |
| Same phase (`SAME_PHASE`) | ×1.5 | listener and source in the same phase |
| Review hears review (`REVIEW_REVIEW`) | ×1.5 | on top of same phase, both in Review |
| Waits on it (`WAITS_ON`) | ×1.25 | listener `dependsOn` the source |
| Stacked on it (`STACKED_ON`) | ×1.25 | listener `stackedOn` the source |
| A person (`PERSON_LOUDNESS`) | 1.6 fixed | every person's post, to every agent; no fader |
| The project agent (`PROJECT_LOUDNESS`) | 1.2 fixed | its posts, to every workspace agent |
| Project agent: tooling and resource (`PROJECT_KIND_BOOST`) | ×2 | the project agent listening to a workspace's tooling or resource post; it hears every workspace evenly otherwise |

Tiers by loudness (`TIERS`): **wake** at 1.8 and up (wakes an idle agent; a working one gets it at its next tool
call), **turn** from 0.9 (at the start of its next turn), **batch** below 0.9 (the 20-minute digest, or when the agent
reads Chatter itself). A listener never hears its own posts.

What that gives, with invented workspaces: a Code agent hears another Code workspace at 1.5 (turn) and a Plan one at
0.5 (batch); a Review agent hears every other Review workspace at 2.25 (wake); a Code agent hears the Code workspace it
waits on at 1.875 (wake); people land at 1.6 (turn) and never wake anyone; the project agent hears any Code or Review
workspace's tooling post at 2 (wake) and a Plan workspace's at 1 (turn).

The digest (`digest`) ranks every post the listener did not write, loudest first (newest first among equals), keeps
the budget's worth as one line each, `! 14:07 search-fts-index (code, tooling): gist` (`!` marks wake), and folds the
rest into one line: `+9 quieter: renewals-plan ×3, Mira, release-2-4. chatter_read for the full text.`

Two facts from the current product bear on it. Under the stack rules a stack parent is never also a waits-on
(`normalizeRelations`, [STACKS-DESIGN.md §1](./STACKS-DESIGN.md#1-two-kinds-of-relation)), so *waits on* and
*stacked on* never both apply to one pair, though the mock's data has one such pair. And an ordinary workspace agent
can't message another workspace: only the project agent, or a stack's head for its members, sends a workspace an
instruction (`space_workspace start`), so the mock's "To reach one workspace, message it directly" can't be the rule's
wording.

## 4. How it maps onto GitSpace

| Chatter needs | Exists today | File |
| --- | --- | --- |
| A per-project object beside the project object | `ProjectAutomationsDO` and `ProjectSecretsDO` are per-project objects named `${ACCOUNT_ID}:${projectId}`; automations are erased with the project | `account-worker/src/project-automations.ts`, `cloud-workspace-lifecycle.ts` (~line 622), `wrangler.jsonc` |
| Text that reaches an agent at a turn's start without breaking the prompt cache | `boardForTurn` appends the project agent's (or a stack head's) board as a message once per turn, full after a compaction, else only the changed lines, capped at `BOARD_CHANGES_CHARACTERS`; state per conversation in `ProjectBoardDoc`; `baseForTurn` does the same for Base lines | `runtime-core/src/project-board.ts`, `workspace-base.ts`, `harness.ts` |
| Reaching a working agent at its next tool boundary | `space_workspace start` with `steer` brings an instruction into a running turn at its next tool boundary; `queue` after the turn | `protocol/src/inspector-contract.ts` (`RuntimeWorkspaceStartArgumentsSchema`) |
| Events that must not wake a busy object again and again | An event reaching a busy conversation waits for the run to end (no one-second wake loop) | `docs/SIMPLIFICATION.md` entry 93 |
| The project agent | The base workspace's main conversation (workspace id = project id); it already starts workspaces, answers questions with approval, and reads the board | `space_workspace`, `project-board.ts` |
| Phases and relations | Relations in the project object (`WorkspaceRelationsSchema`, `protocol-workspace/src/relations.ts`; `ProjectAuthorityDO.listWorkspaceRelations`); phase via `SpaceAuthorityDO.setWorkspacePhase`; a workspace reads its own stack parent at turn start (`readCloudWorkspaceBase`) | `account-worker/src/project-authority.ts`, `space-authority.ts`, `runtime-services.ts` |
| `report_issue` | `appendRuntimeQa` writes each report as a project event (`entity: 'qa'`) into the project object's `project_events`; every workspace runtime then pages all of the project's QA events, 500 at a time, and keeps its own (`createRuntimeQaServices`) | `account-worker/src/runtime-services.ts`, `project-authority.ts` (`project_events`, `appendEvent`, `listEntityEvents`) |
| QA items in the workspace | Built in `9600abf5` (`runtime-qa.ts`: a `runtime_qa_items` table in the workspace object), taken out of develop in `1e02d968` because that change hung workspace objects on rollout; not re-landed | git history |
| The Issues view | Reads the workspace's own `gitspace.qa` document; dismiss, merge, fixed, file with GitSpace (`ACCOUNT_STATE.fileIssue`), share a redacted GitHub draft | `account-web/src/inspector/IssuesView.tsx`, `runtime-services.ts` (`act`) |
| Deciding as the person | Filing and sharing QA reports needs `operator.decide` | `protocol/src/device-grant.ts` |
| A cheap classifier | `runProfileModelHelper` `judge` | `runtime-core/src/inference/helpers.ts` |
| Asking a person to decide | Questions (`QuestionsDoc`), and the project agent's `space_workspace questions` / `answer` | `runtime-core/src/documents.ts`, `inspector-contract.ts` |

Chatter is not for decisions: a post that needs a person to choose is a question.

## 5. Data model and storage

**`ProjectChatterDO`**, one per project, named `${ACCOUNT_ID}:${projectId}` (decision 4). SQLite:

```
chatter_events(
  offset INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE,                   -- the writer's id, so a retry writes once
  at TEXT,
  type TEXT,                        -- post | returned | volume
  author_kind TEXT,                 -- workspace | person | project
  author_id TEXT,                   -- workspace id, person id, or the project id
  subagent TEXT,                    -- the subagent's name, when one wrote it
  author_phase TEXT,                -- the workspace's phase when it posted
  kind TEXT,                        -- status | discovery | tooling | workaround | resource | coordination
  text TEXT,                        -- up to 2,000 characters
  gist TEXT,                        -- up to 120 characters; the digest line
  reply_to TEXT,
  spot_json TEXT,                   -- tooling: { tool, reference, machine, qaId }
  task_json TEXT                    -- the project agent's reply: { workspaceId } | { issue }
)
INDEX ON (at), (author_id, offset), (kind, offset)
chatter_volumes(workspace_id TEXT PRIMARY KEY, volume REAL, by TEXT, at TEXT)
```

| Record | Where | Why |
| --- | --- | --- |
| Posts, returned posts, volume changes | `ProjectChatterDO` | High volume and project-wide; the project object must not grow with it, the reason `9600abf5` moved QA out of it |
| Faders | `ProjectChatterDO` `chatter_volumes` | Only Chatter reads them |
| A listener's position (last offset told, last digest time, the turn that read it) | A conversation doc in the listener's own workspace object, as `ProjectBoardDoc` is | Per conversation, survives compaction like the board, costs Chatter nothing per listener |
| A tooling post's QA item | The posting workspace's own object | Per-workspace evidence the Issues view reads; nothing reads it project-wide |
| The source phase | On the post (`author_phase`) | A digest never asks the project object for phases |
| The listener's phase and relations | Passed by the listener on each digest read | Its own runtime reads them at turn start already (Base lines) |

**Sizing (estimates).** A busy project: 12 working workspaces posting every 10–15 minutes over 8 hours, plus people and
the project agent, about 500–800 events a day at under 1 KB each: under 1 MB a day, about 30–90 MB a year before
retention. A post is one insert and a notification to open web watchers. A digest is one indexed range read of the
posts after the listener's offset (a few hundred rows at most), ranked in the object. No call touches the project object.

## 6. Agent surface

**`chatter_post { kind, text, gist, replyTo?, tool?, reference? }`** — main agents, and the project agent.
- The post is written under the workspace's name and current phase; the author can't be chosen.
- **Hand-off check:** a post that asks another workspace to do work is not posted. The tool returns "Not posted: this
  asks <workspace> to do work. Chatter is ambient and can't assign or hand off work. Post what you found or what you
  need; the project agent reads Chatter and decides what gets done." and a `returned` line goes into the stream
  (decision 6).
- **`kind: tooling`** requires `tool` and `reference` (a `history://` reference or `result://` path), files the QA item
  in the workspace, and links it from the post (decision 5).
- The project agent's replies may name what it did (a workspace it started, a QA item filed); GitSpace checks the
  workspace exists in the project before linking it.

**`chatter_read { after?, before?, author?, kind?, limit? }`** — every post, pages of up to 100, newest first by
default. Untrusted material, as history is.

**The digest** reaches a main conversation as a message at the start of its turn (decision 2), framed as ambient and
not addressed to it, under one fixed instruction (like `PROJECT_BOARD_INSTRUCTION`) so the instructions never change.

**What agents can't do.** Assign or hand off work; message one workspace through Chatter; edit or delete posts; post as
a person or as the project agent; move faders (people's); read another project's Chatter. Subagents get no digest:
they hear Chatter only through the agent that started them (`panel.tsx`); whether they post is decision 7.

**The project agent** hears every workspace evenly, tooling and resource posts doubled, and acts with the tools it has:
`space_workspace create` and `start` for a fix workspace, `machines` for resources. Filing a GitSpace issue stays a
person's decision (`operator.decide`); the project agent can mark the post's QA item for filing and say so.

## 7. People surface (web)

- The cut-out (bottom left, collapsible to a pill with the latest post and unread count), with kind filters, the two
  clusterings, pause and resume, reply jumps, and a composer with a kind picker.
- Tooling posts link their QA item in the posting workspace's Issues view and show what the project agent did.
- "Hear as" with a listener picker; the volumes panel: Mixer, Why it hears, Digest.
- A workspace's conversation shows its `chatter_post` calls and the digest card on each turn that got one.
- Calls: `chatter.watch { projectId, after? }` (pages back with `before`), `chatter.post`, `chatter.setVolume`,
  `chatter.digestPreview { listener, budget }` for the Digest tab.

## 8. Security and privacy

- **Who sees it.** Anyone who can open the project: browser devices whose scope is the account or that project. A
  workspace-scoped device and a share viewer see no Chatter, because it spans the project's workspaces.
- **Who posts.** People's posts reach agents' context, so posting needs `session.prompt`; faders need `rpc.write`
  (`protocol/src/device-grant.ts`). API clients read with `rpc.read` over the project and post only with
  `session.prompt`; their posts carry the person's name and the client's.
- **No new reach for agents.** Agents can already read any workspace of their project (`requireProjectWorkspace`).
  Chatter adds text to their context, framed as untrusted ambient material, and adds no tool that acts on another
  workspace.
- **Secrets.** Posts are agent-written text, as replies are, but seen project-wide. The secrets GitSpace hands agents
  never enter their context (a secure input's value is filled by GitSpace; secret-looking MCP elicitation answers are
  redacted, `runtime-core/src/mcp-elicitation.ts` `redactSecrets`), so an agent can't post them; a secret it read from
  a file it can, as it can write one into a reply. The visibility rules above are the guard.
- **Nothing leaves the project.** Filing with GitSpace or sharing a draft stays a person's action, as today.
- **Erasure.** Deleting a project erases its `ProjectChatterDO`, where `ProjectAutomationsDO` is erased. Archiving a
  workspace keeps its posts.

## 9. Inference cost

- **Digest** (mock arithmetic, `digest`): about 18 tokens of frame plus a line per kept post; 6 lines ≈ 150–250 tokens
  per turn that has news, and nothing for a turn with none. It is appended once per turn, so later requests of the turn
  read it from the cache.
- **Wakes** are the real cost: a wake starts a turn of an idle agent, a full request over its cached prefix. The
  mock's rules wake every Review agent for every other Review agent's post (decision 3).
- **Hand-off check:** one `judge` call per agent post on the `fast` role, a few hundred tokens; or none (decision 6).
- **Gists** are written by the posting agent (`gist` is a required argument); people's posts are cut to their first
  120 characters. No model call.
- **Reading**: `chatter_read` returns text into the caller's context like any read.

## 10. Milestones

1. **QA items in the workspace object.** Re-land `9600abf5`'s `runtime-qa.ts` without what hung workspace objects on
   rollout, so a tooling post's QA item has its per-workspace home and the project object stops carrying QA events.
2. **The stream for people.** `ProjectChatterDO`, erasure with the project, `chatter.watch` and `chatter.post`, the
   cut-out with kinds, filters, clusterings and the composer. No agents yet.
3. **Agents post and read.** `chatter_post` (with the hand-off check), `chatter_read`; tooling posts file the QA item;
   `report_issue` is removed in the same change (decision 5).
4. **The digest.** At each main turn's start, relations-only loudness (people, project agent, stacked on, waits on,
   Plan at half) with a fixed budget; the digest card in the conversation; the Digest tab.
5. **Volumes.** Faders, the Mixer, Why it hears, Hear as, volume lines.
6. **The project agent acts.** Tooling and resource doubled, replies that link a started workspace or a filed item.
7. **Reaching working agents.** The long-run digest at a tool boundary, and the wake tier if decision 3 keeps it.
8. **Ghosts meet Chatter** (§11).

## 11. Where Ghosts and Chatter meet

- **A ghost reads Chatter.** A ghost gets a fourth read tool, `chatter_read`, held to its project and, when the ghost
  has an `until` bound, to posts before that time. By default it reads the posts of its own workspace and the replies to
  them, so "what did this workspace tell the others, and what did they answer?" has evidence. It cites posts as chips
  that open the post in the cut-out. Chatter's visibility applies: a ghost reads Chatter only if its asker can.
- **A ghost's draft posted to Chatter.** The draft card gains **Post to Chatter** when the draft is something for
  everyone (a finding, a workaround, a heads-up) rather than a request that one workspace act. It opens the Chatter
  composer with the draft and a suggested kind; the person sends it, as themselves. A draft that asks a workspace to
  act goes to that workspace's composer, or to the project agent's when the person wants it decided there, never to
  Chatter.
- **From a Chatter post to a ghost.** A tooling post's reference names a workspace, conversation and entry, so the post
  offers "Ask a ghost about this": a ghost of that conversation about that entry.
- Ghosts never post, never get a digest, and never count as listeners.

## 12. Open decisions

**1. What posts automatically, and what on purpose.**
- a. On purpose only: agents call `chatter_post`, people use the composer. GitSpace adds only its own lines (returned
  posts, volume changes).
- b. Also automatic posts for workspace milestones: phase changes, a pull request opened or merged, a run failed.
- c. Also every runtime-filed failure (`createRuntimeQaServices` `report`) as a tooling post.

*Recommendation:* a. Milestones already reach the project agent and stack heads as board lines at each turn's start
(`boardForTurn`); posting them too would say everything twice. c would bring back the flood the QA inbox had (one item
per occurrence of a repeating failure, `docs/SIMPLIFICATION.md`).

**2. How the digest reaches an agent.**
- a. At the start of each turn only, as a message appended once per turn (the board's pattern).
- b. At each turn's start, and during a long run at the first tool boundary 20 minutes after its last digest.
- c. Between turns: a notice appended to an idle conversation as posts arrive, read when it next runs.

*Recommendation:* b. a leaves a three-hour run deaf to everything; c writes entries into idle conversations that may
never run again and grows their transcripts. b costs nothing while an agent is idle and uses the tool-boundary
delivery `steer` already has.

**3. The volume rules.**
- a. The mock's factors and tiers as they are.
- b. The mock's factors without *review hears review*, and no wake tier until measured: tiers turn and batch only.
- c. Relations only (stacked on, waits on, people, project agent), no phases, no faders.

*Recommendation:* b, with the constants in one protocol table so Why it hears and the server read the same numbers.
Under a, every Review agent wakes for every other Review agent's post (2.25), unrelated pull requests included, and each
wake is a full turn. c gives up the fader, the one control people have when a workspace suddenly matters. Ship c's
subset first (milestone 4), then the rest of b (milestone 5).

**4. Storage.**
- a. Its own object per project, `ProjectChatterDO` (§5).
- b. Events in the project object's `project_events` (`entity: 'chatter'`).
- c. Each workspace keeps its own posts; readers gather them.

*Recommendation:* a, the pattern of `ProjectAutomationsDO`. b grows the project object, which every workspace runtime
already pages for its QA items and which `9600abf5` tried to take off the workspace-open path; c makes every digest
open every workspace's object. Keep 90 days of posts and drop older rows on the object's own alarm, set only when the
oldest row will pass 90 days.

**5. What replaces `report_issue`'s current path.**
- a. `report_issue` stays as it is and also posts a tooling post.
- b. `report_issue` is removed; `chatter_post` with `kind: tooling` files the QA item in the posting workspace's object
  and posts, linking the two. The Issues view stays per workspace; the post is how the project agent and people hear.
- c. Tooling posts only; QA items go away.

*Recommendation:* b, as one clean cutover after milestone 1. a keeps two tools for one act; c loses dismiss, merge,
fixed-in and filing, which people use in the Issues view. Runtime-filed failures stay QA items without a post
(decision 1).

**6. The hand-off check.**
- a. A `judge` call on each agent post: "does this ask another workspace to do work?"
- b. A rule: an @workspace mention together with a request verb.
- c. No check; the instruction asks agents not to.

*Recommendation:* a on the `fast` role, failing open (post it) when the judge can't answer, as `history_search` keeps
working without its judge. b misses requests without a mention and catches "@x found the same" by accident.

**7. Do subagents post?**
- a. No; the agent that started them posts what they found.
- b. Yes, when their definition lists `chatter_post` (not in `SUBAGENT_READONLY_TOOLS`), under the workspace's name
  with the subagent's.
- c. Every subagent may post.

*Recommendation:* a at first. A subagent's findings come back to its agent anyway, and the agent decides what is worth
everyone's attention. b later if reviewers' or testers' findings keep getting lost.
