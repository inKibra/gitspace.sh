> Original draft as written on 2026-10-02, kept for reference. The plan GitSpace follows is `docs/APERTURE-DESIGN.md`.

Aperture — Browser Access, Collaboration, and Agent Capability Platform

Status: Draft
Date: October 2, 2026
Owner: Inkibra
Audience: GitSpace, Zerbly, and platform engineers
Working name: Aperture

1. Summary

Aperture is a standalone browser platform that allows humans and agents to securely share, control, observe, record, and collaborate through real browser sessions.

Aperture is not owned by GitSpace or Zerbly. It is a shared Inkibra platform capability consumed by both, while also supporting arbitrary third-party agents and people through capability URLs.

The core system consists of:

* a Chrome extension attached to Chrome through CDP;
* an outbound relay connection to Cloudflare;
* scoped grants for sharing tabs, windows, or browsers;
* first-class integrations for GitSpace and Zerbly;
* universal share links that arbitrary agents can understand;
* a Playwright-compatible interface over CDP;
* a faster agent-native execution path inspired by jev-ultrafast;
* native WebMCP discovery plus synthetic/learned site capabilities;
* remote human viewing and takeover;
* literal video recording;
* workflow/skill recording;
* preference discovery from explicitly enabled browsing sessions;
* collaborative site-review sessions, annotations, and visual CSS proposals;
* a credential manager available only within a persistent trusted operator relationship.

Computer Use and Terminal Use are possible future siblings of Aperture but are explicitly out of scope for this project.

⸻

2. Motivation

Browser agents have several related problems that are currently solved independently.

First, browser automation typically assumes the agent owns or launches the browser. We instead want agents to operate browsers that real people are already using, including their authenticated browser state.

Second, sharing browser access is cumbersome. A user should be able to click Share tab, copy a URL, and send it to an agent without configuring tunnels, ports, OAuth applications, or an MCP server.

Third, generic browser automation is inefficient. Agents repeatedly inspect pages, reason about selectors, perform individual actions, and wait for state changes even when a site exposes richer semantic interfaces or when a workflow has already been learned.

Fourth, humans and agents need to collaborate within the browser. A user should be able to demonstrate workflows, point at UI, leave comments, visually propose changes, take control when an agent gets stuck, and hand control back.

Finally, browser authentication creates an identity problem. An agent may operate using the human’s existing session, use credentials explicitly delegated by an operator, or use accounts owned by the agent itself. These cases must remain clearly separated.

Aperture provides one abstraction for all of these cases.

⸻

3. Goals

Aperture should:

1. Allow a user with the extension installed to share a tab, window, or browser with an agent through a revocable capability URL.
2. Support arbitrary people using the extension for ad-hoc sharing, without requiring them to become trusted operators.
3. Support a persistent trusted relationship with an operator’s browser for GitSpace and Zerbly Constructs.
4. Let the browser owner watch the agent, take control, complete an interaction, and return control to the agent.
5. Provide both a Playwright-compatible automation surface and a faster agent-native browser-use surface.
6. Prefer semantic browser operations over pixel-level automation whenever possible.
7. Discover and invoke native WebMCP tools.
8. Support Aperture-defined site capabilities when native WebMCP is unavailable.
9. Record browser workflows and convert them into reusable skills.
10. Record explicitly approved browsing sessions for preference discovery.
11. Capture both positive and negative preference signals.
12. Record literal tab video.
13. Support persistent multi-person site-review sessions with comments and annotations.
14. Support lightweight Figma-like visual CSS modification and review.
15. Provide source-code grounding when Aperture is being used on a GitSpace-controlled preview.
16. Allow credentials to be securely used without exposing plaintext secrets to an agent.
17. Make a shared URL useful to first-party Inkibra agents and generic third-party agents.

⸻

4. Non-goals

V1 will not:

* implement general Computer Use;
* implement Terminal Use;
* provide remote desktop access outside the browser;
* attempt to create provider-specific identities such as Google service accounts as a universal identity mechanism;
* provide a credential manager to ad-hoc browser-sharing users;
* expose plaintext credentials to model context;
* implement a complete Figma-class design editor;
* provide unrestricted arbitrary JavaScript execution as the default agent API;
* require sites to install Aperture SDKs for ordinary browser sharing;
* require every external agent to implement an Aperture-specific client.

