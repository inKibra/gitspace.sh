# Aperture: Browsers for Workspaces

> **Status: Draft for planning (2026-10-16).** Replaces the scope of the original Aperture draft (`docs/APERTURE-DRAFT.md`, 2026-10-02) for GitSpace. Follows the shape of `docs/CUA-INTEGRATION-DESIGN.md`. Claims marked **[unverified]** need a spike before they become decisions.

## 1. Summary

A GitSpace workspace can use **browsers**: your own Chrome (through the GitSpace extension) and cloud Chrome (Cloudflare Browser Run). GitSpace owns which browsers and tabs a workspace may use, who controls them at any moment, what gets recorded, and how browsers reach the workspace's services. Agents and people work in the same browser sessions:

- **Agents** operate tabs through grants, with semantic tools and a Playwright endpoint.
- **People** watch and control any session remotely, including their own Chrome from a phone, and take over from an agent and hand back.
- **Collaboration:** comments on pages, skills recorded from a demonstration, share links for a tab.
- **Identity:** passwords filled without the agent seeing them, and cookies copied into a cloud browser with approval.

The extension, the account relay, pairing, signed grants and hosted services that GitSpace ships today are the base; this plan grows them rather than starting a separate platform.

## 2. Scope

In scope (V1, milestones B0–B4):
- your Chrome and cloud Chrome as browser sources;
- one tab group per workspace as the grant boundary;
- agent tools (`observe`/`act`) and a per-grant Playwright (CDP) endpoint;
- remote view and remote control of any session, from any signed-in device, phone included;
- the control lease and takeover;
- share links for a tab;
- comments on pages;
- skill recording;
- password management for your enrolled Chrome;
- cookie copy into a cloud browser;
- the service mesh: browsers and machines reaching workspace services through the relay.

Later: WebMCP, learned site capabilities, preference learning, visual CSS proposals, multi-person review sessions, share links for agents outside GitSpace (MCP endpoint per share), machine-hosted headless Chromium, desktops (`docs/CUA-INTEGRATION-DESIGN.md`).

Placement: Aperture is built in the GitSpace monorepo as its own packages (extension, relay endpoints, protocol, browser runtime) behind its own API, so GitSpace consumes it like any other consumer and extracting it for Zerbly later is a move, not a rewrite. AI Constructs reach it through a GitSpace browsing agent (`use(task)`, §6.3), not directly.

## 3. What exists today

| Piece | Where | State |
|---|---|---|
| Extension transport | `account-machine/src/browser-relay-extension.ts` | Extension connects outbound to `wss://<account>/api/browser-relay/extension`; pairing with a code and an extension key, confirmed by fingerprint; `chrome.debugger` with a CDP allowlist (`relayCommandAllowed`). |
| Signed authority | `account-machine/src/browser-relay-authorization.ts`, `account-worker/src/browser-relay.ts` | Account root signs a workspace browser certificate; the workspace signs a group grant and each dispatch; the extension verifies all of it, plus origins, pairing generation and replay. |
| Workspace tab group | `account-worker/src/runtime-browser-account.ts:20-34` | One group per workspace, named after it; the grant lasts 30 minutes and an expired group is replaced by a new one. |
| Cloud browser | `account-worker/src/browser-cdp.ts`, `browser-runtime.ts` | Browser Run session held by the workspace object's runtime as an outbound CDP socket. It cannot hibernate, so an open cloud browser keeps the workspace object awake ("parked"). |
| Account relay | `account-worker/src/index.ts` (`UserRelayDO`), `account-machine/src/relay-connector.ts` | One relay object per account; machines connect outbound; sockets hibernate; tool calls, service HTTP and WebSockets travel as chunked tunnel frames. |
| Hosted services | `account-machine/src/workspace-services.ts`, `account-worker/src/service-access.ts`, `service-sessions.ts` | `https://<service>--<workspace>--<account>-srv.gssh.dev` → route lease → `127.0.0.1:<port>` on the owning machine; HTTP and WebSocket streaming; device-approved 15-minute browser sessions; machines reach other machines' services through `/api/services/fetch`. |
| Cloud browser → services | `account-worker/src/browser-runtime.ts:155-178` | CDP `Fetch` interception for same-workspace hosted names; buffers whole responses; no WebSockets. |

