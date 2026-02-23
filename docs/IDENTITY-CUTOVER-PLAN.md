# Identity/Auth Clean Cutover Plan (North Star)

Status: locked implementation plan for the clean cutover.

This document is the canonical source for implementation decisions during the cutover. If code or behavior conflicts with this document, code must be changed to match this document.

---

## 1) Non-Negotiable Constraints

1. No backward compatibility behavior.
2. No migration behavior for old ACL systems.
3. No dual-path auth model.
4. No device-key-based permanent access grants.
5. No legacy command aliases kept alive just for compatibility.

This is a hard reset to the correct model, not an incremental evolution.

---

## 2) Final Authorization Model

### 2.1 Principals

- User principal: user root identity (`gssh-user:...`, derives user root ID).
- Machine principal: machine identity keypair plus owner user root binding.
- Relay principal: relay process/runtime identity for routing and policy enforcement.

### 2.2 Roles

There are two effective roles:

- `owner`: machine owner (implicit from machine ownership binding).
- `full`: collaborator with full machine access.

There is no persistent machine-wide `view` role in ACL.

### 2.3 Authorization Gates

For direct full-access connection to a machine:

1. Client must be allowed at relay level.
2. Client must be allowed on that machine.
3. Client must present valid device certificate (for user root derivation).

If any gate fails, direct full connection is rejected.

### 2.4 Permission Matrix

| Capability | owner | full |
| --- | --- | --- |
| List machines (direct access path) | yes | yes (authorized only) |
| Connect direct to machine | yes | yes |
| Attach to arbitrary session | yes | yes |
| PTY write/input | yes | yes |
| Session/process/workspace management | yes | yes |
| Grant/revoke relay ACL | yes | no |
| Grant/revoke machine ACL | yes | no |
| Create/revoke root invites | yes | no |

---

## 3) Final CLI Shape (Comprehensive)

This is the full command surface target after cutover.

```bash
gssh
├── project
│   ├── list [--json] [--verbose]
│   ├── add [--no-clone] [--org <org>] [--linear-key <key>] [--bundle-url <url>] [--bundle-path <path>] [--skip-bundle]
│   └── remove [project-name] [--force]
├── workspace
│   ├── list --project <name> [--json] [--verbose]
│   ├── add [workspace-name] --project <name> [--branch <name>] [--from <branch>] [--no-setup]
│   ├── remove [workspace-name] --project <name> [--force] [--keep-branch]
│   ├── context --project <name> --workspace <name> [--json]
│   ├── review notes|import|push|hunks|add-hunk|add-file|add-line ...
│   ├── session list|new|attach ...
│   ├── process list|start|stop|attach ...
│   ├── events list|show|tail ...
│   └── bundle refresh|status ...
├── relay
│   ├── start [--port <n>] [--bind <addr>] [--hostname <host>] [--label <label>]
│   ├── access add <gssh-user:...> [--label <label>]
│   ├── access list [--json]
│   ├── access remove <user-id\|label>
│   ├── machines list
│   └── machines revoke <machine-id>
├── invite
│   ├── relay-user create <gssh-user:...> --relay <url> [--expires <duration>] [--max-uses <n>] [--label <label>]
│   ├── relay-machine create --relay <url> --machine-signing-key <base64> --machine-key-exchange-key <base64> [--expires <duration>] [--max-uses <n>] [--label <label>]
│   ├── machine-user create <machine-id> <gssh-user:...> --relay <url> [--expires <duration>] [--max-uses <n>] [--label <label>]
│   ├── list --relay <url> [--type <type>] [--json]
│   └── revoke <invite-id> --relay <url>
├── machine
│   ├── serve start|stop|status [...]
│   ├── enroll --invite <relay-machine-invite-token> [--label <name>]
│   ├── access add <gssh-user:...> [--label <label>] [--machine <id>]
│   ├── access list [--json] [--machine <id>]
│   ├── access remove <user-id\|label> [--machine <id>]
│   └── tmux start|stop|status|list|new|attach|kill
├── client
│   ├── machines list [--relay <url>]
│   └── connect <target> [--relay <url>] [--machine <id>]
├── user
│   ├── identity init|show|recover|export|import|remove
│   ├── auth login|logout|status|invite accept <token>
│   ├── host reserve|release|list|set-primary|status
│   ├── config ...
│   └── notifications ...
├── cloud
│   ├── setup [--clear]
│   ├── status
│   ├── list
│   ├── launch --repo <owner/repo> [--branch <branch>] [--image <image>]
│   ├── stop <workspaceId>
│   ├── resume <workspaceId>
│   └── destroy <workspaceId>
├── status
└── space (hidden session-only) context|review|process|events|bundle
```

Notes:

- `project` and `workspace` trees remain feature-complete and unchanged in behavior.
- Old standalone/legacy top-level access behavior is removed.
- Invite issuance/management is centralized under `gssh invite ...`.

---

## 4) What Existed Before Cutover (Now Removed)