⸻

5. Core concepts

5.1 Browser connection

A BrowserConnection represents one Chrome installation connected through the Aperture extension.

There are two trust modes:

BrowserConnection
├── trusted_operator
└── ad_hoc

A trusted operator connection is persistent and belongs to an authenticated Inkibra operator.

An ad-hoc connection exists because someone installed the extension and shared a resource. It does not imply any broader trust relationship.

5.2 Browser resource

A grant may expose:

tab
window
browser

These are independent from browser trust.

For example, an operator may expose only one tab from a trusted browser, while an external collaborator may explicitly share an entire browser through an ad-hoc connection.

5.3 Browser grant

A BrowserGrant identifies:

subject
browser connection
resource scope
allowed capabilities
expiration
revocation state

Capabilities may include:

observe
navigate
input
playwright
browser_use
webmcp
record
comment
takeover

A grant is the authority boundary. Simply knowing that a browser exists provides no authority.

5.4 Control lease

Browser grants and browser control are distinct.

At any instant there should be one active writer:

agent control
OR
human takeover

When a human takes over, agent input capability is mechanically suspended rather than merely instructing the model not to interact.

⸻

6. User modes

Aperture should expose a small number of understandable modes rather than exposing the underlying implementation concepts.

Share

Share the current tab, window, or browser.

Produces either a direct first-party grant or a capability URL.

Use

Allow an agent to operate the browser.

The preferred interface is task-level:

await aperture.use(
  "Find the order I placed last Tuesday and tell me its status."
)

Lower-level Playwright access remains available.

Capture

Capture has three distinct operations:

Record Video
Record Skill
Learn Preferences

These should remain separate because they produce different artifacts.

Review

Start or join a collaborative review session.

Review includes:

* point/select;
* comments and replies;
* arbitrary-area annotations;
* visual change proposals;
* before/after comparison;
* source grounding when available.

Take Over

Allow a human to watch or assume control of the current live browser state and later hand it back to the agent.

⸻

7. High-level architecture

                    ┌─────────────────────────┐
                    │      Agent / Human      │
                    └────────────┬────────────┘
                                 │
                 ┌───────────────┴────────────────┐
                 │                                │
          Aperture native API               Share URL
        GitSpace / Zerbly SDK          Web / MCP / WebMCP
                 │                                │
                 └───────────────┬────────────────┘
                                 │
                       Capability Gateway
                                 │
                    Cloudflare Worker / DO
                                 │
                 outbound persistent connection
                                 │
                    ┌────────────▼────────────┐
                    │    Aperture Extension   │
                    └──────┬─────────┬────────┘
                           │         │
                         CDP    chrome.tabCapture
                           │         │
                           ▼         ▼
                         Chrome    MediaStream

The extension never requires an inbound network connection.

For remote sessions, it establishes outbound connections to Aperture infrastructure.

Cloudflare Durable Objects are a good match for the relay because they support long-lived WebSockets and WebSocket hibernation while preserving connection state. (Cloudflare Docs)

⸻

8. Chrome integration

Decision: CDP is the canonical browser-control protocol

The extension attaches to Chrome using chrome.debugger, which provides extension access to Chrome DevTools Protocol domains including DOM, Accessibility, CSS, Network, Runtime, Input, Page, Storage, Target, and others. (Chrome for Developers)

CDP is therefore the underlying browser-control plane.

Aperture should not require Chrome to be launched by Playwright or with a remote-debugging flag.

Playwright sits above CDP

Aperture should provide a Playwright-compatible interface by connecting Playwright to the Aperture CDP bridge.

Conceptually:

const browser =
  await aperture.playwright.connect(grant);

Playwright supports attaching to existing Chromium browsers through CDP, although Playwright documents that CDP connections have lower fidelity than its native Playwright protocol. We accept this limitation because Aperture owns the browser through CDP rather than asking Playwright to own the browser lifecycle. (Playwright)

Playwriter is useful prior art here: its extension attaches through chrome.debugger, relays CDP, and allows agents to interact with a real Chrome session without relaunching Chrome. Its remote-control flow also demonstrates one-click sharing of a specific existing tab through a secret link. (Playwriter)