Missing: a Playwright endpoint into your Chrome, remote view and control, share links, takeover, recording, comments, credentials, cookie copy, WebSockets and streaming for the cloud browser's service access, and routes for undeclared dev servers.

## 4. Concepts

```text
Workspace (Workspace DO)
└── gitspace.browsers                document
    ├── group  "pricing-page"        your Chrome · pairing P · Chrome tab group G (stable)
    │   ├── tab 412  opened by agent tester   · lease: agent
    │   └── tab 418  added by you              · lease: none
    └── cloud  "pricing-page"        Browser Run session · profile: agent realm
```

| Concept | Meaning |
|---|---|
| **Browser source** | Where a tab lives: `chrome` (your Chrome, a paired extension) or `cloud` (Browser Run). Machine-hosted Chromium is a later source behind the same tools. |
| **Workspace group** | One stable Chrome tab group per workspace: the workspace's name and a fixed color. Tabs in the group are the tabs the workspace may use. Cloud sources use one browser context per workspace instead. |
| **Grant** | Signed authority for a workspace over its group: allowed origins, capabilities (`observe`, `navigate`, `input`, `playwright`, `record`, `comment`, `view`, `control`), expiry. Renewal extends the grant without replacing the group. |
| **Session** | A live tab or cloud page that agents and people attach to. |
| **Control lease** | At most one writer: an agent (by name), a person, or none. Observers are unlimited. |
| **Share** | A capability link to one session with chosen capabilities and an expiry. |
| **Credential realm** | Whose credentials a browser may receive: `operator/<user>` for your enrolled Chrome, `agent/<workspace>` for cloud profiles, none for shared sessions opened by others. |

### 4.1 The workspace group

- Stable: same Chrome group across grant renewals and reconnects; a reconnect re-binds by stored group identity.
- **Drag a tab into the workspace group to grant it; drag it out or close it to revoke.** The extension reports group membership changes; the grant follows.
- Subagents share the workspace's group (Chrome groups do not nest). The UI shows which agent opened or holds each tab; the lease decides who may type.
- Idle agent: the group collapses. Archive or delete: tabs the agent opened close; tabs you added are ungrouped, not closed.

### 4.2 `gitspace.browsers` document

```ts
type WorkspaceBrowsers = {
  chrome: Array<{
    pairingId: PairingId;
    chromeGroupId: number;            // reported by the extension; re-bound on reconnect
    grant: { id: GrantId; origins: string[]; capabilities: Capability[]; expiresAt: string };
    tabs: Array<{ tabId: number; url: string; openedBy: Actor; lease: Lease | null }>;
  }>;
  cloud: Array<{ sessionId: BrowserSessionId; profile: AgentProfileId | null; lease: Lease | null }>;
  shares: Array<{ id: ShareId; session: SessionRef; capabilities: ShareCapability[]; expiresAt: string; revokedAt: string | null }>;
};
type Lease = { holder: { agent: string } | { userId: UserId; device: DeviceId }; since: string };
```

Rows change through small messages from the extension and the runtime; the UI reads the document (no replay streams, per `docs/SIMPLIFICATION.md`).

## 5. Sources

| Source | How | Identity | Notes |
|---|---|---|---|
| **Your Chrome** | Extension, `chrome.debugger`, outbound socket to the account relay | Your real sessions (`operator/<you>` realm) | Chrome must be running; Chrome shows its "being debugged" bar on controlled tabs. |
| **Cloud Chrome** | Browser Run session, CDP socket held by a dedicated `BrowserSessionDO` per session | Agent profile (`agent/<workspace>` realm), optionally seeded by cookie copy (§10.2) | Sites see signed bot headers (Web Bot Auth) that cannot be removed; 60 s idle close, `keep_alive` up to 10 minutes. |

**Un-parking the cloud browser.** Outbound sockets cannot hibernate, so the CDP socket moves out of the workspace object into one `BrowserSessionDO` per cloud session. Only that object stays awake while the browser is open; it closes on idle. The workspace object talks to it by RPC.

