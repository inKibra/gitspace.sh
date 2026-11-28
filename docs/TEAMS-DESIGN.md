# Teams — Design Doc

> **Status: design, decided 2026-11-25, revised 2026-11-28.** Nothing here is built. The locked visual reference is the
> clickable mock in `packages/account-web/src/teams-mock/` (entry `mock-teams.html`; see its README). It uses an
> invented team, Crumb & Co, with projects Crumb, Ledger and Field notes. Where this doc and the mock name a page, field
> or refusal, they use the same words. The project environment (Instructions, machine profiles, approved scripts, CI
> shown at Review) is in `ENVIRONMENT-DESIGN.md`; projects with several repositories are in `MULTI-REPO-DESIGN.md`.

Today a GitSpace account is one person: every check that matters is `userId === env.ACCOUNT_ID`, and the account's
`USER_*` objects are keyed by the account. Teams turns an account into a **team**: several **principals** act inside
it, each with roles that decide what they may do, and every action records who did it.

## 1. The model

- **An account is a team.** A company may run several team accounts on one deployment.
- **Principals** are what acts in an account. Three kinds:
  - **person**: someone invited into the team;
  - **bot**: an identity an Admin or Owner creates and sponsors (section 10);
  - **system**: GitSpace itself (automations, the team's Slack bot, the GitHub App), as today.
- **A person in two teams is two users**, one per account. Their personal resources are per account too.
- **No guests in v1.** Everyone joins through the team's allowed email domains (section 3). The role model leaves room
  to add an external role later without changing stored data.
- **A passkey is required to create any identity**: joining as a person, or creating a bot.
- **One GitHub App per account** (section 11).

## 2. Navigation and information architecture

There are two kinds of place:

- **The app shell** holds work and live state.
- **Settings** is configuration. It is a full page that replaces the sidebar, with a **"← Back to work"** button that
  returns to the exact screen you left.

### Sidebar

The sidebar's top row has nine icons, in this order:

1. **Board.** Its **Needs you** column is the Inbox, which absorbed Monitoring.
2. **Projects:** a grid of cards with health; a card opens the project overview.
3. **People:** presence, with a page per person (section 4).
4. **Services:** workspace services reached through the relay, deployed sites and previews, and share links.
5. **Machines**, 6. **Browsers**, 7. **Sessions**, 8. **Usage:** live monitoring dashboards with stats strips,
   sparklines, browser thumbnails and timelines.
9. **Settings.**

Removed from the row: Inference, Plugins, Skills, Secrets, Monitoring, Automations. Their configuration moved into
Settings and Project settings; their live state moved to the dashboards and Needs you.

### Settings

- **"Settings for" picker** at the top of the nav: you, then each bot you may manage (bots you sponsor; every bot for
  Owners and Admins). It switches the personal section between you and that bot. It is hidden when you manage no bots.
- **The personal section**, for you: Profile, Git identity, Voice, Defaults, Inference, Plugins, Skills, Machines,
  My secrets, My approved scripts, Passkeys and devices, MCP clients. For a bot, see section 10.
- **The team section**, titled with the team's name ("Crumb & Co"): People & roles, Bots, Inference, Plugins, Skills,
  Machines, Machine profiles, Secrets, Approved scripts, Projects, Domains, Source & releases, GitHub App, Audit log
  (Owners and Admins only).
- **Scope comes from placement in the nav.** Each item lives in exactly one scope and no list mixes scopes. The earlier
  **Team | Mine | someone ▾** switch is removed.
- **Someone else's pages** are reached from **People › person**: read-only, with **Revoke** (section 5).
- **Every Settings action is a real dialog or wizard**, built from account-web's Dialog components with a step
  indicator. The mock's `flows/` folder is the reference for each one.

### Project settings

A full page with **"← Back to <project>"**. Sections: **Members, Repositories, Inference, Plugins, Secrets,
Environment, Automations.** Repositories is described in `MULTI-REPO-DESIGN.md`, Environment in
`ENVIRONMENT-DESIGN.md`.

**The team owns, the project enables, you bring your own.** The one merged view is the workspace's environment popover,
where every line is badged Team, Project or the person's name.

## 3. Joining and account roles

- **By invite only.** An invite names an email, an account role and a project role per project.
- **Allowed email domains:** an account setting (Owners and Admins) lists the domains invites may go to. An invite to
  any other domain is refused with that reason.
- **No SSO in v1.** A person's identity is GitSpace's own stable user id, never an identity provider's object id, so an
  OIDC sign-in can be added later as one way to prove who someone is.
- Joining enrolls the person's browser with a passkey, as today.

Account roles are fixed and govern **only the account's own pages**. Everything inside a project is governed by project
roles. **Owners count as Admins in every rule** in this doc.

| Role | May |
|---|---|
| **Owner** | Everything, including billing, integrations, and making, changing or removing Owners. The last Owner can't be demoted or removed. Owners are implicitly **Lead in every project**. |
| **Admin** | People, invites, allowed domains, bots (and sponsoring them), project roles, inference profiles, team secrets, team machines, browsers and machine profiles, the audit log. Admins **edit roles**. Admins are not implicit members of projects: they **Join project** explicitly, which shows in the member list and the audit log. |
| **Member** | Account pages read-only, and their own personal section. |

## 4. Project roles

- **Visibility:** a project is visible only to its members (Owners see all).
- **Lead** is a fixed role with every permission, including **Manage members**. A Lead can't change an Admin's or an
  Owner's project role. The other roles are editable, and teams can add their own: **Engineer, Designer, Contributor,
  Viewer**, and custom roles.
- The permission matrix, per role:
  - **Workspaces:** create, claim a free workspace, ask a holder for the handle, take over a held workspace, assign
    holders, archive, delete.
  - **Phase moves, per target phase:** move into Plan, Code, Review, Ship. For example only Engineer and Lead may move
    into Code or Ship.
  - **Environment:** edit the project's Instructions and approve environment proposals (Leads; any member may propose,
    see `ENVIRONMENT-DESIGN.md`).
  - **Secrets and connections:** see; edit project secrets; edit project connections. Each is its own permission.
  - **Automations:** propose; enable and pause.
  - **Chatter:** post; pin and rename topics; close topics.
  - **Manage members:** add and remove people in the project and set their project roles.