⸻

9. Agent execution stack

Raw Playwright should not be the default interface for first-party agents.

Aperture should choose the highest-level available mechanism:

Native WebMCP
       ↓
Known site capabilities / recorded skills
       ↓
Jev-style browser use
       ↓
Playwright
       ↓
restricted raw CDP

This is not strictly a fallback chain: an execution can combine mechanisms.

9.1 Native WebMCP

Aperture should discover WebMCP tools exposed by the active site and make them available to the agent.

Chrome’s WebMCP API allows pages to register typed tools through document.modelContext.registerTool() and allows authorized consumers to discover them through getTools(). (Chrome for Developers)

A page-context bridge in the extension should:

1. discover currently available tools;
2. normalize their schemas;
3. expose them through Aperture;
4. invoke them inside the authenticated browser page.

9.2 Synthetic site capabilities

Aperture should eventually support semantic site adapters even when the site does not publish WebMCP.

Sodium is useful prior art for defining site actions as typed tools backed by existing page behavior. Its model uses a declarative site contract to convert site capabilities into WebMCP tools. (Sodium)

Aperture’s version differs because it must support sites that have not installed Aperture or Sodium.

Synthetic capabilities may come from:

* manually authored site adapters;
* recorded skills;
* generalized browser workflows;
* stable semantic page structures.

This should initially remain separate from native WebMCP so provenance is clear.

9.3 Jev-style accelerated browser use

Aperture should incorporate the main ideas from browser-use/jev-ultrafast.

The important architectural characteristics are:

* one compact structured observation per decision cycle;
* visible semantic content rather than full-page text;
* references to observed DOM nodes rather than model-generated selectors;
* freshness checks before execution;
* occlusion/geometry checks before input;
* minimal browser/model round trips;
* screenshots only when useful rather than as the default representation.

jev-ultrafast currently uses one request per decision cycle and one browser call per structured snapshot, while revalidating targets before interaction. (GitHub)

We should reuse or adapt these ideas rather than force the main Construct or GitSpace agent to micromanage every browser action.

The extension-side runtime should expose something approximately like:

observe(): BrowserObservation
act({
  observationId,
  targetId,
  operation,
  arguments
}): ActionResult

A target ID refers to an element from a specific observation. It is not an arbitrary selector generated by a model.

This also reduces WAN latency because expensive DOM inspection occurs locally and produces one compact response.

9.4 Playwright

Playwright remains the general-purpose escape hatch.

It is important for:

* compatibility with existing agent software;
* debugging;
* complex browser operations not yet represented semantically;
* arbitrary scripts produced by trusted first-party software.

Playwright-over-CDP is powerful but should not define the core permission system.

⸻

10. Sharing and remote access

10.1 Ad-hoc tab sharing

Any person with the extension can:

Share tab
→ confirm access
→ copy capability URL

The recipient does not need to be a Zerbly Construct or GitSpace agent.

The share terminates when:

* the user revokes it;
* its expiration is reached;
* the underlying browser resource disappears;
* policy invalidates the grant.

Playwriter’s remote-control implementation is useful prior art: the extension creates remote access to a selected tab, the secret lives in the URL fragment, and revocation immediately invalidates the share. (Playwriter)

Aperture should adopt the fragment-secret approach:

https://aperture.example/s/<public-id>#<secret>

The secret is not included in the initial HTTP request.

The landing page redeems the fragment for a short-lived capability/session token.

10.2 Window/browser sharing

The same model should support a larger scope:

tab
window
browser

Sharing an entire browser is explicitly more powerful and must have a stronger confirmation UI.

The grant should specify whether the agent may:

* access already-open tabs;
* open new tabs;
* close tabs;
* create windows;
* navigate existing tabs.

10.3 Persistent operator browser

The operator may enroll a browser as a persistent Aperture connection.

This enables:

* reconnectable browser access;
* long-lived Construct grants;
* credential-manager integration;
* durable browser workspaces;
* operator takeover from another device.

Enrollment is a trust relationship, not merely a larger browser share.

⸻

11. Universal capability URLs

A core product requirement is:

A user should be able to send an Aperture link to an arbitrary agent and the agent should be able to determine how to use it.

