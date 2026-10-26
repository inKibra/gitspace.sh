# Batch 18 mock vs shipped: gap list (views 1, 2, 4)

Mock sources: `packages/account-web/src/BrowsersMock.tsx` (M), `src/BrowsersMockShare.tsx` (MS). All shipped paths below are relative to `packages/account-web/src` unless they name another package. Design doc: `docs/APERTURE-DESIGN.md` (D).
Legend: **MATCH** · **DIFFERENT** (how) · **MISSING** · **EXTRA** (shipped, not in mock) · **[BACKEND]** needs server/extension/protocol data or operations that don't exist yet.

**Phase 2 built (2026-10-25, extension 5.8.0):** the [BACKEND] rows for each Chrome's version, OS, last seen, paired date, agents using it now and one note (27, 28, 31, 59, 60), the cloud browser's open-tab count (46), the short pairing code, the group colour, activity, Stop, Close tab and Focus in Chrome (130, 131, 132, 148, 159), Recent runs with refusals (194, 195), the approved sites' bundle commit (106), and the share preview's Chrome name, favicon, live dot and the sharer's pointer (207, 233, 235, 282). Still open: site levels read / interact / full (105, needs a decision), previews of tabs you added (144, kept private), another account's user joining as themselves (249, deferred 2026-10-25), and the later phases (take over, comments, captures).

---

## View 1 · Plugins → Browsers (M:48-148 vs BrowserPlugins.tsx, PluginsPage.tsx)

### Page chrome / toolbar
| Mock element | Status | Shipped |
|---|---|---|
| PageHeader kicker "Account configuration", title "Plugins", same description (M:52) | MATCH | PluginsPage.tsx:233 |
| TabsSubtle "Composio plugins · 3 / Custom plugins · 1 / Browsers · 2" (M:54-58) | MATCH (live counts; Browsers counts confirmed pairings) | PluginsPage.tsx:236-240 |
| Search field "Filter plugins" / "Search plugins" (M:59) | MATCH (filters Chromes by name+browser) | PluginsPage.tsx:241, BrowserPlugins.tsx:104 |
| Ghost "Refresh" with icon (M:60) | MATCH (Browsers tab refreshes relay+settings) | PluginsPage.tsx:242 |
| Primary "Pair a Chrome" with plus icon (M:61) | MATCH (only on Browsers tab) | PluginsPage.tsx:244 |
| No Runtime diagnostics section on Browsers tab | MATCH | PluginsPage.tsx:290 (`tab !== 2`) |
| Deep link: opened from a workspace → pairing dialog with project ticked (M:143 caption) | MATCH | PluginsPage.tsx:138-141, BrowserPlugins.tsx:222 |

### "Your Chromes" section
| Mock element | Status | Shipped |
|---|---|---|
| h2 "Your Chromes" | MATCH | BrowserPlugins.tsx:109 |
| Description "Chromes running the GitSpace extension. Pairing lets your account reach a Chrome; agents in a project use it only once you approve it for that project." (M:65) | DIFFERENT copy: "Agents use a Chrome only in projects that approve it, in their workspace's own tab group and on sites you approve." | BrowserPlugins.tsx:109 |
| CardGroup inline/outlined/separated, Card compact, Monitor CardMedia, CardTitle = name | MATCH | BrowserPlugins.tsx:112-118 |
| CardDescription "Chrome 141 · Windows · extension 5.2.2" (M:69,74) | DIFFERENT: shows raw CDP `Browser` product string (e.g. `Chrome/141.0.x`, only while connected; `Chrome` when offline) + " · extension X"; **no OS**. [BACKEND] OS not reported (relay stores only `message.Browser`, account-worker/src/browser-relay.ts:487; status schema protocol-runtime/src/browser.ts:129) | BrowserPlugins.tsx:119 |
| Usage line "Approved in 2 projects · default in GitSpace · 1 agent using it now" (M:69) | DIFFERENT: "Approved in N projects · default in X" — **"N agent(s) using it now" MISSING** [BACKEND]: no account-level count of live runs per Chrome (only per-workspace `running` in overview, browser.ts:193) | BrowserPlugins.tsx:120 |
| Unapproved warning "Paired, but not approved for any project, so no agent can use it." colour `#b45309` (M:74) | DIFFERENT copy ("Not approved in any project, so no agent can use it yet.") and colour (`text-amber-600`); shipped also shows the "Approved in 0 projects" line above it, mock replaces the line | BrowserPlugins.tsx:120-121 |
| Badge green "Online" | MATCH | BrowserPlugins.tsx:124 |
| Badge gray "Offline · seen 2 h ago" (M:75) | DIFFERENT: just "Offline". [BACKEND] no last-seen timestamp stored/returned (browser.ts:129-134) | BrowserPlugins.tsx:124 |
| Ghost "Manage Chrome" for approved Chrome | MATCH | BrowserPlugins.tsx:125 |
| Secondary "Approve for projects" button (instead of Manage) on a Chrome approved nowhere (M:75) | MISSING (always ghost "Manage Chrome") | BrowserPlugins.tsx:125 |
| Tertiary icon-compact Trash "Forget {name}" on each card (M:70,75) | MISSING on card (Forget only inside Manage dialog) | BrowserPlugins.tsx:123-126, 193 |
| — | EXTRA: red "Update the extension" badge (updateRequired) | BrowserPlugins.tsx:124 |
| — | EXTRA: "Pairing in progress" rows (Unconfirmed Chrome, amber "Pairing", Resume, Forget) | BrowserPlugins.tsx:130-136 |
| — | EXTRA: loading / empty ("No Chrome paired yet" + Pair) / "No matching Chromes" / error+Retry states | BrowserPlugins.tsx:110-111,129,137 |

