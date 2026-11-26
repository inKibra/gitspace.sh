# Teams — Design Doc

> **Status: design, decided 2026-11-25.** Nothing here is built. A clickable mock (a fake team, "Crumb & Co") drew
> every page while these decisions were made; it lives outside the repository. Section 12 lists what is still open,
> each with the suggestion it currently carries.

Today a GitSpace account is one person: every check that matters is `userId === env.ACCOUNT_ID`, and the account's
`USER_*` objects are keyed by the account. Teams turns an account into a **team**: several **principals** act inside
it, each with roles that decide what they may do, and every action records who did it.

## 1. The model

- **An account is a team.** A company may run several team accounts on one deployment.
- **Principals** are what acts in an account. Three kinds:
  - **person**: someone invited into the team;
  - **bot**: an identity a person creates and sponsors, acting only over MCP (section 9);
  - **system**: GitSpace itself (automations, the team's Slack bot, the GitHub App), as today.
- **A person in two teams is two users**, one per account. Their personal resources are per account too.
- **No guests in v1.** Everyone in a team joins through the team's own email domain (section 2). The role model leaves
  room to add an external role later without changing stored data.

## 2. Joining

- **By invite only.** An invite names an email, an account role and a project role per project.
- **Allowed email domains:** an account setting (Owners and Admins) lists the domains invites may go to. An invite to
  any other domain is refused with that reason.
- **No SSO in v1.** A person's identity is GitSpace's own stable user id, never an identity provider's object id, so an
  OIDC sign-in (Entra or another provider) can be added later as one way to prove who someone is.
- Joining enrolls the person's browser (passkeys, as today).

## 3. Account roles (fixed)

Account roles govern **only the account's own pages**. Everything inside a project is governed by project roles.

| Role | May |
|---|---|
| **Owner** | Everything, including billing, integrations, and making, changing or removing Owners. The last Owner can't be demoted or removed. Owners are implicitly **Lead in every project**. |
| **Admin** | Team (users, invites, allowed domains, bots), project roles, inference profiles, account connections and credentials, team machines and browsers, the audit log. Admins **edit roles**. Admins are not implicit members of projects: they **Join project** explicitly, which shows in the member list and the audit log. |
| **Member** | Account pages read-only, and their own sections (their providers, connections, browsers, machines, MCP clients). |

Owners and Admins can see other people's machines and browsers while they are in use (section 6).

## 4. Project roles (editable per team)

- **Visibility:** a project is visible only to its members (Owners see all).
- **Lead** is a fixed role with every permission. The others are editable, and teams can add their own:
  **Engineer, Designer, Contributor, Viewer**, and custom roles.
- The permission matrix, per role:
  - **Workspaces:** create, claim a free workspace, ask a holder for the handle, take over a held workspace, assign
    holders, archive, delete.
  - **Phase moves, per target phase:** move into Plan, Code, Review, Ship. For example only Engineer and Lead may move
    into Code or Ship.
  - **Environment:** approve environment (lifecycle) requests.
  - **Secrets, credentials and connections:** see; edit project secrets; edit project credentials; edit project
    connections. Each is its own permission.
  - **Automations:** propose; enable and pause.
  - **Chatter:** post; pin and rename topics; close topics.
  - **Manage members:** add and remove people in the project and set their project roles. Lead has it by default, so a
    project's Lead runs their own project's membership.
- **Refusals name the level and the role**: "Your project role in Crumb (Designer) can't move into Code",
  "Your account role (Member) can't edit inference profiles".

## 5. The handle

The handle says who drives a workspace. It is in v1: it is what makes several people in one workspace safe, and it is
the anchor for whose resources a turn uses.

- **Several people can hold it at once.** Prompts are labelled by sender.
- **Getting it:** a free workspace can be claimed. A held one: ask a holder (the request reaches the holders' Inbox);
  roles that allow it take over or assign holders.
- **Non-holders** comment and write **notes**. A holder can send a note on to the agent; its writer is credited
  (Co-authored-by on commits that follow from it).
- **Clearing notes:** the writer edits or deletes their note until a holder sends it (deleting leaves no trace). A
  holder **sends** it (it becomes a prompt: "note from Jules, sent by Maya") or **dismisses** it (the writer sees
  "Dismissed by Maya"). A Lead or Owner may delete any note, recorded in the audit log. Sent and dismissed notes stay
  under **Past notes** in the panel. Notes don't expire: they survive phase moves and handle changes (a new holder
  inherits them) and close when the workspace is archived. No "Clear all".
- **The agent's questions go to the holders.** In a free workspace they go to the project roles that may assign holders.
- **Phase moves and approvals** are checked against the project role of whoever approves them or started the turn.
  Otherwise the agent proposes and a holder whose role allows it accepts.
- **Leaving:** "Let go" releases the handle. A removed person's work stays; their handles are released.

## 6. Resources: account level and user level

Resources exist at two scopes. Account resources are enabled per project; user resources are a person's own.

| Resource | Account (team) | User (mine) |
|---|---|---|
| Inference providers | Team API keys and cloud accounts (never a Claude subscription: those are personal) | The person's own (a Claude or ChatGPT subscription, their own keys) |
| MCP connections | Team connections, e.g. Jira with a service-account token, the Slack app | The person's own sign-ins, e.g. their Slack |
| Browsers | The cloud browser, team Chromes | The person's Chrome |
| Machines | Team machines | The person's machines |
| Skills | Team | The person's own |
| Secrets | Team and project | (none: a personal secret is a connection or a step-up credential) |

- **Machines of any kind at either scope:** a container machine, a cloud VM (e.g. a team fleet of EC2 instances paired
  through the installer), or a physical computer.
- **User resources are used while their owner holds the handle**, not only in turns they start. Automations, bots and
  the team's Slack bot use account resources only.
- **Inference:** the project's inference profile decides whether user credentials are allowed and from which providers.
  With several holders, a **sticky rotation** stays on one person's credential (per workspace and model role) until it
  is out (rate-limited, exhausted, expired, failing), then moves to the holder who has spent least today; when all are
  out, it falls back to the team's credentials. Per-user usage is shown for visibility only.
- **Connections:** any MCP sign-in method works at either level: OAuth with automatic client registration, an OAuth
  client metadata document, a client id and secret registered in advance (Slack's MCP server needs this), or static
  headers and API tokens. When both levels connect the same service, the user's connection wins while they hold.
- **The team's Slack bot** is an account resource: installed once by an Admin from a generated app manifest, it posts
  updates to project channels and answers `@GitSpace`. People's own Slack MCP connections are separate, user level.

### Where each scope is configured

Scope comes first. Each item lives in exactly one scope, and no list mixes scopes.

- **Pages that hold both scopes stay top-level**, with a switch at the top: **Team | Mine | someone ▾**. These are
  Inference, Plugins (connections, Composio and browsers), Skills and Machines.
  - **Inference, Team:** profiles (models per role, settings, which providers may pay, whether holders' own credentials
    may pay), the team's providers, usage by person and bot.
  - **Inference, Mine:** your providers, the projects where they can pay (their profiles allow it), your usage.
  - **Plugins, Mine:** each says where it applies ("used while you hold the handle in Crumb and Ledger").
  - Members see the Team view read-only, with the blocking role named.
- **Settings holds the pages with one scope**, in two labelled groups:
  - **the team:** people, invites and allowed domains, roles, bots, projects, domains, source and releases, the GitHub
    App, the audit log;
  - **you:** profile, git identity, voice, defaults, passkeys and devices, MCP clients, bots you sponsor.
- **Project settings** stay inside the project: members and project roles; its inference profile and whether holders'
  own credentials may pay; which team plugins are on, whether holders' own plugins are allowed, and plugins the
  repository declares in `.gitspace/bundle.json`; secrets and values; workspace credentials per phase; environment;
  automations.
- **The team owns, the project enables, you bring your own.** The one merged view is the workspace's environment
  popover, where every line is badged Team, Project or the person's name.

### Viewing someone else's scope

Owners and Admins can pick any person or bot in the scope switch; a sponsor can pick their own bots.

- **They see** what is connected (providers, connections, machines, browsers, MCP clients, devices), its status, last
  use, the projects that use it, and usage and cost. A banner reads "Viewing Rina's plugins · as Admin · revoke only".
- **They can revoke:** disconnect a connection, sign out a provider, unpair a machine or browser, revoke an MCP client
  or a device, drop a step-up credential. Each revoke is in the audit log and the person is told ("Theo disconnected
  your Slack"). This is how offboarding and "revoke active sessions" work.
- **They never** see secret values or tokens, use the person's resources, connect anything in their name, or edit their
  profile. Viewing is not logged.
- **A sponsor** sees and edits their own bot's scope fully.
- **Project Leads** have no access to people's scopes; they see the effect in their project's environment popover.

## 7. Credential kinds

Credentials that reach a workspace's commands (cloud roles, Vault tokens, GitHub tokens) come in two kinds:

- **Workspace credentials:** tied to the workspace through its project's configuration and its current phase. They
  survive handle changes.
- **Personal step-up credentials:** a person's own, obtained with a sign-in challenge (passkey), time-boxed, active only
  while that person holds the handle. Never inherited by co-holders; dropped on Let go, handle release or expiry. The
  workspace shows who holds a step-up, its scope and its time left, with Drop.

## 8. GitSpace's MCP server, per person

GitSpace's `/mcp` (OAuth, scoped consent, several connections) acts as the account today. With Teams:

- **A person's MCP client acts as that person.** The consent page grants a slice of the person's own permissions
  (projects, capabilities, expiry); it can never exceed their roles.
- **Attribution names the client:** "Maya via Claude Code".
- **A client shares its person's handle**; its prompts are labelled.
- **Personal step-up stays human:** a client gets step-up credentials only through a passkey challenge for that action.

## 9. Bots

A **bot** is a principal a person creates and **sponsors**. It replaces today's account integrations (a token that
acts as the whole account): clean cutover, one concept.

- **Same permission model as people:** account role Member (never Owner; whether a bot can ever be Admin is open,
  section 12), project memberships and project roles. Refusals name the bot's role.
- **Acts only over MCP**, with its own credential (shown once, revocable).
- **Attribution:** "Release bot (sponsored by Theo)" on turns, phase moves, comments and commits; the audit log filters
  by bot and by sponsor.
- **It can hold the handle**, start workspaces, prompt agents, comment and move phases within its role. Agent questions
  in a workspace it holds go to its MCP session, and escalate to its sponsor or the project's Leads if unanswered.
- **Resources:** account level only, as its projects allow, plus credentials given to the bot itself. No personal
  subscription: a sponsor's personal credentials never flow to their bot.
- **Stays human:** personal step-up credentials, environment approvals, passkey actions. A bot proposes; a permitted
  person accepts.
- **Sponsor removed:** the bot is suspended until an Owner or Admin reassigns it; its history stays attributed.

## 10. Attribution and audit

Every turn, phase move, approval, comment, note and commit records its principal (and the MCP client, when there is
one). Commits keep the person as author, GitSpace as committer, and Co-authored-by for co-holders and note writers.
The audit log lists every account and project action with its principal; Owners and Admins read it.

## 11. Build order

1. **Principals and the identity split.** Today a request names the account (`userId`, always `ACCOUNT_ID`) and a
   device; the device id stands in for the person in Chatter authors, journal and inspector actors, lifecycle
   approvals, comments and drafts, and per-person settings (git author, defaults) are account-wide. About 29
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
   - **Two helpers** replace direct lookups: per-person objects (`USER_SETTINGS`, `USER_MCP_CONNECTIONS`, later
     `USER_SKILLS`) by principal, team objects (`USER_PROJECTS`, `USER_STORAGE`, project secrets, the rest) by account.
     For the owner both resolve to today's names, so old and new code share every object during a deploy.
   - **New attribution records principals**; readers accept old device-id values and fall back when a name can't be
     resolved.
   - **Risk:** `UserSettings.profile.handle` doubles as the account's hostname handle (`routeAccountRpc` refuses any
     other host). It moves to account state with one release that writes both and reads the new place first.
   - Each part ships on its own and is proven on a live account, with old and new code running side by side.
2. **Users, invites (allowed domains), account roles, project memberships and roles, visibility.**
3. **Attribution and the audit log.**
4. **The handle:** holders, requests, take-over and assign, notes, questions to holders, approvals by role.
5. **User-level resources and the two credential kinds**, including the inference rotation.
6. **Per-person MCP grants.**
7. **Bots**, replacing account integrations.
8. **The team's Slack bot** and pre-registered OAuth clients for MCP connections.

## 12. Open decisions (each with its current suggestion)

1. Does a new holder inherit the open questions? *Yes.*
2. A limit on handles per person? *No.*
3. Can a permitted non-holder change a workspace's phase? *Only holders, plus Leads.*
4. A phase proposal with several permitted holders: *goes to all; the first accept wins.*
5. The payer changes mid-turn: *usage splits by request; the turn's starter stays its author.*
6. Handle requests: *expire after about a day; cancelled when the asker leaves or every holder lets go.*
7. A per-viewer status ("Waiting on Rina"): *yes.*
8. Header crowding next to the board: *fold the handle's actions into one menu.*
9. Two holders connect the same service: *the turn starter's connection wins.*
10. A removed person's pending invites: *cancelled.* Bots they sponsor: *suspended until reassigned* (section 9).
11. Today's account Secrets: *become API-token credentials in a later migration.*
12. Who creates bots? *Owners and Admins.*
13. Can a bot ever be Admin? *No: Member, fixed.*
14. Who gets a handle request for a workspace a bot holds? *Its sponsor.*
15. Who accepts a bot's proposal when only a bot holds the handle? *Any project member whose role allows it.*
16. The role an Admin gets on Join project: *chosen on joining, default Lead; Admins always manage members.*
17. Can a project's Lead remove or change the role of an Admin, or a bot someone else sponsors? *Bots yes, Admins no.*
18. Does creating a bot or its credential need a passkey, as account integrations do? *Yes.*
19. Are team and project credentials phase-scoped workspace credentials? *Yes.*