- **Refusals name the level and the role**: "Your project role in Crumb (Designer) can't move into Code",
  "Your account role (Member) can't edit inference profiles".

### Visibility on live pages

- **Owners and Admins see the whole team. Members see their own, plus their projects'.**
- **Presence** (where someone is, what they are doing) shows only to people who share a project with them. Everyone
  else sees online or offline.
- **Sessions › Everyone** is for Owners and Admins only.
- **Usage:** Members see team totals plus their own.
- **Browsers:** a project's Leads may take over or stop browser tabs in their projects.
- **Share links** can be revoked by the sharer, Owners, Admins and the project's Leads.
- **Machines:** a project's Leads see that project's team MCP servers (section 13).

### Needs you

Needs you is the Board's first column and the Inbox. Beyond what it carries today (questions, approvals, handle
requests), it receives:

- **Failed automation runs**, sent to Owners, Admins, the project's Leads and whoever enabled the automation, with
  "Enabled by …" on the row. Today a failed run notifies nobody.
- **Environment proposals**, approved-script approvals and forwarded refusals, machine-profile approvals, a sponsor's
  per-use approvals for their bot's secrets, and interactive script prompts (sections 12 and 14,
  `ENVIRONMENT-DESIGN.md`).
- **Budget alerts** (section 15, not built yet).

## 5. People

**People** in the sidebar shows every person and bot with presence, as visibility allows (section 4). A **person page**
shows their roles, projects, and what they are working on (to people sharing a project).

From a person page, Owners and Admins (and a sponsor for their own bot) open that principal's settings pages
**read-only**:

- **They see** what is connected (providers, connections, machines, browsers, MCP clients, devices), its status, last
  use, the projects that use it, and usage and cost.