### Cloud browser section
| Mock element | Status | Shipped |
|---|---|---|
| h2 "Cloud browser" (M:80) | DIFFERENT: h2 "Built in" | BrowserPlugins.tsx:140 |
| Section description "Headless Chromium with one profile per workspace. Always available; which sites it may open comes from each project's bundle." (M:80) | MISSING (no section paragraph). Note: mock view 2 (M:243) says cloud browser is unrestricted, which is what ships (account-worker/src/runtime-browser.ts:173); mock is self-contradictory here | — |
| Card title "Cloud browser", Cloud icon | MATCH | BrowserPlugins.tsx:142-143 |
| CardDescription "Built in · every project" | DIFFERENT: "Every project · nothing to pair" | BrowserPlugins.tsx:143 |
| Meta line "3 workspaces have open tabs" (M:82) | DIFFERENT: static prose "A fresh browser in the cloud for each workspace, signed in to nothing. Agents use it on the sites approved in the workspace's Environment." (also contradicts unrestricted cloud behaviour). [BACKEND] no account-level count of workspaces with cloud tabs | BrowserPlugins.tsx:143 |
| CardFooter Badge blue "Built in" (M:82) | MISSING (no footer) | BrowserPlugins.tsx:141-144 |

### Design note (M:85)
| Mock | Status | Shipped |
|---|---|---|
| Settings → Connections → Browser Relay goes away | MATCH (no such page in account-web/src) | — |
| Chrome section of project settings goes away | MATCH (replaced by link sentence to Plugins → Browsers) | AccountWorkPages.tsx:326 |

### Manage Chrome dialog (M:92-112 vs BrowserPlugins.tsx:150-205)
| Mock element | Status | Shipped |
|---|---|---|
| Dialog size lg, title = Chrome name | MATCH | :158-159 |
| Description "Paired Oct 23 · fingerprint 9F2A 61C0 3B7E D104 · online now" (M:96) | DIFFERENT: description is explanatory prose; fingerprint shown in body as full 64-hex lowercase "SHA-256 …" (:166); browser/extension/protocol/online line (:167). **Paired date MISSING** [BACKEND] (no pairedAt in status schema, browser.ts:129-134). Short grouped fingerprint is formatting only, but the extension popup shows the full hash too (browser-extension/src/popup.js:93) so both sides must change | :159, 165-169 |
| InputGroup with two fields side-by-side: "Name" + "Note for agents" (one note per Chrome) (M:97) | DIFFERENT: "Chrome name" field + separate secondary "Rename" submit button (:161-164); note is **per project approval** ("Note for agents in {project}", Save note, only when approved, :186, 199-205). One-note-per-Chrome would need [BACKEND] change (notes live on project approvals, browser.ts:138) or UI that writes the same note to every approval | :161-164, 186, 199-205 |
| "Projects" h3 + caption "Approving is your personal permission, not a repository setting. Each workspace gets its own tab group; the project's approved sites still apply. The default answers requests that don't name a Chrome." (M:99) | DIFFERENT: h3 present, caption MISSING (different copy lives in DialogDescription) | :171 |
| Project rows in one bordered rounded-xl list with dividers, px-3 py-2 (M:100) | DIFFERENT: each project a separate bordered card `border-border/60 p-3` (with note field inside) | :178 |
| Row: name · gray "Project default" badge or ghost compact "Make default" (approved only) · Switch "Approved"/"Not approved" | MATCH | :180-184 |
| — | EXTRA: "Create a project first." empty text; extension-too-old warning | :168, 172 |
| Footer: tertiary "Forget this Chrome" + secondary "Done" | DIFFERENT (Forget is `ghost`, not `tertiary`); behaviour MATCH | :192-195 |

