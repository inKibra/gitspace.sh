# Visual Parity Issues (11-surface screenshot audit, 2026-07-05)

138 raw issues merged into 56 ordered items. Mock :5199 vs real :5173.
Fix top to bottom; re-capture pairs + re-audit after each batch. NO done-claims until a re-audit round is clean.

## 1. [high] GLOBAL: sans chrome font regime — kill the all-mono rendering at the root
**Surfaces:** Board, shell-agent, goal, workflow, review, rubric, crons, events, dashboard, note, projecthome
**Files:** src/web/index.css, src/lib/theme.web.ts, src/components/KanbanBoard.web.tsx, src/components/GoalDocPanel.web.tsx, src/components/WorkflowPanel.web.tsx, src/components/ChangeGuide.web.tsx, src/components/ReviewRubric.web.tsx, src/components/Events.web.tsx, src/components/NotePanel.web.tsx, src/pages/ProjectHomePage.web.tsx, src/app.web.tsx

Root cause: web/index.css body{font-family:var(--gs-font)} defaults everything to Geist Mono and pane roots never opt into sans, so every surface renders all-mono while the mock reserves mono for identifiers only. Fix once: make sans-chrome (--gs-ui / Inter) the default theme (src/lib/theme.web.ts + web/index.css body rule), or minimally add the existing `gs-ui` class (web/index.css:1485) to each pane root: GoalDocPanel.web.tsx:109 (also remove mono from chain-number span ~156; goal-01/goal-10), WorkflowPanel.web.tsx:59 (workflow-02), ChangeGuide.web.tsx:261 (review-font-mono-chrome), ReviewRubric.web.tsx:328 + empty state :318 (rubric-02), Events.web.tsx pane root (events-08, keep tnum mono only on time spans), ProjectHomePage.web.tsx:269 (ph-font-chrome-mono), NotePanel.web.tsx header (note-06), the crons pane header/copy in app.web.tsx ~2931 (crons-11), and dock tab labels in the app.web.tsx tab renderer (crons-13). KanbanBoard.web.tsx:803-806 column headers go sans sentence-case font-semibold with dim tnum count (board chrome-font). Keep explicit font-[family-name:var(--gs-font-mono)] spans on identifiers (workspace names, paths, refs, scores, timestamps). After landing, re-screenshot and verify goal header/chain/footer are sans while bound-surface/plan-ref/code stay mono (goal-10).

## 2. [high] GLOBAL: fix visual-audit capture flow — wrong/empty panes were screenshotted
**Surfaces:** workflow, note, shell-agent
**Files:** src/app.web.tsx

Three surfaces were never actually captured: (workflow-01) both mock-workflow.png and real-workflow.png show the Goal pane — capture must click the '⟜ Workflow' dock tab (real: app.web.tsx extra.kind==='workflow'; mock: Shell.tsx tab id 'workflow') before screenshotting; (note-01) real-note.png shows a 'ship' dashboard tab instead — capture must open a note tab via the right-rail NOTES entry and verify NotePanel.web.tsx mounts as a dock tab; (shell-agent-01, capture half) the agent surface showed 'No active session' because no agent session was created — the demo flow must run handleCreateAgentSession / handleOpenAgentSession (app.web.tsx ~3205-3221) before capture. Re-run the visual diff for all three surfaces afterwards.

## 3. [high] GLOBAL: panes stuck in loading/timeout — backend command resolution failures
**Surfaces:** review, note, dashboard
**Files:** src/components/ChangeGuide.web.tsx, src/components/DashboardPanel.web.tsx

Three panes never reach their populated state, blocking all downstream visual comparison. (review-diffs-stuck-loading) Every FileDiffBlock in ChangeGuide.web.tsx:110-125 shows 'Loading diff…' — get_file_diff requests never resolve for any file, so debug the review backend sendReviewRequest queuing/handler and consider batching/serializing requests. (note-02) Right rail shows only 'Timed out waiting for command response (list_artifacts)' so NOTES entries can't even be opened — fix the session-backend list_artifacts path; likely a stale tmux-lite daemon (daemon caches server code — restart it, not just dev:web). (dash-01) DashboardPanel.web.tsx useEffect load path (lines 91-117) never resolves read() of ship.dashboard.json — ensure the `read` prop is memoized (new function identity per render restarts the effect into a permanent 'loading' loop), verify ship.dashboard.json exists on the artifacts branch, and add a timeout/visible error instead of indefinite loading.

## 4. [high] GLOBAL: GitSpace GlobalChrome header — brand + workspace tabs + inbox + ⌘K on Board and workspace shell
**Surfaces:** Board, shell-agent
**Files:** src/pages/BoardPage.web.tsx, src/app.web.tsx, agent-surfaces-app/src/app/GlobalChrome.tsx

Both top-level surfaces have ad-hoc headers instead of the mock's single GlobalChrome bar: brand 'GitSpace' + project name, ⊞ board link, open-workspace tabs with stage labels (profile-model PLAN, haptics-plugin CODE active, etc.), right-side icon buttons, flag/inbox glyph with count badge, ⌘K chip, 'AGENT SURFACES · CONCEPT' wordmark. (board-chrome-header) BoardPage.web.tsx:189-259 currently reads 'Project Board ⌂ home · 2 worktrees ◐ Brutalist' with mono text buttons '+ New / Inbox / ? / Cmd+K / Refresh / Disconnect' — replace with the GlobalChrome-style bar; drop Cmd+K/Refresh/Disconnect text buttons or move to overflow. (shell-agent-03) WorkspaceDetailPage in app.web.tsx has two stacked ad-hoc rows ('multi-pane' chip row + '← Board multi-pane Code 0 session(s) · 0 replay(s)') — replace with the same GlobalChrome pattern and drop the session(s)/replay(s) counters. Port from agent-surfaces-app/src/app/GlobalChrome.tsx and Shell.tsx.

## 5. [high] GLOBAL: persistent bottom activity strip (lifecycle taskbar) on Board and workspace shell
**Surfaces:** Board, shell-agent
**Files:** src/pages/BoardPage.web.tsx, src/app.web.tsx, agent-surfaces-app/src/app/ActivityStrip.tsx, agent-surfaces-app/src/app/GlobalChrome.tsx

Mock has a full-width bottom lifecycle strip: status dot + 'Removing share-extension-target', PREPARE/SETUP/SELECT/REMOVE step pills (active highlighted amber), elapsed '0:12', '+1 QUEUED' chip, right chevron. (board activity-strip-missing) BoardPage.web.tsx renders nothing at the bottom — add a BottomTaskbar per agent-surfaces-app/src/app/GlobalChrome.tsx BottomTaskbar (lines 50-74), fed from deletingWorkspaceIds/creatingWorkspaceIds. (shell-agent-04) The real WorkspaceRemovalTaskBar only appears transiently and inline — port agent-surfaces-app/src/app/ActivityStrip.tsx into app.web.tsx WorkspaceDetailPage bottomContent as a persistent strip driven by workspace lifecycle tasks/queue state, not only removal tasks.