- **They can revoke:** disconnect a connection, sign out a provider, unpair a machine or browser, revoke an MCP client
  or a device, revoke a secret's open shell. Each revoke is in the audit log and the person is told ("Theo
  disconnected your Slack"). This is how offboarding and "revoke active sessions" work.
- **They never** see secret values or tokens, use the person's resources, connect anything in their name, or edit their
  profile.
- **Project Leads** have no access to people's pages beyond presence; they see the effect in their project's
  environment popover.

## 6. The handle

The handle says who drives a workspace. It is in v1: it makes several people in one workspace safe, and it anchors whose
resources a turn uses.

- **Several people can hold it at once.** Prompts are labelled by sender.
- **Getting it:** a free workspace can be claimed. A held one: ask a holder (the request reaches the holders' Needs
  you); roles that allow it take over or assign holders.
- **Non-holders** comment and write **notes**. A holder can send a note on to the agent; its writer is credited
  (Co-authored-by on commits that follow from it).
- **Clearing notes:** the writer edits or deletes their note until a holder sends it (deleting leaves no trace). A
  holder **sends** it (it becomes a prompt: "note from Jules, sent by Maya") or **dismisses** it (the writer sees
  "Dismissed by Maya"). A Lead or Owner may delete any note, recorded in the audit log. Sent and dismissed notes stay
  under **Past notes**. Notes don't expire: they survive phase moves and handle changes and close when the workspace is
  archived. No "Clear all".
- **The agent's questions go to the holders.** In a free workspace they go to the project roles that may assign holders.
- **Phase moves and approvals** are checked against the project role of whoever approves them or started the turn.
  Otherwise the agent proposes and a holder whose role allows it accepts. CI never holds a phase move; the pull
  request's checks show where the move is made (`ENVIRONMENT-DESIGN.md`).
- **Leaving:** "Let go" releases the handle. A removed person's work stays; their handles are released.

## 7. Resources: team and personal

| Resource | Team | Personal (you, or a bot) |
|---|---|---|
| Inference providers | Team API keys and cloud accounts (never a subscription) | Your own: a Claude or ChatGPT subscription, your own keys. A bot: its own keys; subscriptions refused |
| Plugins (MCP connections) | Team connections (e.g. Jira with a service-account token, the Slack app), team browsers, team MCP servers on a team machine | Your own sign-ins, Composio links, paired Chrome, MCP servers on your machine |
| Machines | Team machines and the team SSH key | Your machines |
| Skills | Team, on per project | Your own |
| Secrets | Team and project secrets | My secrets; a bot's secrets (section 12) |
| Approved scripts | Team and project libraries | Personal library (section 14) |

- **Machines of any kind at either scope:** a container machine, a cloud VM, or a physical computer.
- **Personal resources are used while their owner holds the handle**, not only in turns they start. Automations and the
  team's Slack bot use team resources only.
- **Inference:** the project's inference profile decides whether holders' own credentials may pay and from which
  providers. With several holders, a **sticky rotation** stays on one person's credential (per workspace and model
  role) until it is out (rate-limited, exhausted, expired, failing), then moves to the holder who has spent least today;
  when all are out, it falls back to the team's credentials. Per-person usage is shown for visibility only.