These were the main legacy remnants that were explicitly out of model and are now deleted or fully replaced:

1. File-based device ACL stores:
   - legacy core access module (file-based ACL path)
   - legacy identity access-list helpers (file-based ACL path)
2. Device-key access command implementation:
   - legacy access command module
   - old `gssh machine access` wiring that accepted legacy device-key input format
3. Serve daemon access-list watcher + sync path:
   - `src/commands/serve.ts` file watch and relay sync behavior for legacy access list
   - control socket add/remove access handlers in `src/serve/daemon.ts`
4. Legacy relay protocol messages for ACL sync and device authorization:
   - `authorize_client`, `revoke_client`
   - `add_global_access`, `remove_global_access`
   - `access_list`, `access_update`
5. Legacy relay in-memory ACL registries:
   - per-client authorizations and global access list behavior in `src/relay/registries.ts`
6. Invite-to-permanent-cached access behavior:
   - `src/lib/tmux-lite/handshake-handler.ts` invite path adding entries to `AccessControlList`

---

## 5) New Persistence Model (Fresh Auth System)

No migration from old ACL stores. New auth persistence starts clean.

### 5.1 New Auth Store

- Add a dedicated auth store module (new code path), e.g. `src/relay/auth/store.ts`.
- Store only user-root-keyed ACL and token state.
- Ignore old ACL files and old authorization registries.

### 5.2 Required Entities

1. Relay ACL (user-root keyed)
   - owner root ID
   - collaborator user root ID
   - label
   - timestamps

2. Machine ACL (user-root keyed)
   - machine ID
   - owner root ID
   - collaborator user root ID
   - role: `full` only (persistent)
   - label
   - timestamps

3. Root invites
   - invite ID
   - owner root ID
   - invite type (`relay-user` | `relay-machine` | `machine-user`)
   - relay URL
   - optional target user root ID
   - optional target machine ID / key material
   - token hash
   - expires at
   - max uses / used count
   - revoked marker
   - timestamps

4. Machine ownership binding
   - machine ID -> owner root ID
   - can reuse current machine ownership source if it aligns exactly

### 5.3 Data Guarantees

- ACL checks are deterministic and user-root keyed.
- Deleting/revoking a grant takes effect immediately.
- Invite acceptance grants ACL entries according to invite type.

---

## 6) Protocol Contract (Post-Cutover)

### 6.1 Keep

- Core connection and handshake envelopes.
- Machine registration and relay identity challenge-response.
- Cloud bootstrap/unlock flows where unrelated to ACL model.

### 6.2 Replace/Remove

Remove legacy ACL message families from active protocol paths:

- `authorize_client`
- `revoke_client`
- `add_global_access`
- `remove_global_access`
- `access_list`
- `access_update`

### 6.3 Final Connection Messages

- Direct full connect path includes cert context sufficient for user-root derivation and relay policy checks.
- Root-invite acceptance and direct `connect_to_machine` are the only supported access paths.
- Signed client messages remain mandatory on security-sensitive operations.

---

## 7) Runtime Enforcement Rules

### 7.1 Relay

For `client machines list` and direct machine connect:

1. Verify client message signature.
2. Verify/parse client device certificate.
3. Derive client user root ID.
4. Check relay ACL membership.
5. Check machine ACL membership (for requested machine).
6. Allow only if all required checks pass.

### 7.2 Machine/Serve + Handshake

- Direct full path: handshake accepts only if caller is owner or in machine full ACL.
- No invite path may bypass owner+ACL policy.

---

## 8) Command Behavior Details

### 8.1 `relay access`

- Input key format: `gssh-user:BASE64_SIGNING_KEY`
- add/list/remove operate on relay user membership only.

### 8.2 `machine access`

- Input key format: `gssh-user:BASE64_SIGNING_KEY`
- add/list/remove operate on machine full-access ACL only.
- persistent role set: `full` only.

### 8.3 `invite`

- `relay-user create`: invite a user root to relay ACL.
- `relay-machine create`: issue machine enrollment invite for `machine enroll --invite`.
- `machine-user create`: invite a user root to a specific machine ACL.
- `list`/`revoke`: manage owner-issued root invites.

### 8.4 `client connect`

Supports two flows:

1. User accepts invite (`gssh user auth invite accept <token>`) and receives ACL grant.
2. Client connects direct to target machine (`connect_to_machine`) with relay+machine ACL checks.

---

## 9) Implementation Plan (Execution Checklist)

All checklist items are required unless explicitly marked optional.

### Phase A - Freeze Target Surface

- [ ] Update this plan and lock naming/roles/flows.
- [ ] Ensure all references in code comments match owner/full/view model.

### Phase B - Build Fresh Auth Store and Services

- [ ] Add new auth store modules under `src/relay/auth/` (types + CRUD + token helpers).
- [ ] Implement relay ACL CRUD by user root ID.
- [ ] Implement machine ACL CRUD by user root ID.
- [ ] Implement root invite CRUD/validation/consumption.

### Phase C - Relay Protocol and Server Cutover