## 6. [medium] GLOBAL: bottom-right toast stack with tone-colored left bars
**Surfaces:** Board, shell-agent
**Files:** src/app.web.tsx, src/pages/BoardPage.web.tsx, src/components/KanbanBoard.web.tsx, agent-surfaces-app/src/styles.css

Mock toasts anchor bottom-right with a tone-colored left bar + glyph (✓ success / ✕ error / › info), two-line body (title + dim sub, e.g. '✓ verify:haptics exit 0' / 'haptics-plugin · device-rig'), and dismiss ✕. (shell-agent-10) app.web.tsx (~line 3264 and other <Toaster> usages) configures Sonner top-right with richColors — set position="bottom-right" and restyle via toastOptions to match the mock chrome. (board toasts-missing) KanbanBoard.web.tsx renders only a single amber boardMessage box (lines 905-909) — replace with the shared Toaster per GlobalChrome.tsx Toaster + .toast styles in agent-surfaces-app/src/styles.css.

## 7. [high] Board: add PROJECTS strip above the kanban
**Surfaces:** Board
**Files:** src/pages/BoardPage.web.tsx, agent-surfaces-app/src/app/Board.tsx

(board-projects-strip) Real board starts directly with columns; mock has a top 'PROJECTS' section: kicker, 'filter projects…' input, project cards (mono name + pulse dot, 'N chains · N workspaces · N active', 'enter project home →' link), green '＋ New project' button right-aligned. Add the ghome-projects section above the kanban per agent-surfaces-app/src/app/Board.tsx lines 68-83 (filter state, projcard grid, New project button).

## 8. [high] Board: ALL WORKSPACES kicker + Workspaces/Stacks segmented toggle + Stacks view
**Surfaces:** Board
**Files:** src/pages/BoardPage.web.tsx, src/components/KanbanBoard.web.tsx, agent-surfaces-app/src/app/Board.tsx

(board-mode-toggle) Mock has an 'ALL WORKSPACES · ACROSS PROJECTS' kicker with a Workspaces/Stacks segmented toggle (active tab green-underlined); real has neither the kicker, the toggle, nor any Stacks view. Add the board-modes toggle + Stacks lane view per Board.tsx lines 85-91 and Stacks() lines 29-59.

## 9. [high] Board: cards become bordered boxes with status-colored left edge
**Surfaces:** Board
**Files:** src/components/KanbanBoard.web.tsx, agent-surfaces-app/src/styles.css

(card-box-style) Real cards are flush borderless list rows (border-l-transparent, gap-0) blending into the column; mock cards are bordered boxes with a 2px status-colored left edge (green/amber/blue/red/grey), surface background, ~8px gaps. In WorkspaceCard (~line 475) and PlannedGoalCard (~line 397): add outer border + bg-[var(--gs-bg-surface)], borderLeftColor from workspace status primaryColor, and change the lane container gap-0 (line 807) to gap-2; mirror .wscard in agent-surfaces-app/src/styles.css.

## 10. [medium] Board: column chrome — header blurbs, bottom border, wide dark gutters
**Surfaces:** Board
**Files:** src/components/KanbanBoard.web.tsx, agent-surfaces-app/src/data/mock.ts

(col-blurb-missing) Each mock column header carries a muted 11px description ('Author the spec — goal, rubric, review-gated workflow. Not editing the repo.' etc.) — add a STAGE_BLURB-style muted line to the column header block (~line 803) per Board.tsx line 104 / mock.ts STAGE_BLURB. (column-gutters) Real has 1px full-height light rules between columns (gap-px bg-[var(--gs-gap)], line 797); mock separates columns with wide dark gutters and only a bottom border on the column header — replace with ~gap-6 transparent gutters and add border-b to the column header per .ghome-col-h.

## 11. [medium] Board: card footer with machine chip + gates tally
**Surfaces:** Board
**Files:** src/components/KanbanBoard.web.tsx

(card-footer-machine-gates) No machine label or gates tally on any real card. Add a footer row to WorkspaceCard per Board.tsx lines 21-24: machine chip (online dot + 'local'/'device-rig'/'cloud-01') on the left, 'N/M gates' tabular tally on the right (green when full, amber otherwise), using machineLabel/isRemote + goal gate data.

## 12. [medium] Board: human summary line instead of dim mono goal/branch line
**Surfaces:** Board
**Files:** src/components/KanbanBoard.web.tsx

(card-summary-line) Real second line is goal title / '(branch)' in 10px dim mono; mock is a human summary sentence in muted 12px sans ('Render the profile at 128 BPM from the shared model'). At lines 407-409 and 508-510: render summary/goal title at text-[12px] text-[var(--gs-text-muted)] sans and drop the parenthesized branch styling.

## 13. [medium] Board: chain badge always visible + remove BLOCKED / NO ISSUE KEY chips
**Surfaces:** Board
**Files:** src/components/KanbanBoard.web.tsx

(chain-badge-hidden) ChainHandle is opacity-0 until hover (chainHoverClass, lines 43-45), so the mock's persistent 1/3-style chip at card top-right is invisible by default — return 'opacity-100' when a card has a chain, keeping hover emphasis only for the related/dim treatment. (extra-chips) Mock has no boxed uppercase 'BLOCKED' or 'NO ISSUE KEY' chips — stop rendering the 'No issue key' chip (lines 567-569) and the blocked PmChip on planned cards (line 411 / getGoalStatusChip fallback line 89); encode blocked state via the status dot + left-border tone instead.

## 14. [low] Board: low polish — filled status dots + card stagger animation
**Surfaces:** Board
**Files:** src/components/KanbanBoard.web.tsx, agent-surfaces-app/src/styles.css

(planned-dot-glyph) Replace the ●/○ text glyphs at lines 402 and 494 with a span whose background equals the status color (same value as borderLeftColor), matching mock wscard-dot. (card-stagger-anim) Cards should animate in with a 45ms stagger — pass index to cards and set animationDelay i*45ms per Board.tsx line 14 + .wscard keyframes in styles.css.

## 15. [high] shell-agent: seed default dock panes + mock tab strip (glyphs, running dot, Split) + chrome-preserving empty state
**Surfaces:** shell-agent
**Files:** src/app.web.tsx, src/components/DockviewWorkspaceShell.web.tsx, agent-surfaces-app/src/app/Shell.tsx