- **Connections:** any MCP sign-in method works at either level: OAuth with automatic client registration, an OAuth
  client metadata document, a client id and secret registered in advance (Slack's MCP server needs this), or static
  headers and API tokens. When both levels connect the same service, the person's connection wins while they hold.
- **The team's Slack bot** is a team resource: installed once by an Admin from a generated app manifest, it posts
  updates to project channels and answers `@GitSpace`. People's own Slack connections are separate.
- **Personal machines** use the member's own SSH key and GitHub setup, never the team key.

## 8. GitSpace's MCP server, per person

GitSpace's `/mcp` (OAuth, scoped consent, several connections) acts as the account today. With Teams:

- **A person's MCP client acts as that person.** The consent page grants a slice of the person's own permissions
  (projects, capabilities, expiry) through the slice picker; it can never exceed their roles.
- **Attribution names the client:** "Maya via Claude Code".
- **A client shares its person's handle**; its prompts are labelled.
- **Passkey actions stay human:** a client never opens a cleared shell for a secret; that needs the person's passkey
  (section 12).
- **Step-up actions need the person's passkey on every surface.** Changing a project's base branch, archiving or
  deleting a project, and changing a secret's rule ask for a passkey confirmation whether a person starts them in the web
  app or an MCP client asks for them: one security model. In the web app the confirmation follows the click. Over MCP
  the tool call answers with a URL elicitation (as person-only waits do, #245): the person opens the link, sees the
  change, and confirms with their passkey in the browser, which is the only place a passkey works. A client without
  elicitation support gets the same link in the tool result.

## 9. Attribution and audit

Every turn, phase move, approval, comment, note and commit records its principal (and the MCP client, when there is
one). Commits keep the person as author, GitSpace as committer, and Co-authored-by for co-holders and note writers; a
bot is the author of its own commits (section 10). The **Audit log** lists every account and project action with its
principal, filterable by bot and sponsor; Owners and Admins read it.

## 10. Bots

A **bot** is a principal with the **same profile pages as a person**. It replaces today's account integrations (a token
that acts as the whole account): clean cutover, one concept.

- **Sponsor:** an Admin or Owner. Creating a bot needs a passkey, like any identity.
- **Roles:** account role Member at most; project memberships and project roles as for a person. Refusals name the
  bot's role.
- **Pages**, picked with **Settings for** (section 2): Profile, Git identity, Defaults, Inference (its own providers;
  subscriptions refused), Plugins (sign-ins made as the bot), Skills, Machines, **<bot>'s secrets**, **<bot>'s
  approved scripts**, and **Sign-ins**. Not shown for a bot: Voice and step-up (passkeys).
- **Sign-ins:** connected MCP clients and client secrets, each with its slice of projects and capabilities. MCP clients
  are merged in; there is no separate MCP clients page for a bot. Only Owners and Admins create client secrets. A bot's
  sign-ins are scoped like a person's MCP client: the bot's roles are the ceiling, narrowed per client by the slice
  picker.
- **The bot's own credentials are its secrets.** The separate "bot credentials" list is gone.
- **Git:** the bot is the commit author, `<handle>@bots.<team domain>`. It reaches GitHub through the team's App by
  default, or through its own machine-user account with a fine-grained token.
- **Attribution:** "Release bot (sponsored by Theo)" on turns, phase moves, comments and commits.
- **It can hold the handle**, start workspaces, prompt agents, comment and move phases within its role. Agent questions
  in a workspace it holds go to its MCP session, and escalate to its sponsor or the project's Leads if unanswered.
- **No passkey:** a bot never gets a cleared shell. Its secrets reach scripts and browser autofill, or a use its sponsor
  approves with a passkey (section 12).
- **Sponsor gone:** the bot's sign-ins are **blocked, not deleted**, until another Admin takes the bot over. Demoting an
  Admin offers to hand their bots over in the same dialog. A blocked bot's sign-ins expire after 30 days; Admins are
  notified when it is blocked and a week before expiry. Its history stays attributed.

## 11. GitHub access

- **Team default:** the team's GitHub App, through installation tokens. One App per account.
- **Per person:** under **You › Git identity**, a person can connect GitHub by signing in with the App (a user token,
  only where the App is installed), or with a fine-grained token as fallback.
- **Token order for agent commands:** the acting person's App user token, then their fine-grained token, then the App
  installation token. The chosen token also sets `GH_TOKEN` and the git credential helper.
- **Bots:** the App by default, or the bot's own machine-user fine-grained token (section 10).
- **Personal machines** use their owner's own SSH key and GitHub setup, never the team key.

## 12. Secrets

One model replaces the earlier step-up credentials and workspace credentials. Secrets exist at these places:

- **Team secrets** (Settings › Secrets) and **project secrets** (Project settings › Secrets).
- **My secrets:** a person's own.
- **<bot>'s secrets:** a bot's own.
- **Values a project asks each holder for**, which each person sets in My secrets.

**Every secret has a rule:**

- **Who:** account and project role chips.
- **Holding:** "only while holding the workspace".
- **Delivery**, any of:
  - **only to approved scripts**, the default for sensitive secrets (section 14);
  - **browser autofill on named sites:** the browser fills the login form and the agent never sees the value. The
    transcript reads "Filled X on site · value not shown";
  - **a cleared shell for 1–60 minutes with a passkey.** An Admin can forbid the shell per secret. Never for bots,
    which have no passkey;
  - for a bot's secrets, **"the sponsor approves each use with a passkey"**, through the sponsor's Needs you.
- There is no network-secret or proxy delivery.

**Redaction:** known secret values are redacted from command output. This is best effort: values derived from a secret
are not covered. GitSpace claims authority only over secrets it stores.

## 13. MCP servers on machines

Plugins gains a transport **"on <machine>"**:

- **Personal** (on my machine): only my workspaces and agents use it.
- **Team** (on a team machine): projects turn it on per project, and each person uses it within their role. A project's
  Leads see that project's team servers on Machines.
- **Credentials stay on the machine.** A workspace on any machine calls the server through the relay.
- **Host offline:** the server and its tools stay listed, marked **"Unavailable: <machine> is offline"**. Turning on an
  offline server in a project is allowed, after a confirmation.
- **Team servers never take "only while holding" secrets**, since a team server has no holder.
- **The Add-server wizard:** where it runs → how it starts → a test that lists its tools → who can use it.

## 14. Approved scripts

Approved scripts are a library at team, project and personal level: Settings › Approved scripts (the team's, plus the
project and personal ones you can see), My approved scripts, and a bot's approved scripts. Each entry shows its
versions, approver, scope, usage history and **Revoke**.

- **Submitting:** an agent submits a script with its content, the secrets it needs by name, typed inputs (enums or
  patterns, never free text), network destinations, the machine profile it needs, and the prompts it may ask.
- **Approving:** the approval card shows all of that. The approver picks a scope: **For me** (the holder), **For the
  project** (a Lead), or **For the team** (an Admin). Nobody approves a script using a secret they couldn't use
  themselves. A script refused only because of a secret can be forwarded to someone who can approve it.
- **Running:** agents run it by name in the agent's working copy. The approval covers the hash of the script's content
  only; files it calls are the agent's code, by decision. Secrets go only into that process, and its output is
  redacted.
- **Versions:** an edit makes a new version that needs approval while the old one stays in use. Approving a new version
  offers to revoke the old one, checked by default. A version still pending can be edited, which replaces it.
- **Interactive prompts** (code, password, choice, open-a-link) are described in `ENVIRONMENT-DESIGN.md`.

## 15. Budgets (not built yet)

A new feature. Budgets **alert only**; they never stop work. An alert goes to Owners and Admins, plus the person whose
spending crossed it, or the bot's sponsor. Budgets sit with the team's providers under Settings › Inference.

## 16. Build order

Each step ships on its own and is proven on a live account, with old and new code running side by side.

1. **Teams step 1: identity split.** Today a request names the account (`userId`, always `ACCOUNT_ID`) and a device;
   the device id stands in for the person in Chatter authors, journal and inspector actors, lifecycle approvals,
   comments and drafts, and per-person settings (git author, defaults) are account-wide. About 29
   `userId !== ACCOUNT_ID` and 12 `registry.userId` / `config.user_id` checks are real tenancy checks and stay. Step 1:
   - **Principals live in `CredentialVaultDO`**, which already owns the device registry every request checks:
     `principals(principal_id, kind person|bot|system, display_name, …)` and a sparse `device_principal(device_id,
     principal_id)`. Both go into the cached registry snapshot, so a verified device carries `principalId` with no
     extra call.
   - **The first Owner's principal id is the account id.** Every existing `USER_*` object, device, MCP connection
     (`USER_MCP_CONNECTIONS` already keys rows by `principal_id`) and Composio link keeps working with no data moved; a
     device with no mapping row is the owner.
   - **No signed shape changes.** `DeviceInvite`, `ApiKey`, `SignedControlRequest` and machine grants keep `userId` as
     the account id; the principal is resolved server-side. The RPC caller gains `principalId`.
   - **Two helpers** replace direct lookups: per-principal objects (`USER_SETTINGS`, `USER_MCP_CONNECTIONS`, later
     `USER_SKILLS`, personal secrets and scripts) by principal, team objects (`USER_PROJECTS`, `USER_STORAGE`, project
     secrets, the rest) by account. For the owner both resolve to today's names, so old and new code share every object
     during a deploy.
   - **New attribution records principals**; readers accept old device-id values and fall back when a name can't be
     resolved.
   - **Risk:** `UserSettings.profile.handle` doubles as the account's hostname handle (`routeAccountRpc` refuses any
     other host). It moves to account state with one release that writes both and reads the new place first.