The share landing page serves several audiences simultaneously.

Human

Show:

* who/what shared the resource;
* whether it is live;
* what is being shared;
* view/takeover controls when authorized;
* security disclosure.

First-party Inkibra agent

GitSpace and Zerbly recognize the URL and redeem it directly into a native BrowserGrant.

WebMCP-aware browser agent

The landing page registers tools describing the remote browser capability.

For example:

browser_observe
browser_use
browser_click
browser_type
browser_list_tools
browser_call_tool

MCP-capable client

Each share may expose a scoped remote MCP endpoint.

Conceptually:

/share/<id>/mcp

The MCP surface exposes only the capabilities present on the grant.

Generic browser agent

The page remains human- and machine-readable and explains that it represents a remotely shared browser resource.

There is currently no universal web standard saying that an arbitrary HTML URL should automatically resolve to an MCP server. Aperture may define its own discovery metadata, but that metadata must be treated as an Aperture convention rather than an MCP standard.

⸻

12. Human takeover

Human takeover is a first-class control transition, not an exceptional debugging mode.

Flow:

Agent operating
      ↓
authentication / ambiguity / approval required
      ↓
request_operator()
      ↓
operator receives takeover link
      ↓
agent writer lease suspended
      ↓
operator watches / controls
      ↓
operator hands back
      ↓
agent re-observes current state

The operator should also be able to initiate takeover without waiting for an agent request.

Takeover applies to both:

* trusted operator browser connections;
* ad-hoc shares.

The difference is credential access, described below.

⸻

13. Credential management

13.1 Security boundary

Credential management is available only on a persistent trusted operator browser connection.

It is not enabled merely because someone shares an entire browser.

Therefore:

trusted operator + one tab
    → credential manager eligible
trusted operator + browser
    → credential manager eligible
ad-hoc user + one tab
    → no credential manager
ad-hoc user + browser
    → no credential manager

An ad-hoc user may still manually authenticate while controlling the browser.

13.2 Credential ownership

Credentials have exactly one owner:

operator credential
OR
construct credential

Examples:

operator/bradley/notion
construct/fred/notion

The namespaces must never be ambiguous.

13.3 Secrets are capabilities, not data returned to agents

Agents never receive:

credentials.getPassword(...)

They receive operations such as:

credentials.fill({
  credential,
  browserSession,
  origin
})

or:

authenticate({
  service: "notion",
  identity: "operator"
})

The credential broker performs the actual secret injection.

13.4 Credential grant

An operator credential is not automatically available to every Construct.

A CredentialGrant includes:

subject
credential
allowed origin(s)
allowed browser realm
duration
use policy

Every use is authorized at execution time.

Authorization is effectively:

Construct
× Credential
× Credential owner
× Browser realm
× Origin
× Grant

13.5 Preventing cross-person credential use

A browser connection belongs to a credential realm.

Example:

Bradley's trusted Chrome
credential realm = operator/bradley

If Fred has a grant to Bradley’s Notion credential, that does not permit Fred to inject it into a browser shared ad-hoc by Alice.

Ad-hoc connections have:

credential realm = NONE

and stored credential injection is rejected.

13.6 Saving credentials during takeover

Credential capture should only be initiated:

* during explicit operator-controlled takeover; or
* from an explicit Aperture Credential Manager UI.

Never because an agent silently decides to capture a credential.

During takeover on an enrolled operator browser:

Sign in
[ Sign in only ]
[ Sign in and save to Aperture ]

After successful save:

Allow Fred to use this credential?
[ Just this time ]
[ This session ]
[ Persistently on notion.so ]
[ Do not allow ]

Saving a credential and delegating it are separate decisions.

If the operator uses an existing OS/browser password manager, Aperture should not assume it can recover the password afterward. The result may simply be an authenticated browser session.

⸻

14. Video recording

Aperture should support literal tab recording independent of browser automation traces.

Chrome’s tabCapture API provides an audio/video MediaStream for a user-approved active tab and maintains capture across page navigation until the stream or tab closes. (Chrome for Developers)

Initial implementation:

chrome.tabCapture
      ↓
MediaStream
      ↓
MediaRecorder
      ↓
WebM recording

Recording should optionally include tab audio.

A recording also receives a synchronized semantic event timeline:

timestamp
navigation
element exposure
click
input
browser action
comment
skill-record event
preference observation

This makes recordings useful for debugging, training, review, and preference evidence.

Live remote viewing may initially use the existing control-channel/screencast mechanism. If bandwidth or latency requires it, live media transport can later move to WebRTC without changing the grant model.

⸻

15. Skill recording

Skill recording learns how a task is performed.

A user enables recording and performs a workflow.

Aperture records semantic operations rather than only coordinates:

navigation
element identity
accessible name
DOM context
form values
site state transitions
relevant network/state signals
assertions

The result should be converted into a reusable skill representation.

A skill is not intended to be brittle RPA.

Execution should:

1. attempt the known workflow;
2. validate state at each important boundary;
3. use the accelerated browser-use policy when the page differs;
4. repair or generalize the workflow when appropriate.

Recorded skills may also become candidate synthetic site tools.

⸻

16. Preference discovery

Preference recording learns what the user values, rather than how a workflow is performed.

It is an explicit mode:

Learn Preferences: ON
Site: rei.com

It should be opt-in by site/session.

16.1 Observation model

Aperture should record a choice funnel:

Exposure
→ Attention
→ Evaluation
→ Action
→ Outcome

Signals include:

* result entered viewport;
* result remained visibly available;
* user ignored it;
* user opened it;
* user inspected details;
* user compared it;
* user returned to the result list;
* user added it to cart;
* user removed it from cart;
* user purchased or selected it.

16.2 Negative signals matter

Failure to select an option is useful only when Aperture has evidence that the user actually had a reasonable opportunity to choose it.

Therefore:

not clicked

alone is not a negative signal.

But:

visible for meaningful period
+ neighboring options inspected
+ option skipped

may be.

Likewise:

opened
+ specifications inspected
+ returned without selecting

is stronger evidence of rejection.

Preference inference should reason over choice sets, not isolated clicks.

Example:

considered: A, B, C, D
inspected:  A, C, D
rejected:   A, C
selected:   D
ignored:    B

The learner then asks what attributes best explain D winning relative to the alternatives.

16.3 Preference lifecycle

Preference data should have stages:

observed behavior
      ↓
tentative inference
      ↓
repeated / confirmed preference

A single session should not automatically create strong permanent claims about the user.

⸻

17. Collaborative review sessions

Aperture should support persistent site-review sessions independent of a particular live browser connection.

A review contains:

target site / deployment / revision
participants
comments
annotations
visual proposals
before/after evidence
implementation status

Multiple people and agents may participate.

External collaborators do not receive credential-manager access merely because they joined the review.

17.1 Annotation grounding

An annotation should capture enough information to survive ordinary page changes:

URL
element selector candidates
ARIA identity
visible text
bounds
screenshot/crop
DOM context
revision

When available on a GitSpace-controlled application:

React component
component stack
source file
source line
workspace / commit

React Grab is useful prior art for translating rendered React elements into source context for coding agents. (React Grab)

17.2 Visual modification

Review mode should provide lightweight visual editing:

* spacing;
* dimensions;
* typography;
* colors;
* borders;
* radius;
* simple flex/grid alignment;
* text changes.

Changes are stored as structured proposals, not silently written to production.

Example:

Proposal
  target: pricing card
  padding: 16px → 24px
  heading margin-bottom: 8px → 12px
  desktop only

Several alternatives may coexist.

V1 does not need synchronous Figma-grade multiplayer editing.

17.3 GitSpace implementation

For GitSpace previews:

visual proposal
      ↓
source grounding
      ↓
GitSpace agent
      ↓
real code modification
      ↓
preview refresh
      ↓
proposal overlay disabled
      ↓
visual verification

The agent should translate the desired visual result into the project’s existing styling conventions rather than blindly paste generated CSS.

⸻

18. Storage and persistence

The relay and artifact system should distinguish ephemeral browser traffic from explicitly persisted artifacts.

Ephemeral

By default do not persist:

* CDP command payloads;
* raw DOM snapshots;
* remote-control traffic;
* transient browser observations.

Persisted when requested

Persist:

* BrowserConnection metadata;
* grants and audit records;
* review sessions;
* comments;
* visual proposals;
* recorded skills;
* preference observations/inferences;
* saved credentials;
* explicit video recordings.