- [ ] Update `src/relay/protocol.ts` to remove legacy ACL message families from active use.
- [ ] Add/adjust message types for direct full connect and root-invite acceptance.
- [ ] Update `src/relay/server.ts` authorization logic to two-gate full access checks.
- [ ] Ensure `list_machines` returns only machines valid for caller under new model.

### Phase D - Serve + Handshake Enforcement

- [ ] Update `src/lib/tmux-lite/handshake-handler.ts` to remove invite->ACL caching.
- [ ] Remove legacy `AccessControlList` dependency for permanent auth decisions.
- [ ] Keep role/permission enforcement for read/write/manage at session layer.
- [ ] Update `src/commands/serve.ts` to stop watching and syncing old access-list files.
- [ ] Remove access command control socket plumbing from `src/serve/daemon.ts` if no longer needed.

### Phase E - CLI Command Refactor

- [ ] Rework `src/cli/commands/invite.ts` for root invite workflows.
- [ ] Rework `src/cli/commands/machine.ts` for user-root machine ACL and `machine enroll --invite`.
- [ ] Rework `src/cli/commands/client.ts` for `client machines list` + direct connect.
- [ ] Remove device-key ACL command usage.

### Phase F - Remove Legacy ACL Code Paths

- [x] Delete legacy access command module.
- [x] Delete legacy core access module.
- [x] Remove access-list helpers from `src/core/identity.ts`.
- [x] Remove legacy authorization/global-access branches from `src/relay/registries.ts`.
- [x] Remove now-unused legacy protocol handlers in relay/serve code.

### Phase G - Connect Flow Finalization

- [ ] Update `src/commands/connect.ts` to support token view flow and direct full flow clearly.
- [ ] Ensure direct connect always sends cert material required for policy checks.
- [ ] Fix user-facing copy to reference new commands and roles.

### Phase H - Tests and Documentation

- [ ] Replace tests that validate legacy ACL messaging and device-key ACL behavior.
- [ ] Add tests for two-gate full access and invite acceptance flows.
- [ ] Update docs: `README.md`, `docs/REMOTE-DESIGN.md`, `docs/RELAY.md`, `docs/PROTOCOL.md`, `docs/GETTING-STARTED.md`.
- [ ] Remove stale references to legacy top-level access commands and legacy invite semantics.

---

## 10) Explicit File-Level Work Targets

### Must edit

- `src/cli/commands/machine.ts`
- `src/cli/commands/relay.ts`
- `src/cli/commands/client.ts`
- `src/commands/serve.ts`
- `src/commands/connect.ts`
- `src/relay/server.ts`
- `src/relay/protocol.ts`
- `src/lib/tmux-lite/handshake-handler.ts`
- `src/serve/daemon.ts`
- `src/serve/types.ts`

### Must add

- `src/relay/auth/store.ts` (or equivalent new auth-store module)
- `src/relay/auth/types.ts`
- `src/relay/auth/tokens.ts` (if split)
- test files for relay ACL, machine ACL, root invite policy

### Removed as part of cutover

- legacy access command module
- legacy core access module
- legacy access-list helper section from `src/core/identity.ts`
- legacy ACL protocol handlers and message types no longer in model

---

## 11) Test Plan

### 11.1 Unit

- Relay ACL CRUD and lookup by user root ID.
- Machine ACL CRUD and lookup by machine+user root.
- Root invite create/parse/expiry/revoke/usage limits.
- Role-based permission checks (`owner/full`).

### 11.2 Integration

- Full direct connect success only when relay+machine ACL both grant.
- Full connect fails when relay grants but machine denies.
- Full connect fails when machine grants but relay denies.
- Relay-user invite acceptance grants relay ACL membership.
- Machine-user invite acceptance requires relay ACL membership and grants machine ACL.
- Relay-machine invite enrollment allows machine registration and re-registration.

### 11.3 CLI

- `relay access` add/list/remove with `gssh-user` keys.
- `machine access` add/list/remove with `gssh-user` keys.
- `invite` create/list/revoke and `user auth invite accept`.
- `client machines list` and `client connect` direct flow.

### 11.4 Full verification

- `bun run typecheck`
- targeted suite runs for relay/handshake/serve/connect
- full `bun test` with known flaky tests tracked separately

---

## 12) Definition of Done

All must be true:

1. Permanent access is user-root keyed only.
2. Full access requires relay ACL + machine ACL.
3. Access grants are issued and accepted via root invites, then enforced via ACL.
4. No legacy ACL file-based behavior in active runtime.
5. No legacy ACL protocol message families in active use.
6. Command help/docs/code all match final command tree.
7. Project/workspace command surface remains intact and working.

---

## 13) Out of Scope for This Cutover

- Legacy data conversion from old ACL files.
- Compatibility aliases for removed old commands.
- Partial dual-mode operation.

---

## 14) Implementation Rule During Build

If a code path requires adding compatibility logic with the old ACL model, do not add that logic.

Delete and replace with the new model instead.
