# Block documents and comments

Status: slices A–E built (D, the Goal and Change Guide: SIMPLIFICATION 287, 2026-11-17; E, drive docs and the sidebar preview: SIMPLIFICATION 292, 2026-11-17). Decided with the user: one document model for chat turns, the Goal, the Change Guide
and drive docs; comments are the one way a person responds to what an agent wrote; threads reuse chat comments;
requirements stay the agent's to track (the optional acceptance button stays as it is, nothing waits on it); every
Change Guide gets a walkthrough.

## 1. Model

A **document** is something an agent wrote that a person reads: a chat turn, the workspace Goal, a Change Guide
revision, or a drive doc. A document is a sequence of **blocks**: prose (paragraphs, headings, list items, quotes) and
`gitspace-ui`, `svg` and `mermaid` fences, as today. Some documents also have **entities** with ids the system already
keeps: requirements (`requirement:<id>`), journal decisions (`decision:<entryId>`), plan steps (`step:<id>`), Guide
sections (`section:<id>`) and their exhibits (`exhibit:<sectionId>:<path>`), and tool calls (`tool-call:<id>`).

| Document | Id | Lifespan | Comments |
|---|---|---|---|
| Chat turn | conversation id + turn id | fixed once the next input arrives | what the agent wrote since the last message (§4); lock when sent |
| Goal | workspace + goal revision | revised in place (`SpaceContextDO.putGoal`) | stay open across turns |
| Change Guide | workspace + guide revision | immutable revisions (`putChangeGuide`) | stay open; carry forward unchanged sections |
| Drive doc | drive path + content hash | versioned files | stay open; outdated when the file changes |

**No storage migration.** Goal, Guide, journal and plan keep their tables in `SpaceContextDO` and their writers and
readers. "Block document" is how they are drawn and anchored: the renderer walks the record's fields and Markdown into
blocks, gives every block an id, and draws the entities as typed blocks (`Requirement`, `Decision`, `Evidence`,
`GuideSection`, exhibits). Agents keep writing through `space_goal`, `space_guide` and `space_journal`.

## 2. Block ids