2. **Navigation:** the nine-icon sidebar, Settings as a full page with "← Back to work", the "Settings for" picker,
   Project settings as a full page; remove the Team | Mine switch and the removed sidebar entries. Settings actions as
   dialogs and wizards.
3. **People, invites (allowed domains), account roles, project memberships and roles, visibility** on project and live
   pages; People and person pages with read-only views and Revoke.
4. **Attribution and the audit log.**
5. **The handle:** holders, requests, take-over and assign, notes, questions to holders, approvals by role.
6. **Personal resources**, including the inference rotation, and GitHub access per person (token order, `GH_TOKEN`,
   credential helper).
7. **Secrets with rules:** team, project, personal and asked-for values; delivery to approved scripts, browser
   autofill and the cleared shell; redaction. Replaces today's account Secrets and workspace credentials.
8. **Approved scripts** library and approvals (and prompts, per `ENVIRONMENT-DESIGN.md`).
9. **Per-person MCP grants** with the slice picker.
10. **Bots**, replacing account integrations: profile pages, Sign-ins, the bot's secrets with sponsor approval per use,
    commit author, blocked sign-ins when the sponsor goes.
11. **MCP servers on machines** through the relay.
12. **Needs you additions:** failed automation runs and the other new rows.
13. **The team's Slack bot** and pre-registered OAuth clients for MCP connections.
14. **Budgets** (alert only).

