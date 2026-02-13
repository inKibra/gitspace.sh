# Unified Architecture

This document describes the canonical shared architecture for CLI/TUI/Web state and session handling.

## Status

Implementation is now centered on a shared session engine and backend adapters.

- Completed:
  - Shared component logic/renderer split (`*.tsx`, `*.web.tsx`, `*.tui.tsx`)
  - Shared workspace/project lifecycle orchestration (`core/workspace-lifecycle.ts`, `core/project-lifecycle.ts`)
  - Shared relay machine-directory client (`src/relay-client/machine-directory-client.ts`)
  - Shared relay machine-directory hook (`src/relay-client/useMachineDirectory.ts`) used by web+tui wrappers
  - Shared session engine foundation (`src/session/*`)
  - Shared remote/local backend adapters (`src/session/backends/*`)
  - Shared remote session hook (`src/session/useRemoteSessionClient.ts`) used by web+tui wrappers
  - Web remote terminal flow migrated to shared session backend
  - TUI remote machine screen migrated to shared remote backend + remote terminal transport
  - TUI local projects/workspaces/sessions/inbox state now sourced from shared local backend via `useLocalSession`
  - TUI local terminal attach/detach/PTY lifecycle is now backend-driven via `LocalSessionBackend`
  - TUI project/workspace panels now consume shared local backend state directly (legacy sync bridge removed)
  - Legacy TUI-only state/adapter modules removed (`tui/state.ts`, `tui/adapters.ts`, `tui/hooks/useInboxTUI.ts`)
  - Shared project catalog service (`core/project-catalog.ts`) used by CLI list + local backend + remote session handler

## Goals

1. Shared core behavior across platforms.
2. Platform differences isolated to renderer/input/transport adapters.
3. Remote and local machines represented through the same backend contract.

## Canonical Model

### 1) Session Engine (Shared)

`src/session/`

- `types.ts`: canonical backend/session state
- `events.ts`: normalized backend event contract
- `reducer.ts`: deterministic state transitions
- `backend-manager.ts`: backend registration + event routing
- `useSessionEngine.ts`: React hook API for platform UIs
- `useRemoteSessionClient.ts`: shared remote terminal/session orchestration hook used by platform wrappers

Key state shape:

- Backends keyed by descriptor (`local`, `remote:<relay>:<machine>`)
- Per-backend status, projects, workspaces, sessions, inbox, notification config, attach/script runtime state
- Active backend selection for UI focus

### 2) Backend Contract (Shared)

`src/session/backend.ts`

All local/remote machine operations are expressed through `SessionBackend`:

- connect/disconnect
- list projects/workspaces/sessions
- attach/detach/kill/delete
- inbox read/clear/fetch
- notification config get/update
- PTY write/resize (optional)
- event subscription

### 3) Backend Implementations

#### Remote backend

`src/session/backends/remote-session-backend.ts`

- Owns relay handshake lifecycle (X3DH adapters)
- Owns encrypted frame encode/decode adapters
- Speaks canonical remote-session protocol (`list_*`, `attach_session`, inbox/config/script-output, etc.)
- Emits normalized backend events

#### Local backend

`src/session/backends/local-session-backend.ts`

- Wraps local tmux/config/workspace lifecycle operations
- Maps local operations to the same backend event model as remote

## Platform Integration

### Web

- Relay directory: `src/hooks/useRelayConnection.web.ts`
- Terminal/session: `src/hooks/useTerminal.web.ts`

`useRelayConnection` and `useTerminal` are now thin adapters over shared relay/session hooks.

### TUI

- Relay directory: `src/hooks/useRemoteMachines.tui.ts`
- Remote terminal/session: `src/hooks/useRemoteTerminal.tui.ts`
- Remote attached renderer: `src/components/SessionTerminal.tui.tsx`
- Remote machine screen: `src/components/RemoteMachineScreen.tui.tsx`

Current TUI state split:

- Remote machine path uses shared remote backend.
- Local machine path uses shared local backend for projects/workspaces/sessions/inbox and terminal attach lifecycle.
- Project/workspace panel rendering reads backend state directly; local reducer now tracks only UI view/focus/loading/error state.

### CLI

- Project listing now shares project catalog logic through `src/core/project-catalog.ts`.
- Remote connect now uses shared remote backend adapters (`RemoteSessionBackend` + node adapters), matching TUI/Web session protocol flow.

## Data Flow

1. Platform creates backend(s) with descriptor + transport/crypto/handshake adapters.
2. Backend registers with `useSessionEngine`.
3. UI calls engine actions (`listWorkspaces`, `attachSession`, `requestInbox`, etc.).
4. Backend emits canonical events.
5. Engine reducer updates state.
6. Renderer consumes normalized state.

## Testing

Added/updated tests around the shared architecture:

- `src/session/__tests__/reducer.test.ts`
- `src/session/__tests__/backend-manager.test.ts`
- `src/session/__tests__/remote-session-backend.test.ts`
- `src/session/__tests__/local-session-backend.test.ts`
- `src/hooks/__tests__/useLocalSession.tui.test.ts`
- `src/tui/__tests__/local-terminal-sync.test.ts`

## Final Migration Target

When migration is complete:

- TUI and Web both run entirely on shared session engine state.
- Local and remote use the same backend contract.
- Platform-specific code is limited to:
  - renderers (`*.web.tsx`, `*.tui.tsx`)
  - UI input handling
  - transport/crypto adapter wiring.