Recorded artifacts should have clear retention and deletion semantics.

⸻

19. Security invariants

The following are design invariants:

1. Browser ownership does not imply agent access.
2. Agent access is always represented by an explicit grant.
3. Credential-manager eligibility derives from trusted browser enrollment, not from share size.
4. Ad-hoc browser shares never gain stored credential access.
5. Every credential has exactly one owner.
6. Plaintext credential secrets are never returned to agents.
7. Credential use is reauthorized at fill time.
8. Credential use is origin-scoped.
9. Operator credentials require explicit Construct delegation.
10. Browser credential realm is checked before any credential injection.
11. Human takeover suspends agent write access.
12. Sharing and takeover are independently revocable.
13. Recording requires explicit user action.
14. Preference learning is explicitly enabled and scoped.
15. A tab share must not silently expand into a browser-wide grant.
16. High-risk raw CDP access must be distinguishable from safer semantic browser-use access.
17. Credential use, grant changes, takeover, and other privileged actions are audited.

⸻

20. Repository structure

Aperture should live in a standalone repository and be represented as its own GitSpace project.

Suggested initial structure:

aperture/
├── extension/
│   ├── cdp/
│   ├── webmcp/
│   ├── capture/
│   ├── review/
│   └── ui/
│
├── runtime/
│   ├── observation/
│   ├── execution/
│   ├── playwright/
│   └── jev/
│
├── relay/
│   ├── durable-objects/
│   ├── grants/
│   └── sessions/
│
├── protocol/
│   ├── browser/
│   ├── sharing/
│   ├── takeover/
│   └── credentials/
│
├── agent/
│   ├── use/
│   ├── skills/
│   └── preferences/
│
├── review/
│   ├── annotations/
│   ├── proposals/
│   └── source-grounding/
│
├── credentials/
│
├── sdk/
│   ├── typescript/
│   ├── gitspace/
│   └── zerbly/
│
└── web/
    └── share-landing/

This structure is illustrative rather than prescriptive. Packages should be split according to deployment boundaries once implementation begins.

⸻

21. Proposed milestones

M0 — Browser transport

Build the smallest complete remote-browser loop.

Deliver:

* Chrome extension;
* CDP attachment through chrome.debugger;
* Cloudflare Durable Object relay;
* outbound extension connection;
* tab grants;
* capability URL creation/revocation;
* first-party SDK;
* basic remote observe/input;
* Playwright-over-CDP proof of concept.

Exit criterion:

A GitSpace/Zerbly agent and a generic remote client can operate an explicitly shared real Chrome tab without local port forwarding.

M1 — Browser runtime

Deliver:

* structured local observations;
* stable target references;
* freshness/occlusion validation;
* Jev-style high-level browser.use(task);
* native WebMCP discovery/execution;
* browser/window scope;
* remote live viewing;
* human takeover and hand-back.

Exit criterion:

First-party agents normally operate at the task/semantic level instead of manually issuing Playwright actions.

M2 — Capture

Deliver:

* literal tab video recording;
* synchronized browser event timeline;
* skill recording;
* reusable skill execution;
* initial synthetic site capabilities;
* preference-recording mode;
* exposure/attention/action tracking;
* tentative preference extraction.

Exit criterion:

Aperture can learn both reusable procedures and user preferences from explicit browser sessions.

M3 — Collaboration

Deliver:

* persistent review sessions;
* multi-person comments/replies;
* element and region annotation;
* screenshots and before/after evidence;
* basic visual CSS proposals;
* React/source grounding on supported GitSpace previews;
* handoff of approved changes to GitSpace agents.

Exit criterion:

A human can review a live product, visually express a change, discuss it with other humans/agents, and hand an approved proposal to a coding agent without leaving the browser workflow.

M4 — Trusted operator credentials

Deliver:

* persistent operator-browser enrollment;
* encrypted credential vault;
* operator-owned and Construct-owned credentials;
* manual-takeover credential capture;
* credential grants;
* origin + browser-realm enforcement;
* secure fill;
* credential audit log.

Exit criterion:

A Construct can authenticate using explicitly delegated credentials without learning their plaintext value or being able to inject one person’s credential into another person’s browser.