### Pair a Chrome dialog (M:114-148 vs BrowserPlugins.tsx:207-282)
| Mock element | Status | Shipped |
|---|---|---|
| Layout: all four steps visible at once as a numbered vertical stepper (`ol`), numbered circles turning green ✓ when done (M:114-119,127) | DIFFERENT: one step at a time, "Step N of 4 · title" in DialogDescription, no stepper/check circles | :218, 247-249 |
| Description "One pass from install to an agent-ready Chrome. Nothing is usable until you confirm the fingerprint." (M:126) | DIFFERENT (replaced by step counter) | :249 |
| Step 1 title "Install the GitSpace extension" (shown done) | DIFFERENT title "Add the extension to Chrome" | :209 |
| Step 1 body: secondary compact "Download extension" + caption "Then chrome://extensions → Developer mode → Load unpacked." | DIFFERENT: paragraph instructions + secondary "Download extension" (download icon, default size) + InputCopy "Extensions page" `chrome://extensions` | :251-255 |
| Step 2 title "Paste this into the extension's popup" | DIFFERENT "Paste the pairing code in the extension" | :210 |
| Step 2 body: InputCopy copying the JSON but **displaying** "K7Q-2MX-91F · expires in 9:41" (short code + live countdown) (M:131) | DIFFERENT: InputCopy "Pairing JSON" displays the full JSON; expiry as "Works once, until {time}" (no countdown); extra paragraph about private key; "Waiting for the extension…" | :256-261 |
| Pairing code available immediately on open | DIFFERENT: code is created only after pressing footer "Next" on step 1 | :277 |
| Step 3 title "Check it's your Chrome" | DIFFERENT "Compare fingerprints" | :211 |
| Step 3 waiting: pulsing blue StatusDot + "Waiting for a Chrome to answer…" (M:135) | DIFFERENT: plain status text "Waiting for the extension to report its key…" (no dot) | :265 |
| Step 3 answered: surface-3 strip "A Chrome answered. Its popup should show **9F2A 61C0 3B7E D104**" + inline primary "It matches" → disabled secondary "Confirmed" (M:136) | DIFFERENT: paragraph + code block "SHA-256 {64 hex}"; "It matches" is in footer; no "Confirmed" state (advances to step 4). Short fingerprint needs extension popup change too (popup.js:93) | :262-265, 278 |
| — | EXTRA: footer ghost "It doesn't match" (forgets pairing) | :276 |
| Step 4 title "Use it in projects" | DIFFERENT "Name this Chrome and choose projects" | :212 |
| Step 4 "Name this Chrome" field prefilled | DIFFERENT: label "Chrome name", placeholder "For example, Work Chrome", prefilled with relay's name | :267, 278 |
| Step 4 project rows in bordered divided list: name · caption "No default yet · this becomes it" on projects without a default · Switch "Approved"/"Not approved" (M:140-142) | DIFFERENT: bare list of Switches labelled with the project name; per-row "No default yet · this becomes it" MISSING (one generic sentence "A project with no default Chrome makes this one its default.") | :268-271 |
| Caption "Opened from a workspace, its project is ticked already." | MISSING copy (behaviour exists) | :222 |
| Footer: secondary "Cancel" + primary "Finish" (disabled until confirmed) | DIFFERENT: footer changes per step: Cancel/Skip + Next / It matches / Finish | :275-280 |

---

## View 2 · Inspector → Browser (M:150-309 vs RuntimeBrowserTab.tsx, RuntimeBrowserCaptures.tsx, RuntimeBrowserShares.tsx, Composer.tsx, inspector/Inspector.tsx, environment/EnvironmentView.tsx)

### Inspector framing
| Mock element | Status | Shipped |
|---|---|---|
| Browser tab sits next to Environment (M:236) | MATCH | inspector/Inspector.tsx:232-233 |
| Tab label with count "Browser · 2" when tabs are open (M:236) | MISSING (static "Browser") — overview has the data, frontend only | inspector/Inspector.tsx:233 |
| Environment keeps one line "Browser · 2 browsers, 1 running" linking to the Browser tab (Note M:230) | MISSING | environment/EnvironmentView.tsx:195-221 |
| Environment drops the "Browser access and recovery" block (M:230) | PARTIAL: no recovery in Environment (MATCH), but per-site "Browser access" approval rows remain in Environment (by design D §4.1 l.75 site levels are approved there) | EnvironmentView.tsx:201-213 |
| — | EXTRA: Browser tab's own header "Browsers" + ghost "Refresh" (mock has none) | RuntimeBrowserTab.tsx:160 |
| Content padding px-4 gap-4, cards `shape.container bg-surface-1 p-3 shadow-surface-1` (M:184) | DIFFERENT: cards `bg-surface-2 p-4` | RuntimeBrowserTab.tsx:158 |

### Approved sites
| Mock element | Status | Shipped |
|---|---|---|
| h3 "Approved sites" + ghost compact "Ask agent to add a site" (M:241) | DIFFERENT: h4 caption-size heading; button is "Change in Environment" (opens Environment) | RuntimeBrowserTab.tsx:166 |
| Sites as inline chips `host · level` (mono host, sans level) with levels read / interact / full (M:242) | MATCH (2026-10-25): chips `host · read|interact|full`; the three levels are the approval levels (D §4.1 l.75) | RuntimeBrowserTab.tsx:223 |
| Caption "From .gitspace/bundle.json at dd0a157. Your Chrome only opens these; the cloud browser is unrestricted." (M:243) | MISSING (no source/commit caption). [BACKEND] overview has no bundle revision (browser.ts:189) | RuntimeBrowserTab.tsx:164-169 |
| — | EXTRA: empty text "No sites approved yet…" | :168 |

### State "Chrome needs approval" (M:246-249)
| Mock element | Status | Shipped |
|---|---|---|
| Amber box (`#f59e0b` 50% border, 10% bg) | MATCH (amber-500/40, /10) | :170 |
| Title "Agents here can't use your Chrome yet" | MATCH | :171 |
| Copy "Studio desktop is paired and online, but not approved for GitSpace. Approving makes it the project default, since GitSpace has none." | DIFFERENT: generic "Approve a Chrome for this project; its agents then use it in this workspace's own tab group." (no name/online/default explanation) | :173 |
| Primary compact "Approve Studio desktop for GitSpace" | DIFFERENT: secondary "Approve {name} for this project" (one per Chrome); behaviour (approve + default if none) MATCH | :174, 126-130 |
| Ghost compact "Manage Chromes" | MISSING | :174 |