- **Fenced blocks:** an element may carry `id` (1–64 characters, unique within its document; the validator checks
  uniqueness per Markdown field and per document). `BlockRef { id }` draws another block of the same document; a
  reference may name another document as `<document>#<id>` (a chat turn's block shown in the Guide).
- **Prose blocks:** no stored id. Their anchor is a text-quote selector (below), so rewording elsewhere never moves it.
- **Entities:** their existing ids.

## 3. Comment anchors

```ts
type CommentAnchor = {
  document:
    | { kind: 'turn'; conversationId: string; turnId: string }
    | { kind: 'goal'; revision: number }
    | { kind: 'guide'; revision: number }
    | { kind: 'drive'; path: string; hash: string };
  target:
    | { kind: 'block'; id: string }                                    // a fenced block with an id
    | { kind: 'item'; block: string; path: string; label: string }     // a row, step, line or frame inside a block
    | { kind: 'entity'; ref: string }                                  // requirement:…, section:…, tool-call:…
    | { kind: 'text'; within: string | null; exact: string; prefix: string; suffix: string } // selection or paragraph
    | { kind: 'lines'; exhibit: string; side: 'base' | 'head'; start: number; end: number; blobId: string | null }
    | { kind: 'time'; block: string; seconds: number }                 // video or Sequence frame start
    | { kind: 'frame'; block: string; index: number };
  quote: string;                                                       // what the person saw, ≤ 280 characters
};
```

- `text` is a W3C-style text-quote selector inside `within` (a block id or entity ref, or the whole document). Its
  prefix and suffix (up to 32 characters each) come only from the paragraph, list item, heading or fenced block the
  quote starts and ends in, so editing a neighbouring paragraph never moves or outdates it. It is found again by exact
  match with prefix and suffix under the same bound; when it is gone the comment is **outdated** and shows its quote.
- A comment on a Guide revision carries forward to the next revision when its section's `contentHash` is unchanged;
  otherwise it stays on its revision, shown as outdated on the new one with a link to the old.
- `lines` replaces review threads' `line` and `hunk` anchors for exhibits.

## 4. Lifecycle (comments live in the transcript)

Comments are transcript things. A sent comment is part of the person's message, and an answer is part of the agent's
message; nothing else stores them, and they exist exactly as long as those messages do (a rewind or a fork that drops
the messages drops the comments with them).

1. **Stage.** A comment is written against an anchor and kept with the composer draft (a durable runtime document, so
   it survives reloads and shows in every tab). It shows as a chip above the composer and a pill in the margin. A
   chat comment goes on what the agent wrote since the newest message from a person (including one that only sends
   staged answers or comments) or the project agent: the **comment window**. Automated inputs (background job, PR or
   CI batch, machine, wake-up and watch notices; the hidden block-fix step) open turns inside the window, not a new
   one, so the agent's replies to them take comments and comments staged before them stay. Before the first such
   message nothing takes comments. The runtime's `commentWindow` (`runtime-core/src/comments.ts`) decides both the
   check on `stageComment` and, published as `window` in the snapshot's `gitspace.comments`, the browser's lock.
2. **Send.** The next message carries every staged comment: the person's text, plus each comment as its quote, note
   and anchor in the structured data the composer already uses for staged choices.
3. **Reply.** The agent answers a comment with a `Reply { comment, … }` block in its message. The reply shows in the
   chat and under the comment in the document.
4. **Follow up.** A further comment on the same anchor is a new staged comment; the document shows the anchor's
   comments and replies in order as its thread.
5. **Lookup.** To draw a document's comments without scanning the whole transcript, the runtime keeps a lookup
   derived from it (comment id → anchor → message, reply → comment). It holds pointers only, is updated as messages
   are stored, is never written to directly, and can be rebuilt from the transcript at any time.
6. **Age.** A chat-turn comment's blocks lock once sent. A Goal, Guide or drive thread has no resolved state: when the
   agent changes the anchored block the thread shows **outdated** next to the change; otherwise it stays with its
   replies, and older threads fold to one line.

Review threads (`inspector_review_*`, `space_review`) are retired: existing threads stay readable, read-only, on their
old anchors; new comments use this layer.

## 5. Typed blocks

- `Requirement`: title, description (Markdown), status, evidence; drawn from the requirement row. The agent marks it
  done through `space_goal` as today and covers it in the Guide (`requirementIds` on sections, as today). The optional
  acceptance button is unchanged.
- `Decision`: a journal decision entry, with citations and `supersedes`.
- `Evidence`: a reference (commit/blob, artifact hash, run id, review comment) drawn as a link card.
- `GuideSection`, exhibits: the Guide's section and exhibit records; exhibit diffs are computed on read as today.
- `Sequence`, `Image`, `Video`, `CallDiff`, `StateFlow`, `SchemaDiff`, `MetricDelta`, `Timeline`, … join the
  `gitspace-ui` catalog (today they exist only in the private mock).

## 6. Change Guide walkthrough

`space_guide.put` takes an optional `walkthrough`: a `Sequence` whose frames are the guide at a glance (`overview`) and
the sections, their diagrams and exhibits by reference, each with a spoken line. The `review-guide-narrator` skill
writes it with every Guide. A Guide without one (older revisions) plays a walkthrough built from it: the overview, then
each section's diagram, else its first exhibit, else the section, each saying the section's title and the first
sentence of its summary. The player makes the next frames' clips while one plays, and a frame whose clip fails, is
refused or is late shows its line on its reading time with a note that the voice is off. Shares carry the
walkthrough; they still carry no comments.

## 7. Build order

| Slice | Contents | Depends on |
|---|---|---|
| A. Block foundation | ids, `BlockRef`, required asks as durable questions, `Image`/`Video`, `Sequence`, the explain components in the real catalog and renderers | — |
| B. Chat comments | anchors (§3), staged comments, sending, the derived lookup (§4), `Reply`, locking, the margin; agent instructions | A's ids |
| C. Speech | Speech service row (Cloudflare Aura, voice choice in onboarding and settings), player voice menu, stored clips | — |
| D. Goal and Guide | typed blocks (§5), comments on them, carry-forward, retiring review threads, the walkthrough (§6) | A, B |
| E. Drive docs and sidebar | drive docs drawn as block documents with comments; the sidebar's last-message preview | B, D |

## 8. Open points

- Whether the project agent sees other workspaces' comments (through their transcripts, as it reads history today).
- Media anchors for PDFs (page and region) and images (region): later, same `target` union.