V1 complete

Aperture V1 is complete after M0–M4 are production-capable for Chrome.

Other browsers, Computer Use, Terminal Use, sophisticated visual editing, and broader credential-provider integrations are post-V1.

⸻

22. Important alternatives rejected

Put Aperture inside GitSpace

Rejected because Zerbly Constructs, external agents, and arbitrary external extension users are independent consumers.

Aperture is a platform primitive, not a GitSpace subsystem.

Make Playwright the browser ownership layer

Rejected.

Aperture needs to attach to an already-running real browser, preserve existing state, work through an extension, and control what gets exposed remotely.

CDP is the underlying ownership layer; Playwright is a compatibility interface.

Pixel-first browser use

Rejected as the default.

Screenshots remain valuable for visual reasoning, but semantic DOM/accessibility state, WebMCP, recorded capabilities, and local browser inspection should be preferred when possible.

Provider-specific agent identities

Rejected as the general solution.

Provider-specific mechanisms such as Google service accounts may occasionally be useful, but Aperture must work consistently across arbitrary websites.

Credential manager for every extension user

Rejected.

Credential management requires a durable trusted relationship and creates significantly greater risk than temporary browser sharing.

Automatically record all user browsing for preferences

Rejected.

Preference learning must be an explicit site/session mode.

⸻

23. Open questions

The implementation should resolve the following during M0–M2:

Browser scope semantics: Does “share browser” include future tabs automatically, or only tabs explicitly attached at grant creation?

Raw CDP exposure: Should arbitrary capability-link recipients ever receive raw CDP, or only first-party/trusted clients?

Generic-agent discovery: What machine-readable convention should advertise the remote MCP endpoint from a normal Aperture share URL until/if a standard emerges?

Live media: Is the initial CDP/video channel sufficient for remote watching, or should live viewing use WebRTC from the start?

Synthetic site tools: What representation should Aperture use for learned/site-specific semantic tools, and how much should align with WebMCP contracts?

Skill format: Should skills primarily be procedural graphs, executable code, SKILL.md-style instructions, or a combination?

Preference storage: What confidence/confirmation threshold promotes a tentative observation into durable agent memory?

Source grounding: Should GitSpace instrument previews at build time, use source maps/runtime React inspection, or support both?

Credential backend: Build a first-party encrypted vault first or define the provider interface and support third-party credential providers from the beginning?

Extension permissions: Which powerful permissions should be optional and requested only when a feature is first activated?

⸻

24. Success criteria

Aperture succeeds if the following experiences become routine:

Share: A person clicks the extension, shares a tab, sends one link, and an agent begins working.

Use: A Construct says browser.use("...") rather than implementing a long sequence of brittle browser actions.

Takeover: An agent gets blocked by authentication, the human opens a link, takes over the same browser state, completes the interaction, and hands it back.

Teach: A person performs a browser workflow once and Aperture produces a reusable skill.

Learn: A person intentionally enables preference recording while shopping or browsing, and their agent learns both what they chose and what exposed alternatives they rejected.

Review: Several humans and agents can discuss a live site, point at exact UI, propose visual changes, and convert approved changes into code.

Interoperate: A non-Inkibra agent receiving an Aperture capability URL has a path to understand and operate the shared browser without bespoke manual setup.

⸻

25. Prior art and references

Playwriter: strongest reference for extension-based CDP attachment, Playwright-over-CDP, outbound remote access, tab capability links, and revocation semantics. (Playwriter)

browser-use/jev-ultrafast: strongest reference for low-round-trip semantic observation and validated DOM-target execution. (GitHub)

Chrome WebMCP: native typed browser tools exposed by websites and discoverable/executable within the browser. (Chrome for Developers)

Sodium: useful reference for describing existing website capabilities as declarative WebMCP tools. (Sodium)

React Grab: useful reference for pointing from rendered UI into React/source-code context and for prior visual-edit experimentation. (React Grab)

Chrome extension APIs: chrome.debugger for CDP and chrome.tabCapture for explicit tab audio/video capture. (Chrome for Developers)

Cloudflare Durable Objects: relay/control-plane primitive for long-lived stateful WebSocket relationships. (Cloudflare Docs)