### State "No Chrome paired" (M:251-254)
| Mock element | Status | Shipped |
|---|---|---|
| Neutral card (border, bg-surface-1), title "Let agents use your own Chrome" | DIFFERENT: same amber box with title "Agents here can't use your Chrome yet" | :170-171 |
| Copy "For sites where you're signed in. Agents get one tab group per workspace and only the sites above." | DIFFERENT: "Pair your Chrome with GitSpace first, then approve it for this project." | :176 |
| Secondary compact "Pair a Chrome" with plus icon | DIFFERENT: no icon; behaviour MATCH (navigates to Plugins with `pair=<project>`) | :177 |

### Chrome card, "working" state (M:181-188, 256-265)
| Mock element | Status | Shipped |
|---|---|---|
| Header: Monitor icon · title · "Project default" badge · spacer · right meta "Your Chrome · online" | DIFFERENT: no icon; Online/Offline shown as green/gray badge, no "Your Chrome · …" meta | :180-184 |
| — | EXTRA: the project's note for this Chrome under the header | :186 |
| Group strip (surface-3 rounded): Chip in Chrome tab-group colour "▶ {group name}" | DIFFERENT: plain text "Tab group **{name}**" + separate blue badge "▶ running N"; no group colour. [BACKEND] overview has no group colour (browser.ts:191-194) | :228-229 |
| Activity "main · `browser.run` · 4 commands · 0:12" | MISSING. [BACKEND] overview only has `running` count (browser.ts:193); agent name, tool, command count, start time not reported (extension keeps them locally: browser-extension/src/runs.ts:45) | — |
| Secondary compact "Stop" (StopCircle icon) ending the run | MISSING. [BACKEND] no management action to stop a group's scripts from GitSpace (action enum browser.ts:60; extension-only Stop, browser-extension/src/background.js:335) | — |
| — | EXTRA: ghost "Revoke access" with window.confirm | :230, 132-134 |
| — | EXTRA: capture hint paragraph ("Capture here records the tab without sound…") | :232, 27 |
| Empty text when no group | EXTRA/DIFFERENT copy "No tab group yet. It appears in this Chrome when an agent first uses it; drag tabs into it to share them." (mock shows no such state) | :187 |