## 6. Agent surface

### 6.1 Semantic tools

| Tool | Does |
|---|---|
| `browser.list` | The workspace's sessions, sources, leases, shares. |
| `browser.open({ source, url })` | Opens a tab in the workspace group (or a cloud page). |
| `browser.observe({ session })` | One compact result: accessibility snapshot with element references (Playwriter's `aria-ref` style), URL, title; a screenshot only when asked. |
| `browser.act({ session, observationId, target, action, args })` | Click, type, select, scroll, key, navigate on an element from a specific observation. Rejected without the lease or with a stale observation. |
| `browser.ask_takeover({ session, reason })` | Asks a person to take over (sign-in, 2FA, captcha) through the `ask` flow, linking to the remote viewer. |

### 6.2 Playwright endpoint

`wss://<account>/cdp/<grantId>?token=…` is a CDP endpoint the relay multiplexes to the extension (or a cloud session), scoped to the grant's tabs and origins. Playwright connects with `chromium.connectOverCDP(...)`. Uses: test suites and scripts on a GitSpace machine, the Tester's checks, debugging. Rules:
- only for GitSpace agents and your machines (device- or grant-signed), never for share links;
- whole-browser cookie and storage commands stay blocked (`Network.getAllCookies`, `Storage.getCookies`, `Storage.setCookies`, cache clears), as Playwriter does even for trusted agents;
- target discovery returns only the grant's tabs.

### 6.3 Scripts: `browser.run`

`browser.run({ session, script })` runs Playwright code against the grant's CDP endpoint, as Playwriter's `execute` does. Most of the speed comes from fewer model turns: one call fills a form, loops over rows, waits on the network. Sessions keep a `state` object between calls.

| Browser | Script runs in |
|---|---|
| Cloud Chrome | The session's `BrowserSessionDO`, next to Browser Run (Cloudflare's Workers build of Playwright; **[unverified]** against our endpoint) |
| Your Chrome, GitSpace machine on the same computer | That machine (Node Playwright), no relay detour |
| Your Chrome, otherwise | The session object, through the relay (each step is a network round trip) |

Enforcement is in the relay's CDP proxy, never in reading the script: grant tabs and origins only, whole-browser cookie and cache commands blocked. Recorded skills replay through `browser.run`. `observe`/`act` stays the default for unknown pages and judgment calls.

### 6.4 Browsing tasks from Constructs

A Construct never drives a browser. It gives GitSpace an instruction: `use(task, outputSchema?)` sends it to a GitSpace agent (`runtime.submit`) and returns its reply (`runtime.watch`), validated against the schema when one is given.

- **Layout:** one browsing project per Construct; one workspace per task, archived when the task ends. The project holds the Construct's instructions, skills (recordings accumulate there) and credentials (`agent/<construct>` realm); each workspace has its own conversation, cloud browser context and history.
- **Browser:** the Construct's cloud Chrome profile by default, never a person's Chrome. Takeover requests go to the Construct's operator.
- **Prerequisite:** creating a workspace must be fast and reliable. On 2026-10-16 the first message in each new workspace timed out (three of three).

## 7. People: remote view and remote control

Any session can be watched and driven from any signed-in GitSpace device: another computer, or a phone.

### 7.1 Viewer

