# Blog restructure — island inventory and disposition

Working notes for collapsing the eight-post index down to four. The prose can
be rewritten; the islands are the sunk cost worth protecting. Every interactive
or animated component prototyped in Nº 04–08 is listed here with where it goes.

Pending approval of the final shape (see the read-back in session). Numbers
below are the ORIGINAL episode numbers.

## The final shape (four posts)

| Nº | Slug | Title | Islands after the merge |
|----|------|-------|--------------------------|
| 01 | babysitting-agents-sucks | Babysitting agents sucks. | (unchanged) |
| 02 | evidence-not-vibes | Agents lie about what they shipped. | RunTheRubric, TheContractGetsWritten, TheWorkflow, VibesVsEvidence (unchanged) |
| 03 | the-change-guide | The change guide. | ChangeGuideExplorer **+ BlameExplorer** (from 05) |
| 04 | goals-ship-in-order (renumbered) | title TBD at merge | ChainKanbanShot, ChainBuilder **+ MorningAfter + PromoteRollup** (from 07) |

Cut: Nº 04 "The workflow and the goal", Nº 08 "What's running, and what
happened" (islands never built; prose draft + ideas in
`drafts/processes-and-events.md`).

## Islands being MERGED — must survive intact

### BlameExplorer (05 → 03) — `src/episodes/05-the-agent-change/islands/BlameExplorer.tsx`, 337 lines

The one big demo of Nº 05. A code panel where every line maps to the
CONCEPTUAL CHANGE that owns it (introduced / moved / refined), each entry
backed by a phase-journal intent quote declared BEFORE the edit. An x-ray
toggle tints the whole file by concept. Adapted from `docs/agent-blame.html`.

Merge notes:
- 03's ChangeGuideExplorer answers "in what order do I read this change?";
  BlameExplorer answers "which concept owns this line?". Same journal-backed
  worldview, zero overlap in mechanism — they compose rather than compete.
- Both are self-contained (own colour constants, no shared imports beyond
  React). Move = relocate file + add one import to 03's index.
- 03's prose needs a bridge section: guide (macro, cluster order) → blame
  (micro, line ownership). The journal quote is the connective tissue: the
  same phase intent that orders the clusters owns the lines.

### MorningAfter (07 → merged 06) — `src/episodes/07-shipped-isnt-done/islands/MorningAfter.tsx`, 268 lines

Two-beat interactive: reader fires the nightly cron, stale dashboard tiles
refresh with a mono line showing the data commit rolling up to main; reader
advances a day, error rate crosses the rubric threshold, tile flips amber,
and the shipped goal card REOPENS with the original rubric line quoted as
the reason. The rubric that shipped it is the tripwire that reopens it.

Merge notes:
- This is the emotional payoff of the merged post — the chain isn't done at
  merge. Place it AFTER ChainBuilder so the lifecycle reads: compose the
  chain → ship in order → the morning after.
- Visual language already matches product hexes + square corners + 1px
  hairlines (SITE-THESIS migration rule) — same family as ChainBuilder.

### PromoteRollup (07 → merged 06) — `src/episodes/07-shipped-isnt-done/islands/PromoteRollup.tsx`, 184 lines

Two moves that build the record: PROMOTE (a typeless `local://` draft gains a
typed path — the moment the product can see it) and ROLLUP (the workspace's
artifacts branch merges into main; the goal folder arrives intact).

Merge notes:
- Supporting demo, not the headline. It explains WHERE MorningAfter's
  dashboard data comes from. Order in the merged post: ChainBuilder →
  PromoteRollup (how the record builds) → MorningAfter (what the record does
  after ship).
- If the merged post runs long, this is the one island that could compress
  to a static two-panel figure without losing the argument. Flagging the
  option, not recommending it.

## Islands STAYING PUT (merge target side)

### ChangeGuideExplorer (03) — 356 lines
Change-guide explorer over the checkout_v2 flag removal. Left: clusters in
build order with beat badges. Right: the narrated beat (guide prose grounded
in the phase journal, files touched, mini diff). Contrast toggle shows the
same change as the flat alphabetical 14-file list a normal PR page gives you.

### ChainBuilder (06) — 348 lines
Reader composes a goal chain with the one planning verb, add-after. Track and
order badges grow; a mono log echoes the real command (`space chain add-after
--goal <id> --title "..."`). Marking the active goal done removes its
workspace and visibly unblocks the next goal. Semantics mirror the
space-chain skill exactly, including phase-enforced insert refusal.

### ChainKanbanShot (06) — `src/components/landing/ChainKanbanShot.tsx`
Shared component, referenced from 06's index. Stays with the merged post.

## Islands from CUT posts — parked, not deleted

### DeriveTheContract (04) — `src/episodes/04-the-workflow-and-the-goal/islands/DeriveTheContract.tsx`, 671 lines

The biggest island in the series. Reader types (or picks) a goal; the
CONTRACT derives live — phase nodes and edges draw as a workflow graph,
requirements appear with kind/rubric/judge columns, and the phase journal
records intent → outcome → decision. It is the "state the goal and
everything else follows" thesis, animated.

Disposition: RESOLVED — moved whole into ep02 (approved in session). Now at
`src/episodes/02-evidence-not-vibes/islands/DeriveTheContract.tsx`, rendered
in a new section "The whole contract derives from the goal" between
TheContractGetsWritten and "The reviewer attacks the rubric first". The two
islands compose: the chat shows the agent WRITING three checks; this shows
the same thing as a DERIVATION from the goal (phases + requirements +
journal). Its checkout_v2 scenario even matches the chat's R3. ep04's index
temporarily imports from the new path until the episode is deleted.

### Nº 08 islands — never built
Prose-only draft. Island IDEAS (service table with live-updating uptime,
four-channel event tail with backpressure meter, "watching never changes
what you watch" split-pane) are already captured with source file:line refs
in `drafts/processes-and-events.md`. Nothing to migrate.

## Mechanical checklist for the merge (when approved)

- [x] Move island files into target episodes' `islands/` dirs (git mv, keep history)
- [x] Add imports + placement in target `index.tsx` per the orders above
- [x] 03: guide→blame bridge ("Six months later, the question inverts")
- [x] 06+07: title "Shipped isn't done." (07 survives, kicker Nº 04); seam is
      "…the chain still reads top to bottom as what happened. Which sounds
      like the end. It's the midpoint." → "The morning after a goal ships"
- [x] `BlogIndex.tsx`: 4 entries, kickers Nº 01–04, deks widened for merges
- [x] `App.tsx`: 4 dead routes + imports removed (plain 404, no redirects —
      drafts never shipped publicly)
- [x] DeriveTheContract disposition — moved into ep02, new section written
- [x] Dead-link sweep: clean outside the parked episode dirs

## Parked on disk (unrouted, still compiling)

Episode dirs 04, 05, 06, 08 remain with import redirects into the new island
homes (04→ep02, 05: BlameExplorer now in 03, 06→07). PromoteRollup and
MorningAfter never moved: 07 was already their home and it survived. Delete
the four dirs whenever; nothing routes to them.