(shell-agent-02) No pane tab strip renders because no default pane set is seeded — seed default dock panels (agent + goal + workflow + change-guide) when entering a workspace, mirroring Shell.tsx tabs ['agent','goal','workflow','review']; in DockviewWorkspaceShell DockTab add the green running wdot for agent panels and pane-glyph prefixes (◇ Goal, ⟜ Workflow, ⛓ Change Guide) plus a right-aligned '⇆ Split' rightHeaderActions button. (shell-agent-01, UI half) Replace the bare centered 'No active session' text (app.web.tsx ~3205-3221) with an empty-state that still shows the pane chrome (tab strip + chat scaffold) per Shell.tsx.

## 16. [medium] shell-agent: chat header — ctx progress bar, session usage, minimal controls behind gear
**Surfaces:** shell-agent
**Files:** src/components/AgentPaneHeader.web.tsx, agent-surfaces-app/src/app/AgentChat.tsx

(shell-agent-05) Mock chat header is minimal: '✦ Opus 4.8 ▾' + 'ctx' label with a visual 42% progress bar + '84k / 200k' + 'session 1.2M · $4.10' + gear only. Real renders ctx as plain text '· 84k/200k (42%)', usage without the session-tokens figure, and adds ⟳ role cycle, think/approve pickers, '⚡ fast' chip, ⟲ history, status dot + idle/working label. Add the .chat-ctx-bar progress bar and 'session <tokens> · $<cost>' format per AgentChat.tsx lines 143-148; move role/think/approve/fast controls behind the gear settings menu.

## 17. [medium] shell-agent: transcript styling — tool cards, who-labels, subagent card
**Surfaces:** shell-agent
**Files:** src/blocks/render/transcript.web.tsx, agent-surfaces-app/src/app/AgentChat.tsx

Three transcript renderer fixes in transcript.web.tsx: (shell-agent-06, lines 66-108) tool name goes mono + var(--gs-accent) ('bash','edit','todo'), status becomes a bordered uppercase chip (green DONE / amber RUNNING per STATUS_TONE in AgentChat.tsx), right-aligned meta ('1 match · 40ms', '+1 -1', '2/3'), and drop the visible INPUT/OUTPUT section headers (render blocks directly). (shell-agent-07, lines 22-37) Replace the own-line uppercase 10px YOU/AGENT labels + border-l indent with inline lowercase labels (green 'you' / accent 'agent') on the same line, and add attachment chips ('▯ DEVICE.MP4') on user messages. (shell-agent-08, lines 118-140) Subagent card gets violet left accent border (mock .ci-sub), green pulsing wdot for running, dim 'sonnet-4.6' + '→ phase 1 · collect evidence (pipeline)' lines, and an amber uppercase RUNNING chip instead of lowercase plain text.

## 18. [medium] shell-agent: composer — violet workflow chip + queued-message status row
**Surfaces:** shell-agent
**Files:** src/components/NativeComposer.web.tsx, agent-surfaces-app/src/app/AgentChat.tsx

(shell-agent-09) NativeComposer (~line 806) has attach / commands / @mention chips but is missing the fourth violet 'workflow' chip; and the row below the textarea is a keyboard-hint line ('Enter steers current turn · …') instead of the mock's queue row '● 1 message queued — sends when review-gate returns' with green Send at right. Add the workflow chip and render queued follow-up state as '● N message(s) queued — sends when <subagent> returns' per AgentChat.tsx Composer (line 114).

## 19. [low] shell-agent: sidebar cleanup — header ×, inline mode chip, hide closed-sessions row
**Surfaces:** shell-agent
**Files:** src/app.web.tsx, agent-surfaces-app/src/app/Sidebar.tsx

(shell-agent-11) Sidebar header should be 'haptics-plugin' (mono) + green 'CODE ▾' only — remove the '×' close button after the CODE dropdown (back nav belongs to global chrome) and inline the 'Repo editable ✎' chip on the 'CODE MODE' section header row instead of stacking all three mode chips beneath it, per agent-surfaces-app/src/app/Sidebar.tsx. (shell-agent-12) Agent section shows an extra 'Closed session… show' disclosure above 'New thread' with no mock counterpart — hide it by default behind a kebab/settings affordance so the idle section is just the live thread row ('▶ agent · main live' with green active-row left bar) + 'New thread'.

## 20. [low] shell-agent: right-rail FILES tree — nested hierarchy with git-status letters
**Surfaces:** shell-agent
**Files:** src/components/ArtifactPanel.web.tsx, agent-surfaces-app/src/app/RightRail.tsx

(shell-agent-13) Real FILES tree renders collapsed top-level rows with slash-joined compressed paths ('.agents / skills') and no status letters or file glyphs; mock renders a true nested hierarchy ('src' ▾ → 'app.json M', 'components' ▾ → 'Profile.tsx U') with per-file amber M/U letters and file glyphs. In the Pierre trees usage (ArtifactPanel.web.tsx / repo panel): default-expand dirs containing changes and show per-file status letters, matching RightRail.tsx FILES.

## 21. [high] Goal doc: header chrome — subtitle, exemplar count, Preview/Edit buttons; drop phase chip & counts
**Surfaces:** goal
**Files:** src/components/GoalDocPanel.web.tsx, agent-surfaces-app/src/app/GoalDoc.tsx

(goal-02) Header should be 'Goal · {title}' + muted sans subtitle 'composed from a small block vocabulary · ★ N exemplar' + right-aligned Preview and Edit buttons (GoalDoc.tsx:14-21). Real adds an extra CODE phase chip, '1/2 ready' count, and workspaceName ghost text, with subtitle/exemplar/buttons all missing. In GoalDocPanel.web.tsx lines 111-128: drop the phase chip, ready-count span, and workspaceName span; add the 11px muted subtitle (+' · ★ N exemplar' when >0) and ml-auto Preview/Edit buttons styled like mock .btn.sm (border gs-border, 11px, px-2 py-0.5).

## 22. [medium] Goal doc: wf-tie card moves in-flow at end of scroll body
**Surfaces:** goal
**Files:** src/components/GoalDocPanel.web.tsx

(goal-04) Mock wf-tie is an in-flow card at the END of the scrollable doc body: max-width 880px, 1px gs-border + 2px accent left border, bg-elevated, mt 6px, subtitle '4 phases · implement → evidence → review-gate → adjudicate' (GoalDoc.tsx:42-49). Real pins it as a full-width flex-none footer outside the scroll area with border-t and appends '· ★ 2 exemplar' (belongs in the header). Move the button inside the scroll div (line 175) after the blocks list, class max-w-[880px] mt-1.5 border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-accent)], restore the '4 phases · ' prefix, and relocate the exemplar count to the header subtitle (item 21).