### Tab tile (M:169-179)
| Mock element | Status | Shipped |
|---|---|---|
| Tile: bordered rounded-xl bg-surface-1 card, preview flush at top 16:10 with border-bottom | DIFFERENT: `rounded-lg bg-surface-3 p-2` tile, preview inset `aspect-video` (16:9) | :236-237, 268 |
| Preview is a button → opens Watch dialog | MISSING (preview not interactive) | :268-270 |
| Overlay badge "Agent acting" (blue, bottom-left) on the tab the agent is driving | MISSING. [BACKEND] no per-tab acting/lease state (tab view browser.ts:184; leases D §4.2 l.91 "Leases (B1) add a lease per tab", not built D §8 l.217) | — |
| Overlay "3 s ago" (preview age, bottom-right) | MISSING; frontend only (`capturedAt` exists, browser.ts:230) | :256-271 |
| Preview for a tab "You added it" (PR #153 shows an image) | DIFFERENT: on Chrome a preview exists only while the agent uses the tab, otherwise the reason text shows (browser.ts:228-229) — [BACKEND] policy | :269-270 |
| Title (caption, medium) + URL (mono 11px) | MATCH (URL text-caption, not 11px) | :239-240 |
| Gray compact badge "Opened by agent" / "You added it" | DIFFERENT: plain muted text line (also "Opened by a page", "· not on an approved site") | :241, 28 |
| Ghost icon "Watch" (Eye) | MISSING | — |
| Ghost icon "Close tab" (X) | MISSING. [BACKEND] no UI management action to close a tab (browser.ts:60) | — |
| — | EXTRA: "Capture" / REC clock + "Stop" per tile | :244-247 |
| — | EXTRA: "Share" popover per Chrome tile (Comments checkbox, expiry select, Create link, Copy) | :248, RuntimeBrowserShares.tsx:44-70 |
| Two-column grid | MATCH (`sm:grid-cols-2`) | :233 |

### Watch dialog (M:303-307)
| Mock element | Status | Shipped |
|---|---|---|
| Dialog lg, title = tab title | MISSING (whole dialog) | — |
| Description "Studio desktop · {group} group · screenshot every few seconds (live video comes with Batch 16)" | MISSING | — |
| Large 16:10 preview | MISSING (preview endpoint exists: frontend) | — |
| Ghost "Focus in Chrome" | MISSING. [BACKEND] no focus-tab relay operation | — |
| Secondary "Take over" | MISSING. [BACKEND] lease/takeover not built (D §7.2 l.183-189, milestone B1 l.321; "Not built yet … the lease", D §8 l.217) | — |
| Primary "Done" | MISSING | — |

### Cloud browser card (M:268-271)
| Mock element | Status | Shipped |
|---|---|---|
| Cloud icon + title "Cloud browser" + meta "Headless · this workspace's profile" | DIFFERENT: title only, no icon/meta | :189-190 |
| Tiles (same TabTile) | DIFFERENT as per tile table | :191 |
| Empty "No open tabs." | DIFFERENT: "Not started. It starts when an agent first browses." / "No tabs in the group." | :191, 251 |
| — | EXTRA: "Headless browser on {machine}" cards | :193-197 |

### Captures (M:209-215, 273-289)
| Mock element | Status | Shipped |
|---|---|---|
| Section not a card: h3 "Captures" + compact TabsSubtle filter | MATCH | RuntimeBrowserCaptures.tsx (`BrowserCaptures`) |
| Filters with counts "All · 4 / Steps · 2 / Comments · 2 / Video · 3 / Screenshots · 1" | MATCH (Batch 19 phase 5): Steps = captures with steps, Comments = captures with threads (counted from the workspace's threads), Video includes recordings still running or failed | `CAPTURE_FILTER_ORDER`, `keep` |
| List: one bordered rounded-xl bg-surface-1 container with dividers | MATCH | |
| Thumbnail w-24 16:10 | MATCH | |
| Red "● live" badge on thumbnail while capturing, live preview | MATCH for the badge (the thumbnail is the capture's, not live) | |
| Name in text-body | MATCH | |
| Track pills (rounded-full surface-3 11px): "2 comments", "video 4:12", "layout", "5 steps", "video 0:14 · sound", "9 steps", "screenshot · 1440×900" | MATCH: steps, comments, video (length, sound), layout, screenshot size; a recording shows "recording m:ss" | `trackPills` |
| Status badge "Not in repo" (gray) / "Saved as skill" (green) | MATCH: green from `capture.json` `skill`; gray for a saved capture with steps and no skill | |
| Meta "Bradley · Studio desktop · httpbin.org/forms/post · capturing now" / "main saved it to .gitspace/skills/staging-sign-in in a3f9c21 after you asked" / "main · capture() in a run · cloud browser · 19:12" | DIFFERENT: "You/Agent" for the person (the capture records `by: you/agent`, not a name), "Agent saved it to {path} in {commit}" (no "after you asked"), "Agent · capture() in a run · {browser} · {page} · {time}" | |
| Ghost "Mention" (puts the capture into the chat) | MATCH: puts `capture://<id>` into the composer (a chip) | |
| Ghost "Play" / "View" (screenshot) | MATCH (disabled while recording or with no media) | |
| Secondary "Share" per capture | MATCH: a popover with Comments and expiry (1 hour, 1 day, 7 days, 30 days), Create link, then the link with Copy, time left, Stop sharing and its activity | `ShareCapture` |
| Buttons in a row at the right | MATCH | |
| Caption "Everything you or an agent captures, one list. …" | MATCH | |
| — | EXTRA: Failed badge + reason; loading/error states | |

### Recent runs (M:291-300)
| Mock element | Status | Shipped |
|---|---|---|
| h3 "Recent runs" + bordered divided list | MISSING (whole section) | — |
| Row: time (tabular) · where (browser name, w-28) · mono summary ("act fill “Customer name” → {"name":"Ada"}", "goto httpbin.org/forms/post → view, 25 refs") · ghost "Details" | MISSING. [BACKEND] no workspace/account run log; only the extension's local log (browser-extension/src/runs.ts:45, background.js:332; shown in popup popup.js:94) | — |
| Refused rows in destructive colour ("Refused: no Chrome approved for GitSpace") | MISSING. [BACKEND] refusals not recorded | — |
| Caption "Recovery records appear here only when a group needs repair." (recovery folded into this list) | DIFFERENT: separate "Recovery" card shown only when records exist (state badge, id, reason, fence expiry, Reconcile/Discard) | RuntimeBrowserTab.tsx:198-213 |

### Sections shipped but absent from mock view 2
- EXTRA: "Shares" card (live/ended shares, link + Copy, Watching list, time left, Stop sharing, Activity audit) — RuntimeBrowserShares.tsx:74-102, RuntimeBrowserTab.tsx:215.
- EXTRA: "Page comments" card, now threads (Batch 19 phase 4): Open/Resolved filter, numbered purple pin badge, crop, who (guest/agent badge), age, text, "On role “name”", where it was made, page link, replies, Reply, Resolve/Reopen and Show on page (your Chrome: the extension brings the tab forward in comment mode with the thread open, `browserCommentShow`; a share's or the cloud browser's tab: the Watch dialog with the pin highlighted); no composer — RuntimeBrowserComments.tsx, RuntimeBrowserTab.tsx.

### Pasted tab link in the composer (M:190-207 vs Composer.tsx)
| Mock element | Status | Shipped |
|---|---|---|
| Link detected in the draft and turned into a chip | MATCH (own-account links only) | Composer.tsx:39-46, 145-153 |
| Link **swapped out of the text**: the draft shows only "Can you summarise…" with the chip inside the composer box | DIFFERENT: the raw link stays in the textarea; chips render in a list above the InputMessage | Composer.tsx:284-295 |
| Chip: Monitor icon · bold host "news.ycombinator.com" · muted "· Studio desktop" (Chrome name) | MATCH (phase 2): the preview, asked as this browser's device, names the Chrome (`browser`, account-worker/src/browser-share.ts:658); EXTRA caption "{Chrome} is offline · open that Chrome to connect this tab" when it is offline | Composer.tsx:303-312 |
| Caption next to chip "Pasted tab link · joins this workspace when you send" | DIFFERENT: only a `title` tooltip ("Sending connects this tab to the workspace; …") | Composer.tsx:287 |
| Ghost icon X "Remove tab" | MISSING | — |
| Send connects the tab first, link never reaches the agent | MATCH (browserShareConnect, link replaced with machine text) | Composer.tsx:160-174 |
| Sent bubble shows the chip + the message | DIFFERENT [INFERENCE]: the sent text contains `[Connected tab "…" (url) on {Chrome}, pairingId …, targetId …; use web_browser …]` and no renderer for it was found, so the transcript shows that raw text | Composer.tsx:170 |
| Confirmation line with group-colour dot "Tab connected: {host} joined this workspace's group in {Chrome}. The agent may use it while it stays there." | MISSING (only "Connecting the shared tab…" while connecting) | Composer.tsx:342 |
| Expired/stopped link: chip says so, nothing connects | PARTIAL: chip shows "share ended" or the error message (:291-292), but Send still tries to connect and fails with a submit error (message not sent) | Composer.tsx:160-172 |
| Another account's link: chip says so, nothing connects | DIFFERENT: not recognised at all (origin check, browser-share.ts:171-178), so no chip and the link goes to the agent as plain text | Composer.tsx:39-46 |

---

## View 4 · Joining a share (MS vs share/SharePage.tsx, ShareGreeting.tsx, ShareViewer.tsx, ShareComments.tsx)

### Link handling (Note MS:188)
| Mock | Status | Shipped |
|---|---|---|
| `/s/…#secret`, secret in the fragment, exchanged for a session only on Join | MATCH | SharePage.tsx:15-16, 29-30, 35-37, 68-74 |
| — | EXTRA: loading spinner, "This link doesn't open a share" / "The share didn't load", full-share and 401 fallback messages | SharePage.tsx:26, 44-51, 79-83 |

### Greeting · Guest (MS:40-58 vs ShareGreeting.tsx)
| Mock element | Status | Shipped |
|---|---|---|
| Centred card `w-[420px] rounded-2xl border bg-surface-1 p-7 shadow-xl` | DIFFERENT: borderless full-page form `max-w-md` | ShareGreeting.tsx:40-41 |
| Logo row: favicon 28px + "GitSpace" | DIFFERENT: kicker text "Shared tab · GitSpace", no logo | :43 |
| h2 "Bradley is sharing a tab with you" (title, tracking-tight) | MATCH (h1, no tracking-tight) | :44 |
| Subtitle "Live, as it happens in Bradley's Chrome." | MISSING | — |
| Page tile (rounded-xl border bg-surface-2 p-3): site icon square ("Y" on orange) | MATCH (phase 2): the page's favicon from the sharing Chrome (`page.icon`; extension background.js:1100 `shareIcon`); without one, the site's first letter on surface-3 | share/ShareGreeting.tsx:51-55 |
| Tile title "Hacker News" + **mono** host | DIFFERENT: host not mono; tile `bg-card px-4 py-3` | :46-48 |
| Tile right: green dot "live" | MATCH (phase 2): `online` in the preview; gray dot "offline" while the Chrome is offline | share/ShareGreeting.tsx:59-61 |
| One ✓/✕ list | DIFFERENT: two headed lists "You can" / "You can't" with Check / X icons | :50-62 |
| "✓ Watch the tab live" | MATCH | :35 |
| "✓ Point: everyone sees your pointer with your name" | DIFFERENT "Point at things: everyone watching sees your pointer and name" | :36 |
| "✓ Comment on anything on the page" | DIFFERENT "Comment on what you point at: {sharer} gets your comments" | :37 |
| "✕ Click or type in the page; only Bradley and his agent can" | DIFFERENT "Click or type in the tab: it stays in {sharer}'s hands" | :39 |
| — | EXTRA: view-only variant "✕ Comment: this share is view only" | :39 |
| Name field label "Your name", placeholder "Shown on your pointer and comments" | DIFFERENT placeholder "Shown on your pointer"; EXTRA remembered name | :68; SharePage.tsx:67 |
| Primary "Join", disabled until a name | MATCH (+ "Joining…") | :70 |
| Footer caption after Join: "Bradley sees that you joined. Ends in 52 min or when Bradley stops sharing. No account needed." | DIFFERENT: "Ends 3:45 PM, in 52 minutes." placed **above** the name field; "sees that you joined", "or when … stops sharing", "No account needed." MISSING | :63; share-format.ts:13-22 |

### Greeting · Signed in to GitSpace (MS:27, 52-56)
| Mock element | Status | Shipped |
|---|---|---|
| Another GitSpace user (Ana Ruiz) recognised: box "Joining as **Ana Ruiz** (signed in to GitSpace)" on surface-2, no name field, Join enabled, footer without "No account needed." | NOT BUILT [BACKEND, needs a decision]: no identity spans accounts (each account's devices live in its own vault and IndexedDB on its own host; the apex `gitspace.sh` has no session; sealing and signing keys are per account), so another account's user cannot be verified without new infrastructure (a platform-brokered or per-account-issued assertion). The account's **own** device is recognised, in the mock's box ("Joining as {sharer} (signed in to GitSpace)") | ShareGreeting.tsx:70-72; SharePage.tsx:37-40 |

### Greeting · Shared capture (MS:28-39)
MATCH (Batch 19 phase 5, share/CaptureSharePage.tsx, `/c/<id>#secret`): logo row; "{sharer} shared a capture with you" and "A recording of a browsing session, with comments. {sharer}'s browser doesn't need to be on."; the purple tile with name and "{page} · m:ss · N comments"; the three ✓/✕ lines (a view-only share says "✕ Comment: this capture is shared view only"); "Your name" ("Shown on your comments") and Open, disabled until a name; "Contains a recording of everything visible in the tab during the session. Ends in {time left} or when {sharer} stops sharing." EXTRA: opened from one of the account's devices, "Opening as {sharer} (signed in to GitSpace)" and no name field.

### Greeting · Ended (MS:22-26)
| Mock element | Status | Shipped |
|---|---|---|
| Centred card w-420 p-8 with faded favicon 36px | DIFFERENT: generic EmptyState in `max-w-md p-8`, no logo | SharePage.tsx:52-56 |
| Title "This share has ended" | MATCH | SharePage.tsx:54 |
| Body "Bradley stopped sharing, the time ran out, or the tab was closed. Ask Bradley for a new link." | DIFFERENT: names the actual reason ("{sharer} stopped sharing." / "Its time ran out." / "The shared tab was closed.") + "Ask {sharer} for a new link if you still need it." | SharePage.tsx:55; share-format.ts:6-10 |

### Live viewer, commenting (MS:65-118 vs ShareViewer.tsx)
| Mock element | Status | Shipped |
|---|---|---|
| Header: favicon 20px · "**Bradley** is sharing `news.ycombinator.com` · 52 min left" | DIFFERENT: h1 page title + "{site} · shared by {sharer} · ends 3:45 PM, in 52 minutes"; no favicon, no bold sharer lead, no "N min left" form | ShareViewer.tsx:318-322 |
| Watchers as overlapping initial avatars (coloured circles, white ring) in the header | DIFFERENT: right sidebar "Watching · N" list (colour dot, name, "(you)", guest badge) | :377-386 |
| Toggle: primary "Commenting" when on / secondary "Comment" when off, MessagePlusSquare icon | DIFFERENT: label always "Comment" (pressed = primary), MessageTextSquare01 icon; only on comment shares | :323-325 |
| Comment mode: crosshair cursor | MATCH | :337 |
| Comment mode: inset 3px purple ring around the page | MISSING | :337 |
| Footer caption under the page: commenting "Hover to see what a comment would attach to, click it, or drag across an area. Bradley sees your comment on the page in his Chrome and in his workspace." / watching "Watching live · your pointer is visible to everyone here" | DIFFERENT: commenting hint is a bar **above** the page with "Click or tap what you want to comment on, or drag over an area."; the watching line MISSING | :330 |
| Hover outline: 2px **dashed purple**, purple label chip above `link “title”` | DIFFERENT: 2px **solid blue** border + blue/10 fill, blue label "role name" (no quotes) | :346, 393-400 |
| Hover target resolved by the live tab (DOM.getNodeForLocation) | MATCH (hit messages) | :119, 164, 279 |
| Drag area: dashed purple outline + purple 8% fill (>12px) | DIFFERENT: same blue solid Outline (8px threshold) | :347, 33 |
| Chosen element/area: solid purple outline | DIFFERENT: blue Outline (region; element only while `hit` is held) | :346-348 |
| Draft popover: white card w-72 to the right of the target, "On {label} · as **Ana (guest)**" | DIFFERENT: card w-64 at the click point/area corner; "On role “name”" / "On this area" / "On this spot"; **"as {name} (guest)" MISSING** | :350-357 |
| Field placeholder "Write a comment…" | MISSING (textarea has no placeholder) | :359 |
| Cancel as a text link (left) · purple "Comment" (right) | DIFFERENT: ghost "Cancel" + primary "Comment", both right; EXTRA "Sending…", error text, Ctrl/⌘+Enter, Esc | :363-371 |
| Named pointers overlaid: "main · agent" (blue), "Bradley" (gray), "You (Ana)" (purple) | MATCH (phase 2) for "Bradley": the sharer's Chrome reports their pointer over the tab and each viewer draws it in gray with their name (`sharer` message; account-worker/src/browser-share.ts:535); it is never drawn on the tab, under the sharer's own cursor. The agent's cursor and the viewers' pointers arrive drawn into the frames by the overlay (its labels are the overlay's: "main", "Ana · watching") | share/ShareViewer.tsx:383-385, 428-441 |
| Numbered comment pin on the page ("1") | MATCH (Batch 19 phase 4): purple `rounded-bl-none` pins at the top-right of each open thread's anchor box on this page (box fractions of the tab's viewport, page matched by URL without the fragment); a pin or the list opens the thread popover (the mock's Thread look: "On …", avatars, `AI` in blue for agents, "Reply as Ana (guest)…", Resolve for the account's owner only, purple Reply); others' comments and replies arrive live (`thread` messages). Pins keep the box from when the comment was made: after the sharer scrolls they point where the element was | share/ShareViewer.tsx, comment-threads.tsx |
| — | EXTRA: Comments sidebar list of threads (pin number, text, who, guest badge, time, replies, resolved, "On …"); choosing one opens it | ShareComments.tsx |
| — | EXTRA: banners "{sharer}'s Chrome is offline…", "Connection lost. Reconnecting…", notice+Dismiss; "Waiting for the tab…" | :327-329, 344 |
| Guest comments carry the given name, marked guest | MATCH | ShareComments.tsx:13-14; account-worker/src/browser-share.ts:464 |

### Shared capture, browser offline (MS:130-175)
Built (Batch 19 phase 5): the same player as the Browser tab (capture/CapturePlayer.tsx) on `/c/<id>`, its files served from the drive through the share, so no Chrome needs to be on.
- Header: favicon · "**Pizza form review** · capture from Bradley · 4:12 · whole recording" · pill: DIFFERENT "{sharer}'s Chrome can be off · recording" (the share page does not ask whether the Chrome is online).
- Left sidebar of timed comments: MATCH (numbered pin, purple, gray once resolved; "{who} · at m:ss · added later"; click seeks and opens the thread; active row highlighted). EXTRA: a Steps tab (time, kind, locator, value with secrets masked, data-changing requests marked).
- Frame: hover outline from the recorded layout, "textbox “E-mail address:” · from the recording": MATCH while commenting (after "Comment at m:ss").
- Pins on the frame for comments made up to the playhead: MATCH.
- Active comment popover: DIFFERENT position (beside its pin, the in-page tool's popover from comment-threads.tsx) with "On {anchor}", the thread, "Reply as Ana (guest)…"; Resolve only for the account's owner.
- Transport: MATCH (round dark ▶, "m:ss / m:ss", custom scrubber with progress and thumb, step ticks, numbered comment markers).
- Secondary "Comment at m:ss" with comment icon: MATCH; while pointing it reads "Commenting" with the purple inset ring.
- Note: anchors re-matched to real elements when the live page opens again (D §9) — not built.

---

## Backend-dependent features (summary, with design source)
| Feature | Where in mock | Design source | Current state |
|---|---|---|---|
| Signed-in (other account) greeting / non-guest identity | V4 greeting "Signed in" | D §8 l.200 | Only owner device recognised (browser-share.ts:36; account-worker browser-share.ts:141) |
| Shared captures playable while Chrome offline (capture share links, "Shared capture" greeting, saved-session player) | V4 greeting + saved session; V2 capture "Share" | D §8, §11 | Built (Batch 19 phase 5, D §11 "Capture share links") |
| Comment threads / replies / resolve | V4 "Reply as…", saved-session popover | D §9 l.221, 228; §8 l.213; B2 l.322 | Not built; comment schema has no thread/resolution (browser-share.ts:103-118) |
| Comments on a recording's timeline, "Comment at m:ss", approximate anchors | V4 saved session | D §9 l.230; §11 | Built (D §11 "Built (B3)"); re-matching to the live page not built |
| Steps / layout / comments capture tracks, Steps & Comments filters, track pills | V2 Captures, V4 timeline ticks | D §11; B3 | Built (capture.json v2; Captures list and player) |
| Saved-as-skill status / "Not in repo" / commit | V2 Captures | D §11 | Built (`capture.json` `skill`) |
| Take over / lease, "Agent acting" | V2 Watch dialog, tiles | D §7.2 l.183-189; §4.2 l.91; B1 l.321 | Not built (D §8 l.217) |
| Focus in Chrome, Close tab, Stop run from UI | V2 Watch dialog, tiles, group strip | (no section; extension popup has Stop) | No management actions (browser.ts:60) |
| Run activity (agent, tool, command count, elapsed) and Recent runs / refusals | V2 group strip, Recent runs | D §6.1 (scripts), §4.1 | Only `running` count; log is extension-local (runs.ts:45) |
| Site levels read / interact / full; bundle source + commit caption | V2 Approved sites | D §4.1 l.75 | Built 2026-10-25 (extension 5.9.0) |
| Chrome OS, last seen, paired date, "N agents using it now", cloud "N workspaces have open tabs" | V1 cards, Manage dialog | — | Not in relay status (browser.ts:129-134) |
| Short grouped fingerprint | V1 Pair + Manage | §12a (extension boundary) | Full SHA-256 hex in web and popup (popup.js:93) |
| Chrome name in the pasted-link chip; foreign-account chip | V2 composer | D §8 l.204, 215 | Preview lacks browser; other origins not parsed |
| Share-tile favicon, live dot in greeting | V4 greeting | D §8 l.200 | Preview lacks favicon / presence |
| "Show on page" | not in views 1/2/4 (view 3 only) | — | — |