- The GitSpace UI opens a session viewer: a live image of the tab, its URL and title, who holds the lease, and controls.
- **Your own Chrome from your phone:** your desktop Chrome keeps running the tab; the phone views it through the relay and can take control. Nothing needs to be shared first: the phone is your signed-in device, and the session belongs to your account.
- Frames: CDP `Page.startScreencast` (JPEG frames sent only on change, scaled to the viewer's size) from the extension or the cloud session, relayed to viewers over the account relay. Same mechanism for both sources. **[unverified]** bandwidth and latency through the relay at phone resolutions; `chrome.tabCapture` plus WebRTC is the upgrade path if screencast is too slow (Playwriter uses `tabCapture` for recording).
- Input: the viewer sends pointer, touch, scroll and key events; the relay forwards them as CDP `Input.dispatch*` events only when the viewer holds the lease. Phones map taps and swipes to touch events and provide a text field for typing; the tab keeps its desktop viewport.

### 7.2 Lease and takeover

- Taking control moves the lease to you and the relay holds back **all** of the agent's CDP traffic for that tab, not only input: a script can click through `Runtime.evaluate`, and Playwright runs most of its work through `evaluate`. An `act` call waits; a running `browser.run` script ends at its next command.
- Handing back invalidates old observation IDs; the agent must `observe` again, and decides whether to rerun an interrupted script.
- Takeover is also available without an agent asking. Lease changes are journal entries.

### 7.3 Presence

Viewers are listed on the session (name, device). Pointer presence on the page is later.

## 8. Share links

Modeled on Playwriter's remote control.

- `https://<account-host>/s/<shareId>#<secret>`; the secret is in the URL fragment, so it never reaches the server in the request line or logs. The landing page redeems it for a short-lived session token.
- A share is one session (a tab, or a cloud page) with capabilities chosen at creation: `view`, `control` (takes the lease), `comment`. An expiry is required.
- Created from the extension toolbar or the UI; revocable from either. The link dies when revoked, expired, or when the tab closes or leaves the workspace group.
- Recipients without a GitSpace account get the viewer only; no credentials, no Playwright endpoint, no other tabs.
- With `comment`, people on the share comment on the same live tab the agent is using (§9); their comments land in the workspace under the name they give.
- Every redemption and lease change is audited.

## 9. Comments on pages

- A comment mode in the extension's in-page toolbar: point at an element or draw a region, write a comment, reply in a thread.
- Each comment stores enough to find its target again: URL, selector candidates, accessible role and name, visible text, bounds, a screenshot crop, page revision. On GitSpace previews it also stores workspace, commit and, later, React component and source location.
- **Comments belong to the workspace** (`gitspace.page-comments`), on any site. A tab outside every workspace group has no workspace, so comment mode asks which workspace to file into.
- Shown as an overlay in your Chrome and in the session viewer, so people on a share and the agent see the same thread on the same live tab.
- From the viewer (a phone, a share), a tap on the page image is resolved on the live tab (`DOM.getNodeForLocation`) into the same anchor a comment made in Chrome gets.
- Anchors on other sites rely on quoted text plus context (as Hypothesis does), with selectors and bounds as fallbacks; a comment whose target disappeared is flagged, not dropped.
- Screenshot crops can show private, logged-in content: they stay as private as the workspace and appear in a share only when that share includes `comment`.
- Agents list, read and resolve comments with a tool, so "fix what I commented" works end to end. Resolving records the commit that fixed it.

## 10. Identity

### 10.1 Passwords (enrolled Chrome only)

The original draft's §13 invariants stand:
- Credentials live in **GitSpace's vault**; each has exactly one owner (`operator/<user>` or `agent/<workspace>`).
- Saved only during your takeover ("Sign in and save") or from the credential manager UI; never because an agent decided to.
- Use requires a credential grant (agent × credential × origin × realm × expiry), checked at fill time.
- `credentials.fill({ credential, session, origin })` runs in the extension: the realm and origin are checked, the fields are filled, and plaintext never enters model context or tool results.
- Fill into a share opened by someone else (no realm) is refused. Every fill is audited.

### 10.2 Cookie copy into a cloud browser

- On approval naming one site, the extension reads that site's cookies (`Network.getCookies` with the site's URLs, HttpOnly included; never whole-browser), and optionally its local storage.
- They are sealed in the vault as the workspace's agent profile with an expiry, and set in the cloud session (`Storage.setCookies`) before it loads the site. Values never appear in tool output or logs.
- Prior art: Playwriter's `cloud.sendCookies({ from, to })` copies the current page's cookies into a cloud browser, skipping expired and opaque-partitioned cookies.
- Limits, stated in the approval dialog:
  - apps that keep tokens in IndexedDB may still need a sign-in;
  - device-bound sessions (Chrome's device-bound session credentials, Google first) are not expected to survive the copy **[unverified]**;
  - sites may challenge a session that appears from a new IP and browser, and some block Browser Run's signed bot headers.
- For those sites, the answer is your Chrome with takeover.

## 11. Skill recording

Modeled on Playwriter's skill recorder.

- **Record** in the in-page toolbar (or the agent's `recorder.start`). Captured per step: Playwright locator code (`getByRole(...)`), navigations, typed values with secrets masked, mutating network requests, a JPEG per visual change, plus a timeline. The recording attaches to the workspace group's tabs and stops after 20 minutes.
- On **done**, the agent reads the thin timeline, checks each locator against the live page, and writes a skill into the project's skills: a `SKILL.md` with steps and expected outcomes, and a small replay script.
- The agent then replays the script end to end to check it. Later replays run through `observe`/`act`, checking state at each step and adapting when the page differs.
- Recordings (timeline, frames, optional `tabCapture` video) are saved under `drive://browser/recordings/…` and can be attached to goals and test reports.

## 12. Service mesh relay

Browsers and machines reach workspace services through the one account relay.

| From → to | Today | Plan |
|---|---|---|
| Your Chrome → a machine's service | Hosted name with a device-approved 15-minute session | Unchanged. |
| Cloud Chrome → a machine's service | CDP `Fetch` interception, buffered, no WebSockets | Give the cloud session a short-lived service session cookie for the workspace's `*-srv` hosts; it loads the hosted URL directly, so WebSockets and streaming work and the interception code goes. |
| Machine → another machine's service | `/api/services/fetch`, loopback forward (HTTP and WebSocket) | Unchanged. |
| Anyone → an undeclared dev server | No route | `service.expose({ port })` creates a route lease for any port on an attached machine, giving it a hosted name. |
| Machine / Playwright → a browser | None | The per-grant CDP endpoint (§6.2). |
| Phone / other device → a browser | None | The session viewer (§7). |
| Machine ↔ machine, plain TCP | None | Later: TCP forwarding over the same tunnel frames. |

The relay keeps its rules: sockets hibernate where Cloudflare allows; heartbeats are WebSocket auto-responses; frames are chunked at 32 KiB with backpressure; every endpoint is signed and rechecked on revocation.

## 12a. The extension boundary and updates

The extension updates on a different cycle from the rest of GitSpace, so it is kept thin and talks a versioned protocol. Today each account builds the extension from its own release; later one Web Store package serves every account (deferred, below).

- **What the extension holds:** the outbound relay transport, its key and pairing, the verifier for signed authority (`browser-relay-authorization.ts`), the workspace tab-group boundary, the CDP command allowlist, and the screencast and input plumbing B1 needs. Everything else (semantic tools, snapshots, Playwright translation, recording logic, comments) runs server-side and ships with ordinary releases. Manifest V3 forbids remotely hosted code, so whatever the extension holds is frozen per version.
- **Protocol version:** the extension reports `protocol` (an integer, independent of release ids) and its package version in its hello. Every GitSpace release accepts protocols N and N−1. A breaking change is two steps: the server learns N+1, then the extension moves to N+1; N−1 is dropped only after every paired extension reports N+1 (the relay records each pairing's last protocol). An extension below N−1 is refused at hello with "Update required", shown in the popup and in Settings → Chrome with the version needed.
- **Version in view:** Settings → Chrome shows each paired browser's extension version and protocol; the release's minimum protocol is part of its release record.
- **Distribution now:** the account-built unpacked package (Settings → Download extension), rebuilt with each release. A release launched from a workspace offers its own build, loaded into a separate Chrome profile, so extension changes are tested before any account moves to them.
- **Deferred: Chrome Web Store.** Once the boundary has held through B0–B1, one package for every account: host permissions for `https://*.gitspace.sh/*` and its WebSocket origin, the account address taken from pairing, a trusted-tester Beta listing and a public listing, published from `develop` by a Publish extension action. Needs an Inkibra developer account, a privacy policy and permission justifications (`debugger`, `tabs`, `tabGroups`).

## 13. Borrowed from Playwriter

[Playwriter](https://github.com/remorses/playwriter) (MIT) is the closest prior art. Taken:
- extension-attached CDP to your real Chrome, no relaunch, no remote-debugging flag;
- Playwright over CDP through a relay (`connectOverCDP`);
- `aria-ref` accessibility snapshots;
- tab groups (theirs per session, ours per workspace);
- in-page toolbar for record and share;
- share links with the secret in the URL fragment, instant revocation, death on tab close, and a live viewer for people;
- skill recorder (locator code, network mutations, frames → `SKILL.md` plus replay script);
- `tabCapture` video;
- cookie copy into a cloud browser;
- blocking whole-browser cookie commands even for trusted agents.

Not taken: its localhost relay on port 19988 (our extension connects to the account relay); its third-party tunnel; arbitrary JavaScript as the default agent surface (kept behind the Playwright endpoint).

## 14. Milestones

| ID | Milestone | Exit criteria |
|---|---|---|
| **B0** | Grants, groups, Playwright, mesh fixes | Extension protocol version in the hello, N/N−1 acceptance and "Update required" (§12a); stable workspace group with drag-in/drag-out grants; `gitspace.browsers` document; `browser.observe`/`act` with `aria-ref` snapshots and freshness; `browser.run` with session state; per-grant CDP endpoint used by Playwright from a machine; the Tester uses your Chrome through a grant; cloud sessions in `BrowserSessionDO`; cloud browser loads hosted services directly (WebSocket preview works); `service.expose`. One extension update. |
| **B1** | Remote view, control, takeover, share links | Session viewer on desktop and phone; lease and mechanical suspension; `browser.ask_takeover` deep link; share links with view/control/comment, fragment secret, revocation and audit. Golden test: an agent hits a sign-in, you take over from your phone, sign in, hand back, the agent finishes. |
| **B2** | Comments | Comment mode, threads, overlays on workspace and shared sessions; agent tool to list and resolve; preview comments carry workspace and commit. |
| **B3** | Skill recording | Recorder, timeline and frames; agent writes `SKILL.md` plus replay script and replays it successfully; recordings in `drive://`. |
| **B4** | Passwords and cookie copy | Enrollment as the `operator` realm; vault credentials with one owner; capture during takeover; credential grants; `credentials.fill` with realm and origin checks and no plaintext in context; per-site cookie copy into a cloud profile; audit. |

## 15. Risks

| Risk | Mitigation |
|---|---|
| Screencast over the relay too slow or heavy on phones | Measure in B1; scale frames to the viewer; `tabCapture` plus WebRTC fallback. |
| Active streams keep the relay object awake | Streams are wakeful by nature; bound them to viewers and close on idle; usage report flags spikes. |
| Cloud Chrome blocked or challenged by sites | Offer your Chrome with takeover; state limits at cookie-copy approval. |
| A share link leaks | Fragment secret, required expiry, tab-scoped capabilities, revocation, no credentials or CDP for shares. |
| Extension updates are disruptive | A thin extension and a versioned protocol (§12a): releases accept protocols N and N−1, changes are batched per milestone, and GitSpace says when an update is required. |
| Copied cookies are a copy of your identity | Per-site approval each time, expiry, vault sealing, audit; never whole-browser. |

## 16. Open questions

1. Does the session viewer need pointer presence for several people at once in V1, or one controller plus observers?
2. Is the 20-minute recording cap right, and where do recordings count against storage?
3. Should a share's `control` capability ever allow filling a credential (it does not in this draft)?
4. Machine-hosted headless Chromium: which milestone, now that the cloud browser can reach services directly?
5. When does Aperture's API become public for Zerbly, and does the relay move to its own Worker then?

## 17. References

- `docs/APERTURE-DRAFT.md`: original Aperture draft (Inkibra, 2026-10-02).
- `docs/CUA-INTEGRATION-DESIGN.md`: desktops; shared vocabulary (grant, lease, takeover, recording, realm).
- `docs/SIMPLIFICATION.md`: rules for reads, live updates and checks.
- Playwriter: https://github.com/remorses/playwriter (README; `docs/remote-access.md`; skill recorder docs; `playwriter/src/cloud-scope.ts` for cookie copy).
- Cloudflare Browser Run (formerly Browser Rendering): CDP endpoint, Live View, limits and pricing.
- Chrome extension APIs: `chrome.debugger`, `chrome.tabGroups`, `chrome.tabCapture`.