## 23. [medium] Goal doc: markdown .md-doc prominence — ruled h2s, accent inline code, accent markers
**Surfaces:** goal
**Files:** src/blocks/render/markdown.web.tsx

(goal-07) Mock goal-doc markdown uses the prominent .md-doc variant: h2 14px weight-600 with bottom rule (pb 6px, border-b gs-border, margin 20px 0 8px — the 'Objective'/'Non-goals' look); p 13px text-muted line-height 1.7; inline code accent-green on black; li::marker accent (styles.css:1002-1013). Real BLOCK_MD_OPTIONS is h2 13px no rule mt-3, p lh 1.6 secondary, no accent code. Add a doc-prominent option set (or restyle BLOCK_MD_OPTIONS when hosted in the goal doc): h2ClassName 'text-[14px] font-semibold text-[var(--gs-text)] mt-5 mb-2 pb-1.5 border-b border-[var(--gs-border)]', paragraphClassName lh-[1.7] text-muted, inlineCodeClassName + text-[var(--gs-accent)], accent list markers.

## 24. [medium] Goal doc: chain nav labels '‹ up' / 'down ›'
**Surfaces:** goal
**Files:** src/components/GoalDocPanel.web.tsx

(goal-03) Chain prev/next buttons are bare '‹' and '›' glyphs; mock labels them '‹ up' and 'down ›' (GoalDoc.tsx:24,32). Change button text at GoalDocPanel.web.tsx line 138 to '‹ up' and line 170 to 'down ›'.

## 25. [low] Goal doc: low polish — block spacing, exemplar star treatment, callout style
**Surfaces:** goal
**Files:** src/components/GoalDocPanel.web.tsx, src/blocks/render/content.web.tsx

(goal-05) GoalDocPanel.web.tsx line 177: gap-3 → gap-4 (mock .docblock mb 16px); line 175: py-4 → pt-[18px] pb-[18px] (mock .gdoc-body 18px/20px). (goal-06) Line 185: ★ goes flush at block corner right-0 top-0 text-[13px] (real is inset right-1 top-1 12px); line 179: exemplar state → shadow-[inset_2px_0_0_var(--gs-warning)] pl-[11px] instead of border-l-2 pl-2. (goal-08) content.web.tsx callout renderer (lines 25-30): add outer border border-[var(--gs-border)], bg-[var(--gs-bg)], and title → text-[10px] uppercase tracking-[0.1em] text-[var(--gs-text-dim)] mb-1 (the 'GAMEABILITY CONTRACT' kicker look) instead of left-border-only bg-elevated with 11px semibold tone title.

## 26. [low] Goal doc: restyle non-mock fallback states to block vocabulary
**Surfaces:** goal
**Files:** src/components/GoalDocPanel.web.tsx

(goal-09) Mock always renders the block list; real has extra fallback branches (raw-markdown body, RequirementRow list under a 'Requirements · rubric' kicker, and an empty-state string, lines 194-214) that produce off-design UI whenever a goal lacks blocks. Keep them as data fallbacks but restyle to mock vocabulary — render requirements via the checklist/evidence-shape block styles, sans font per the global font item.

## 27. [high] Workflow pane: always-visible artifacts row with '+ create artifact' button + menu
**Surfaces:** workflow
**Files:** src/blocks/render/workflow.web.tsx, agent-surfaces-app/src/blocks/index.tsx

(workflow-03) Mock: every phase's 'artifacts' row ALWAYS renders and ends with a dashed '+ create artifact' button opening a 4-item menu (goal-doc line-range / phased goal-doc / reviewer rubric / arbitrary artifact) — blocks/index.tsx:404-407, styles.css .wfx-add/.wfx-add-menu. Real (workflow.web.tsx:125) only renders the row when p.created is non-empty and has no create affordance at all. Always render the row; add the dashed button (border-dashed border-[var(--gs-border-active)] text-[10px]) with the dropdown; gate mutation behind host.readOnly if needed but keep the affordance visible.

## 28. [medium] Workflow pane: PaneBox header — 'Workflow' title, sub, Save button; dedupe recipe; kill native select
**Surfaces:** workflow
**Files:** src/components/WorkflowPanel.web.tsx, src/blocks/render/workflow.web.tsx

(workflow-04) Restyle WorkflowPanel header (lines 60-74) to mock panel-head: h-8, bg #070707, uppercase 11px tracking-[0.1em] title 'Workflow', sub 'phased dataflow · gated loops · gates · artifacts per phase' 11px muted, right-aligned 'Save workflow' .btn.sm; body padding p-[13px]; drop the ⟜ accent icon. (workflow-05) recipe + recipePath appear both in the panel header (lines 62,73) AND the block head (workflow.web.tsx:169-170) — remove from the panel header, keep only in the block head. (workflow-11) The native <select> spec dropdown in the header (lines 64-72) has no mock counterpart — if multi-spec switching must stay, restyle as mock-style chips/tabs in the pane-body wf-head, not a native select.

## 29. [medium] Workflow pane: artifact chip click routing by type; remove extra node icons
**Surfaces:** workflow
**Files:** src/blocks/render/workflow.web.tsx, src/components/WorkflowPanel.web.tsx

(workflow-06) Created-artifact chip click always dispatches artifact:${a.name} (workflow.web.tsx:132); mock routes by type — rubric → rubric pane, goal-slice/phased-goal → goal pane, else artifact:name (blocks/index.tsx:392-394). Compute the target like the mock and route 'rubric'/'goal' targets in WorkflowPanel host.dispatch (lines 47-51) to openSingletonPane kinds. (workflow-07) Remove the extra ✦/◆ icon prefix injected before every node role at workflow.web.tsx:56 — mock WfNodeCard header is dot + role text only ('implementation agent', 'gate · human').

## 30. [low] Workflow pane: low polish — rollup chips, created-output check, cart metrics, wrapper spacing
**Surfaces:** workflow
**Files:** src/blocks/render/workflow.web.tsx, src/components/WorkflowPanel.web.tsx

(workflow-08) Rollup chips ('3 phases','9 agents','142k tok','$0.84') at workflow.web.tsx:177 → match .chip.dim: text-[10.5px] uppercase tracking-[0.05em] px-[7px] py-[2px] bg-[var(--gs-chip-dim-bg)] text-[var(--gs-chip-dim-text)]. (workflow-09) Remove the extra green ✓ suffix on status==='created' at line 156 — mock marks created outputs only by the io-toned 2px left border. (workflow-10) Cart rows/chips (lines 126-139): row gap-[7px] px-[11px] py-2; chip gap-[7px] px-2 py-[3px]; scope hover to the 1px borders so the 2px purple left rail stays constant. (workflow-12) Drop my-2 on the block root (line 165); WorkflowPanel lines 75,89: use p-[13px] and remove the max-w-[920px] wrapper (mock is full-width).

