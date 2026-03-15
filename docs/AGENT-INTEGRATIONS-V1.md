# Agent And Integrations V1

## Goals

- Use native OpenCode server as the default agent runtime.
- Mount a GitSpace shell around an OpenCode core in both TUI and web.
- Design the runtime layer so later we can add `sandbox-agent` or other OpenCode-compatible backends.
- Add a typed integrations/plugins system for installing tools and capturing portable config or credentials.
- Use real user paths for materialization in V1.

## Non-goals

- Universal OAuth portability across machines.
- Fake `HOME` overlays as the default execution model.
- Relay-owned execution of third-party integrations.

## Runtime Model

- A workspace exposes two runtime types:
  - `terminal`
  - `agent`
- `agent` runtime is backed by an `AgentBackend`.
- V1 ships `OpenCodeBackend` only.
- GitSpace owns workspace selection, access control, relay transport, and session lifecycle.
- OpenCode owns the agent runtime and session protocol.
- Remote clients reach workspace OpenCode runtimes through a GitSpace-managed HTTP and SSE bridge over the encrypted relay channel.

## Agent Backend Contract

- `detect()` reports install and server status for a workspace target.
- `ensureInstalled()` makes sure the backend runtime exists.
- `ensureServer()` starts or reuses the backend server.
- `listSessions()`, `createSession()`, `resumeSession()`, and `destroySession()` manage agent sessions.
- GitSpace normalizes backend-specific events into a shared internal event model.

## V1 Agent Backend

- `OpenCodeBackend`
  - starts and connects to `opencode serve`
  - uses OpenCode HTTP and SSE APIs
  - supports multiple concurrent sessions in a workspace
  - is the single backend surfaced by the UI in V1
  - is run once per workspace, not once per machine

## UI Model

- Workspace UI offers:
  - `Terminal`
  - `Agent`
- `Agent` uses a GitSpace session picker for OpenCode sessions per workspace.
- V1 launches native `opencode attach` inside GitSpace terminal surfaces for both TUI and web clients.
- GitSpace wraps backend selection, connection state, and workspace context around the OpenCode core.

## Integrations

- `Integration` is the runtime-facing unit.
- Integrations are scoped to `user` or `project`.
- Integrations declare:
  - install methods
  - health checks
  - capture rules
  - materialization rules
  - optional local-auth requirements

Supported V1 capture modes:

- `capture-file`
- `capture-section`
- `env-secret`
- `manual-local`

## Plugins

- `Plugin` is the packaging and distribution unit.
- Plugins contribute one or more integrations.
- Plugins are distributed through relay artifact storage.
- Machines download and execute plugins locally.
- The relay does not run plugin code.

## Credential Policy

- Use native user paths in V1 when the tool expects them.
- Sync only portable config and credentials.
- Treat OAuth-heavy auth for agent runtimes as local to each machine or persistent workspace in V1.

Examples of portable V1 integrations:

- `git` selected `~/.gitconfig` sections
- `npm` `~/.npmrc`
- `aws` `~/.aws/config`, `~/.aws/credentials`
- `kubectl` `~/.kube/config`
- `terraform` `~/.terraformrc`
- `pulumi` `~/.pulumi/credentials.json`
- `wrangler` config or API token
- `vercel` auth/config where portable

Examples of V1 local auth only:

- `opencode` OAuth
- `claude` OAuth
- `codex` OAuth

## Extensibility

- Future agent backends:
  - `sandbox-agent`
  - other OpenCode-compatible runtimes
- Future credential strategies:
  - helper or proxy delivery
  - sandbox adapter for isolated execution
  - brokered OAuth flows

## Suggested Implementation Order

1. Add `AgentBackend` types and `OpenCodeClient`.
2. Add `OpenCodeBackend` foundation.
3. Add integration and plugin manifest types.
4. Add built-in integration registry.
5. Wire backend and integration foundations into UI and workspace lifecycle.