## 17. Open questions

Carried from the 2026-11-25 list, each with the suggestion it still carries:

1. Does a new holder inherit the open questions? *Yes.*
2. A limit on handles per person? *No.*
3. Can a permitted non-holder change a workspace's phase? *Only holders, plus Leads.*
4. A phase proposal with several permitted holders: *goes to all; the first accept wins.*
5. The payer changes mid-turn: *usage splits by request; the turn's starter stays its author.*
6. Handle requests: *expire after about a day; cancelled when the asker leaves or every holder lets go.*
7. A per-viewer status ("Waiting on Rina"): *yes.*
8. Header crowding next to the board: *fold the handle's actions into one menu.*
9. Two holders connect the same service: *the turn starter's connection wins.*
10. A removed person's pending invites: *cancelled.*
11. Who gets a handle request for a workspace a bot holds? *Its sponsor.*
12. Who accepts a bot's proposal when only a bot holds the handle? *Any project member whose role allows it.*
13. The role an Admin gets on Join project: *chosen on joining, default Lead.*
14. Can a project's Lead remove a bot from their project, or change its project role, when someone else sponsors it?
    *Yes.*
15. Does creating a bot's client secret need a passkey, as account integrations do today? *Yes.*

New with this revision:

16. Since only Admins and Owners may sponsor a bot, a Member never manages one and never sees the "Settings for"
    picker. Is that intended, or should a Member be able to manage a bot without sponsoring it?
17. How are today's account Secrets and account integrations moved into team secrets and bots: a one-time migration,
    or re-entered by hand?
18. Where budgets are set (per person, per bot, per project, team-wide) and over what period is not decided.