## 31. [high] Change Guide: foot bar — Review rubric button, primary green Approve, drop human-gate chip
**Surfaces:** review
**Files:** src/components/ChangeGuide.web.tsx, agent-surfaces-app/src/app/stages/ReviewStage.tsx

Mock foot has exactly two buttons: '☰ Review rubric' (bordered sans .btn) + solid bright-green primary 'Approve · 0/4' (ReviewStage.tsx:55-58). (review-foot-missing-rubric-btn) Add a '☰ Review rubric' button before Approve in the foot (lines 321-339), opening the Review rubric pane via a new onOpenRubric prop analogous to mock open('rubric'). (review-approve-style) Approve (lines 327-338) is currently a disabled gray outline that wraps to two lines — style as solid green primary (bg-[var(--gs-accent)] text-[var(--gs-text-on-accent)]) regardless of gating (keep disabled semantics via cursor/opacity) and add whitespace-nowrap. (review-foot-extra-humangate-chip) Remove the extra '◆ 1 human gate pending' purple rounded-full chip (lines 322-326) — fold the count into the Approve label or the rubric pane; if kept, at minimum drop rounded-full (mock has zero rounded chips here).

## 32. [medium] Change Guide: timeline dots filled with glow; head loses 'diff vs develop' subtitle
**Surfaces:** review
**Files:** src/components/ChangeGuide.web.tsx, agent-surfaces-app/src/app/RightRail.tsx

(review-active-dot-not-filled) Dots at lines 285-293 lock bg to #050505 for all states; mock fills the active dot bright green with glow (.rg-step.on .rg-dot: background accent + box-shadow 0 0 10px) and done dots green success-filled — add bg-[var(--gs-accent)] + glow for active, bg-[var(--gs-success)] for done, and idle border var(--gs-border-active) not var(--gs-text-dim). (review-head-extra-subtitle) Remove the second mono line 'diff vs develop' from the pane head (lines 266-268); surface baseBranch via the right-rail .diffbase selector per mock (RightRail.tsx:36-38, styles.css:1376).

## 33. [medium] Change Guide: section header single-row; file header inline '(new)' suffix; verify diff theme
**Surfaces:** review
**Files:** src/components/ChangeGuide.web.tsx

(review-sec-header-extra-what) Delete the <p>{s.what}</p> from the section header (line 375) — mock header is one row (numbered circle · title · KIND · Mark complete, ReviewStage.tsx:64-69) with the narrative living only in the left explain panel. (review-file-header-badge) File header (lines 128-137): render change type as an inline lowercase dim ' (new)'-style suffix after the path instead of the right-aligned uppercase 9px 'ADDED' badge; use bg-[var(--gs-bg-elevated)] and border-[var(--gs-border)] instead of hardcoded #060606 / --gs-border-muted. (review-diff-renderer-theme) After the diff-loading backend fix (item 3), verify PatchDiff pierre-dark (line 146) against mock .code tones — plain black unified block, dim gutter numbers, green add lines, 11.5px mono; override CSS vars (bg #000, add-line green, gutter dim) or hide hunk chrome to match.

## 34. [low] Change Guide: comment thread block for reviewer fail-comments
**Surfaces:** review
**Files:** src/components/ChangeGuide.web.tsx, agent-surfaces-app/src/app/stages/ReviewStage.tsx

(review-missing-comment-thread) No thread rendering exists in the real section body; mock sections can end with a comment thread block: '◆ who' + body + fail actions ('✦ Send to agent → fix' / Comment / Dismiss) per ReviewStage.tsx:79-87, styles.css .thread. Add the thread block structure to the section body (lines 377-388), rendered when a step carries reviewer comments.

## 35. [low] Change Guide: low polish — 300px left column, timeline scroll behavior, border/tracking tones
**Surfaces:** review
**Files:** src/components/ChangeGuide.web.tsx

(review-left-col-width) Line 263: w-[280px] → w-[300px] (mock grid-template-columns:300px 1fr). (review-timeline-capped-scroll) Line 271: timeline capped at maxHeight:42% with its own scrollbar cuts steps behind an inner scroll — prefer letting it size to content up to a max-h cap and confirm no double-scrollbar; explain stays the flex-1 region. (review-minor-tones) Line 369 Mark-complete idle border → var(--gs-border-active); line 352 section-header bottom border → var(--gs-border); line 362 kind tracking-[0.1em] → tracking-[0.06em].

## 36. [high] Review rubric: restructure — active-criterion detail + judgement form into LEFT rail, lean right sections
**Surfaces:** rubric
**Files:** src/components/ReviewRubric.web.tsx, agent-surfaces-app/src/app/ReviewRubric.tsx

Two sides of one restructure. (rubric-01) Real left rail is header + full-height index + footer with a huge empty gap; mock caps the index (~34% max-h, border-b) and adds an 'rr-active' block for the scroll-spied criterion: verdict/required/gate badges, 14px title, rubric contract text, ScoreBar + 'N judges · N evidence', then MakeJudgement form (human gate) or 'gate-judged — no human verdict required' dashed note (mock lines 152-186). Add this region (flex-1 overflow-auto p-3.5) after the index at lines 330-359. (rubric-03) Real right-column sections are bloated with the REQUIRED chip + gate chip (372-375), rubric md block (384-388), score/meta/'run judgment' row (389-404), and the human-gate block (434-447) — remove all of these from sections (they move left); mock sections are only verdict chip + title + optional 'awaiting your verdict' chip, then 'evidence · N' + cards + 'judgements · N judges' + rows (mock 190-206). Drop the 'run judgment' button entirely (not in mock) or park it in the left rail pending design approval.

## 37. [high] Review rubric: evidence items become cards with artifact previews
**Surfaces:** rubric
**Files:** src/components/ReviewRubric.web.tsx, agent-surfaces-app/src/app/ReviewRubric.tsx

(rubric-04) Real evidence is a single-line button (kind chip + name + captured chip + ↗) with no artifact ref id and no preview. Mock .rc-ev is a card: header row = kind chip, mono name, '— meta', right-aligned mono artifact ref id (e.g. art-import-scan), captured/asserted chip; body renders the artifact preview (command output in a black bordered pre '$ rg -n …', screenshot thumb, etc.). Restructure EvidenceRow (109-136): head div (bg #060606-equivalent, border-b border-muted) with chip/name/meta/mono dim ev.id/source chip + body div (px-[11px] py-[9px]) rendering the preview (stdout pre for command evidence, img for image mime), per mock Evidence (43-56) + ArtifactPreview.

## 38. [medium] Review rubric: medium fixes — score slider, awaiting chip case, footer callout, index rows, footer text
**Surfaces:** rubric
**Files:** src/components/ReviewRubric.web.tsx

(rubric-05) MakeJudgement (207-245): add right-aligned 'SCORE' range slider (purple accent, ~110px, 0-100) + mono value to the pick row (line 212); thread score through onRecordHuman. (rubric-06) 'awaiting your verdict' chip (377-379): lowercase ~12px purple with rgba(188,140,255,.3) border px-1.5 py-px — remove uppercase tracking-wide text-[10px]. (rubric-07) After the sections map (line 450): add the mock's right-column footer callout — border + border-l-2 border-l-[var(--gs-info)], mt-4, uppercase 10px title 'top-level + per-phase', 12.5px body with <b>mini rubric</b> and <code>type-review rubric</code>. (rubric-08) Index rows (336-354): drop the gate-icon span (347-349) and the 'N ev' fallback (351); score span only when typeof c.score==='number'; items-start with dot mt-1, remove truncate so titles wrap 2 lines. (rubric-09) Footer (356-358): remove the '· 1/2 pass' segment (and passCount calc at 278) — mock is 'N criteria · gated exit owned by human approval' on one line.

## 39. [low] Review rubric: low polish — rail width/bg, empty states, timestamp format, form chrome, chip/bar details
**Surfaces:** rubric
**Files:** src/components/ReviewRubric.web.tsx

(rubric-10) Line 329: grid-cols-[380px_1fr]; line 331: bg-[#050505] and border-r-[var(--gs-border)] (real uses minmax(240px,340px), canvas bg, muted border). (rubric-11) Line 412: 'no evidence collected yet' → plain italic dim 11.5px text, not a dashed box; lines 427-428: drop the 'no judgements recorded yet' box entirely (mock renders nothing). (rubric-12) Line 161: format review.createdAt to compact HH:MM locale time instead of raw ISO dump. (rubric-13) Line 208: MakeJudgement chrome → bg rgba(188,140,255,0.04) with only a 1px top border rgba(188,140,255,0.18), no full border / 2px purple top; line 229: restore 'on the right' in the placeholder ('Why — cite what the evidence on the right does or doesn't prove…'). (rubric-14) VerdictChip (92-98): add border border-[var(--gs-border)] px-[7px] py-[2px] text-[10.5px] font-normal; ScoreBar (84) and line 155: remove rounding (square corners); line 145: drop bg-[var(--gs-bg-elevated)] on the judge icon box.

## 40. [high] Crons & triggers: implement the pane — currently a hardcoded stub
**Surfaces:** crons
**Files:** src/app.web.tsx, agent-surfaces-app/src/app/CronsTriggers.tsx, agent-surfaces-app/src/styles.css

(crons-01) The entire pane body in app.web.tsx (~2923-2945) is a hardcoded 'No triggers yet.' stub — no trigger card UI exists. Port CronsTriggers.tsx into a CronsTriggersPanel component backed by the trigger registry, copying .trig* styles (styles.css:941-979). The port must include: (crons-02/12) .trig-bar header — uppercase sans kicker 'CRONS & TRIGGERS' (10px, .12em tracking, --gs-text-dim), bg #050505, padding 11px 16px, border-b var(--gs-border); drop the ◷ glyph + mono subtitle. (crons-03) stage-driven mode chip: dim 'design mode · runs once shipped' pre-ship or green '● live · armed in ship' (CronsTriggers.tsx:89) — no hardcoded 'ship stage' text. (crons-04) right-aligned '＋ New trigger' .btn.sm. (crons-05) TriggerCard header row (CronsTriggers.tsx:21-30): mono name 12.5px · CRON/EVENT/MANUAL kind chip (blue/violet/dim) · mono dim when-text ('every 6h','Mon 09:00','on new share') · bordered WORKSPACE/PROJECT scope badge · status chip (ARMED dim in design mode; ok/pending/failed live) · '⟳ Run now' + 'Edit' xs buttons. (crons-06) sans description line + RUNS/READS/WRITES flow line with mono values (:32-40). (crons-07) capability strip footer per card: CAPABILITY label + green 'DATA-ONLY · NO SIDE-EFFECTS' or amber 'CAN SEND-EMAIL · APPROVAL' chips, 'feeds ▸ Growth & revenue' dim text, right mono meta + 5-dot Spark run-history (:10-12, 42-51). (crons-08) 2px amber left border for side-effect triggers (.trig.sidefx, styles.css:948). (crons-09) inline expanding editor: 'runs' line, collapsible skill accordion, per-trigger prompt textarea (mono, min-height 120px), capability scope with may-write chips + side-effect checkboxes + 'approval before live' (:53-78, styles.css:963-979).

## 41. [medium] Crons & triggers: empty state renders inside chrome, sans + readable
**Surfaces:** crons
**Files:** src/app.web.tsx

(crons-10) Real empty copy is centered in the whole pane, mono, --gs-text-ghost — nearly invisible against #000 — and replaces all chrome below the header. If a zero-trigger empty state is kept, render it inside .trig-list under the full .trig-bar chrome (list padding 14px/16px), sans (--gs-ui) body at --gs-text-dim, not mono ghost (app.web.tsx ~2936-2942).

## 42. [high] Events: rebuild as '⚑ Event logs' dock pane with a flat chronological log list
**Surfaces:** events
**Files:** src/app.web.tsx, src/components/Events.web.tsx, agent-surfaces-app/src/app/Shell.tsx

Structural rebuild covering six issues. (events-01) app.web.tsx ~2540 early-returns a full-screen EventsWeb takeover, losing sidebar/tabstrip/right rail/status bar — instead open events via openSingletonPane (like goal/rubric/workflow at ~3087) as a dock pane titled '⚑ Event logs' with close via tab ✕. (events-09) Register it so it appears in the tabstrip and sidebar SURFACES active-state wiring works. (events-02) Replace the two-column wide-events observability browser with the mock's single flat .evpane list — one row per event, time + text (Shell.tsx:55-59, styles.css .evpane/.evrow 305-309). (events-03) Delete the pane-local Header component ('← Back', 'Events', 'Workspace: multi-pane', J/K hints, ~line 350). (events-04) Remove the SAVED FILTERS / SEARCH / Events-Live-Errors-Warnings stats block (~137-200). (events-05) Remove the ALL EVENTS TIMELINE chart + inspector column (~235-340). Filter/inspector features move out of or behind the pane, not the default surface.

## 43. [medium] Events: row structure, tone borders, pane padding, empty-state copy
**Surfaces:** events
**Files:** src/components/Events.web.tsx

(events-06) Rows become baseline-aligned single lines: 10.5px dim mono tabular time (fixed 34px) + 12px muted text, 2px tone-colored left border, padding 6px 14px, gap 10px — drop the multi-line card layout ('LEVEL · time · process' meta, bold 'Wide event · id' title, bottom borders, 4px blue selected border). (events-07) Encode tone as left-border color per mock palette (green=--gs-success, blue=--gs-info, amber=--gs-warning, dim=--gs-border-active); remove colored uppercase level text and the info→success mismap in LEVEL_COLORS (:9-13); text stays --gs-text-muted. (events-10) Single scroll container, padding 10px 0, no internal border-b/border-r quadrant dividers. (events-11) One centered empty state ('No events yet', --gs-text-muted, sans) replacing 'No wide events' / 'No timeline data' / 'Select a wide event to inspect'; drop 'wide event' wording from the surface.

## 44. [high] Dashboard: '＋ Add panel' button with mini-app palette dropdown
**Surfaces:** dashboard
**Files:** src/components/DashboardPanel.web.tsx, agent-surfaces-app/src/app/DashboardCanvas.tsx

(dash-02) No add button or palette exists — panels can only be removed. Mock canvas head has a right-aligned add button opening a .palette dropdown of mini-apps (title + scope chip + blurb per item, DashboardCanvas.tsx:29-41). Add a right-aligned '＋ Add panel' button in the header row (line 137) with a dropdown listing available *.gssh.html app artifacts, appending to doc.panels via mutate().

## 45. [high] Dashboard: mini-app frame chrome — bar contents, bordered buttons, surface tones
**Surfaces:** dashboard
**Files:** src/components/DashboardPanel.web.tsx, agent-surfaces-app/src/app/mini-apps.tsx

(dash-03) MiniAppFrame bar (lines 51-60) has only a '▦' glyph + title + two buttons; mock miniapp-bar has 7px round purple ma-dot, 12px title, uppercase bordered scope chip (workspace=blue/chain=violet), mono 10px '✦ artifact.app' path, LastRunChip or '⟳ source · updated' freshness, optional amber 'stale' chip (mini-apps.tsx MiniAppFrame, styles.css 802-812) — replace ▦ with the dot and add scope chip, mono ghost path, and freshness chip slot before the buttons. (dash-04) Lines 56-59: two borderless text buttons with wrong glyphs ◫/⃞ → three 22x22 bordered .ma-btn buttons: ✎ (agentation feedback), ⊞/⊟ (resize), ✕ (remove), border 1px var(--gs-border), hover border-active. (dash-06) Lines 52-53: frame bg var(--gs-bg-surface) (not bg-elevated) with bar bg #070707 darker than body.

## 46. [medium] Dashboard: canvas head kicker style + grid padding; resizable panel bodies
**Surfaces:** dashboard
**Files:** src/components/DashboardPanel.web.tsx

(dash-05) Header (137-140): render scopeLabel as an uppercase sans letter-spaced kicker + dim 11px 'composable gitspace-mini-apps · *.gssh.html', padding 10px 16px, bg #050505, border-b var(--gs-border); drop the accent ▦ glyph and mono dashboardPath-as-title. (dash-09) Grid scroll container (147/155): padding 14px 16px (currently uniform p-3). (dash-07) Lines 61-70: iframe hard-coded to 260px (220px missing-app) — wrap in a body div with resize:vertical, overflow:auto, flex:1 and let the iframe fill (height 100%) per mock miniapp-body (styles.css 813).

## 47. [medium] Dashboard: empty-state copy/placement; auto-persist vs Save; missing-app tone
**Surfaces:** dashboard
**Files:** src/components/DashboardPanel.web.tsx

(dash-08) Line 153: empty copy → 'No dashboards yet — create one, or roll up a shipped workspace's dashboards.' left-aligned inside the grid, 12.5px dim, padding 28px 4px — not fully centered in the pane. (dash-10) Lines 141-145: mock has no Save affordance (edits apply immediately) — auto-persist on mutate (debounced write) instead of the dirty-state green Save button, or style it to disappear. (dash-11) Line 62: unknown mini-app renders dim 'unknown mini-app' padded 16px inside the frame (DashboardCanvas.tsx:46) — replace the danger-red centered 'app artifact missing: {path}' 220px block.

## 48. [high] Note pane: header chrome — segmented Write|Preview, mock header bar, typography, drop extra buttons
**Surfaces:** note
**Files:** src/components/NotePanel.web.tsx

Six header issues in one pass. (note-03) Lines 76-78: Write|Preview must be a joined segmented control — wrap both buttons in an inline-flex span with border border-[var(--gs-border)], remove rounded and gap, buttons text-[11px] px-2.5 py-[3px], active bg-[var(--gs-bg-active)]. (note-04) Line 72: header → bg-[#050505] border-b border-[var(--gs-border)] px-3.5 py-2.5 gap-2.5 (mock .noteview-h 10px 14px). (note-05) Line 73: delete the extra '✎' glyph before the title. (note-06) Line 74: title text-[13px] font-medium, sans header (--gs-ui) per mock .noteview-t. (note-07) Line 75: subtitle 'agent-readable · markdown' → dim tone (var(--gs-text-dim)) ~12-13px sans instead of 10px ghost. (note-08) Lines 79-88: header right side contains ONLY the toggle — remove Delete (+Confirm delete) and conditional Save from the header (autosave on change/blur or move to overflow).

## 49. [low] Note pane: body styling, title source, minimal transient states
**Surfaces:** note
**Files:** src/components/NotePanel.web.tsx

(note-09) Line 100: Write textarea → bg-black, px-4 py-3.5, text-[12.5px] mono, line-height 1.6 (mock .noteview-ta). (note-10) Line 103: Preview → py-3.5 px-[18px], drop the max-w-[860px] constraint (mock .noteview-prev is full width). (note-11) Line 68: title should come from WorkspaceNote.title ('Main-thread blocking'), not first-line-of-body truncated to 60 chars — fall back to derivation only for unsaved new notes. (note-12) Lines 92-95: keep loading/error states but style minimally (dim sans text, top-left, no full-pane center, no red mono) so transient chrome doesn't diverge; primarily the item-3 backend fix should ensure 'Note not found' never shows for valid ids.

## 50. [high] Project home: center tabstrip shell — tabs for overview/dashboards/artifacts instead of '← back' overlay
**Surfaces:** projecthome
**Files:** src/pages/ProjectHomePage.web.tsx, agent-surfaces-app/src/app/ProjectHome.tsx

(ph-no-tabstrip) Real center has no tabstrip; sections toggle via sidebar and any viewer replaces content behind a '← back' link. Mock center is a multi-tab shell: 34px .tabstrip with 'Overview' tab (active tab inset 0 -2px accent underline, bg --gs-bg) plus closable tabs for reports/process/chains/dashboards/notes. Add the tabstrip above the center body (mock ProjectHome.tsx:202-209, styles.css .tabstrip/.tab). (ph-viewer-back-pattern) Fold the viewerPath overlay (lines 303-319) into this model — dashboards/artifacts open as tabs (tab-ic ▦, ✕ close), overview stays available; remove the '← back' overlay.

## 51. [high] Project home: overview sections become .ph-card containers with header bars
**Surfaces:** projecthome
**Files:** src/pages/ProjectHomePage.web.tsx

(ph-overview-not-cards) Real sections are bare 10px uppercase label + content; mock overview is 3 .ph-card containers (1px border, bg --gs-bg-surface) each with a .ph-card-h header bar (bg #070707, uppercase 11px title, dim subtitle 'grouped · tag into epics' / 'reflect → plan', right-aligned xs button '＋ New' / 'open ↗' / 'open feed ↗'). Wrap each section (lines 332-415) in a bordered card with header row (border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]; header px-3 py-2 border-b with title + dim sub + ml-auto xs button wired to setSection).

## 52. [high] Project home: 'Recently shipped' right-rail section with roll-up flow
**Surfaces:** projecthome
**Files:** src/pages/ProjectHomePage.web.tsx, agent-surfaces-app/src/app/ProjectHome.tsx

(ph-rail-no-recently-shipped) Section entirely missing from the real rail. Mock rail bottom has 'Recently shipped' (rsection.changes, max-height 46%, header '▾ Recently shipped  deletion check → roll up') with queue rows: mono workspace name, dim meta (chain · shipped · dashboard), 'Check & roll up' button, star-rating flow, 'rolled up' green chip. Add it below the artifact list in the right rail (lines 421-454), listing shipped/ship-phase workspaces with the roll-up action (mock ProjectHome.tsx:237-270).

## 53. [high] Project home: chains as grouped slim rows with status-dot strips
**Surfaces:** projecthome
**Files:** src/pages/ProjectHomePage.web.tsx

(ph-chains-structure) Real renders each chain as a boxed card with '⛓ title', inline 'N goals', and a wrap of pill buttons showing full goal titles. Mock groups chains under uppercase group headings (Editor pipeline / Growth, .ph-chgroup-h); each chain is one slim clickable row: sans 12.5px title + row of 8px status dots (cs-dot per goal, title attr = goal · status) + right-aligned dim 'N goals' — no goal names inline. Replace the pill list at lines 339-360; drop the ⛓ icon and per-goal pills; group under headings when chain metadata provides one.

## 54. [medium] Project home: sidebar overhaul — groups, item icons/accent bar, header block
**Surfaces:** projecthome
**Files:** src/pages/ProjectHomePage.web.tsx, agent-surfaces-app/src/app/ProjectHome.tsx

(ph-sidebar-missing-groups) Real has only PROJECT (Overview, In process, Chains, Reports & notes, Artifacts) + DASHBOARDS; mock has AGENT (✦ Project agent 'live', ＋ New thread), PROJECT (Overview, In process, Reports, Chains, Crons & triggers), DASHBOARDS (+ ＋ New dashboard), CONFIG (⚙ Bundle config). Add Agent/Config group stubs + 'New dashboard' row (lines 279-299), reorder to In process → Reports & notes → Chains, and move 'Artifacts' out of PROJECT (mock exposes artifacts only via the right rail). (ph-sidebar-item-style) navItem (222-234) + sidebar div (279): add leading 14px icon column per item (◎ ◷ ⚑ ⛓ ▦ ⚙, accent-tinted when active), active row shadow-[inset_2px_0_0_var(--gs-accent)] + bg-active, remove rounded, w-[220px], bg-[#050505], border-r var(--gs-border). (ph-sidebar-header-block) Lines 270-275: drop the full-width top header ('← Board gitspace.sh project home · 2 chains · 2 workspaces'); put mono projectName 13px + bordered '⊞ All projects' (onBack) button at the top of the sidebar under a border-bottom per mock ProjectHome.tsx:169-172.

## 55. [medium] Project home: in-process rows and feed rows restructured
**Surfaces:** projecthome
**Files:** src/pages/ProjectHomePage.web.tsx

(ph-inprocess-row-style) Lines 373-386: real rows are bordered elevated boxes with a static dot and the phase chip pushed far right; mock rows are borderless hover rows inside the card — pulsing 7px accent dot when agent busy (animate-pulse when agentSessionCount>0), mono name 12px, uppercase stage chip immediately after the name, right-aligned dim meta 'agent running' / '4/6 gates'. (ph-feed-row-structure) Lines 399-411: real feed rows are single-line bordered buttons with a generic REPORT/NOTE pill; mock rows have a colored uppercase kind chip (good pattern=green, praise=blue, frustration/workflow quirk=amber, gitspace quirk=violet), mono surface line, note body paragraph beneath, and a '＋ Plan from this' xs action button — restructure to chip + two-line body + actions row with the 'Plan from this' stub, mapping note kinds to tone chips (mock ReportRow, ProjectHome.tsx:44-63).

## 56. [low] Project home: rail polish — cron last-run chip + --gs-font-mono var check
**Surfaces:** projecthome
**Files:** src/pages/ProjectHomePage.web.tsx

(ph-rail-cron-chip) railRow (lines 236-262): add a compact last-run cron chip ('⟳ 2h ago', LastRunChip) between name and star for data/dashboard artifacts when trigger info exists on the backend. (ph-rail-artifact-name-font) Line 56: the combo's collapsed value classes reference --gs-font-mono but the screenshot shows sans-ish rendering — verify --gs-font-mono is defined in this page's stylesheet scope (compare mock styles.css --gs-font); a missing CSS var makes font-[family-name:...] silently fall back. Fix the var name if it differs.

---

## Loop status (2026-07-05, after round 2)

All 56 items implemented. Re-audit round verdicts: rubric close-match; board /
review / crons / events / dashboard / projecthome minor-gaps (all named gaps
fixed in the follow-up commit); shell-agent / goal / workflow / note "broken"
verdicts were capture artifacts (wrong active tab / no seeded session), fixed
by the seed-order + capture changes.

Known remaining (blocked on data/backends, not rendering):
- Chains grouped under epic kickers — needs an epic field on the chain model.
- Trigger registry backend (item 25) — CronsPanel is prop-ready.
- WorkspaceNote.title field — panel uses derived titles until then.
- PH in-process gate-tally fallback — export getGateTally and wire.
- Mini-app freshness chips — need panels to carry source/updated.
