# Unified TUI/Web Architecture Plan

> **Implementation Status: ~90% Complete**
>
> | Phase | Description | Status |
> |-------|-------------|--------|
> | 0 | Simplify access model | ✅ Complete |
> | 1 | Web PIN encryption | ❌ Not started (optional security feature) |
> | 2 | Shared component foundation | ✅ Complete |
> | 3 | Extract SpacesBrowser | ✅ Complete |
> | 4 | Port SpacesBrowser to TUI | ✅ Complete |
> | 5 | MachineList component | ✅ Complete |
> | 6 | TUI relay connection | ✅ Complete |
> | 7 | TUI terminal with Ghostty | ✅ Complete |
> | 8 | Inbox & Flows | ✅ Complete |
> | 9 | Daemon management | ✅ Complete |

---

## Goals

1. **Feature parity** between TUI and web interfaces
2. **Shared logic** - write business logic once, render for each platform
3. **Remote machine support** in TUI - treat local machine as just another machine
4. **Unified hierarchy**: Machines → Projects → Workspaces → Sessions

## Current State

### TUI (`src/tui/`)
- OpenTUI (React-like API for terminal)
- `state.ts` - reducer-based state management
- `app.tsx` - 2200+ line monolithic component with:
  - Project list panel
  - Workspace tree panel (expandable sessions)
  - Inbox system (notifications from tmux-lite)
  - Flow states for modals (help, confirm-delete, new-project, new-workspace, etc.)
  - Local-only operation

### Web (`src/web/src/`)
- React + Vite
- `hooks/useRelayConnection.ts` - WebSocket to relay, machine list
- `hooks/useTerminal.ts` - terminal session management
- `components/MachineList.tsx` - machine selection
- `components/SpacesBrowser.tsx` - workspace/session browser
- Remote-only operation (no local support)

## Architecture Pattern

### File Structure
```
src/shared/components/
├── MachineList.tsx          # Logic + hooks
├── MachineList.web.tsx      # Web rendering
├── MachineList.tui.tsx      # TUI rendering
├── SpacesBrowser.tsx        # Logic + hooks
├── SpacesBrowser.web.tsx    # Web rendering
├── SpacesBrowser.tui.tsx    # TUI rendering
├── Inbox.tsx                # Logic + hooks
├── Inbox.web.tsx            # Web rendering
├── Inbox.tui.tsx            # TUI rendering
└── types.ts                 # Shared types
```

### Component Pattern

Each component has three files:

**1. Logic file (`Component.tsx`)**
- Contains React hooks (works in both OpenTUI and React)
- Pure TypeScript logic (no JSX rendering)
- Exports `useComponent()` hook returning state + actions
- Exports shared types

**2. Web renderer (`Component.web.tsx`)**
- React JSX only
- Imports and uses the hook from logic file
- Web-specific event handling (click, DOM events)

**3. TUI renderer (`Component.tui.tsx`)**
- OpenTUI JSX only
- Imports and uses the hook from logic file
- TUI-specific rendering (box, text, select elements)

## Hierarchy: Machines → Projects → Workspaces → Sessions

### Unified Flow
```
Launch → Machines → [Select Machine] → Projects → [Select Project] → Workspaces → [Expand] → Sessions → [Attach] → Terminal/Shell
```

Where "Local" is just another machine in the list.

## Access Model (Simplified)

Only two access levels:

### 1. Full Access
- Granted via `gssh access add <public-key>`
- Can browse all projects, workspaces, sessions
- Can create/attach/kill sessions
- Can perform all operations on the machine
- Identity is stored in machine's access list

### 2. Session Invite (View-Only)
- One-time link to view a specific session
- Cannot browse projects/workspaces
- Cannot interact with terminal (read-only)
- Useful for: pair programming demos, showing progress, debugging help

**Removed:** Per-project and per-workspace permission levels (read/write/manage). These add complexity without real enforceability - if someone can connect to your machine, granular permissions are hard to enforce meaningfully.

### Current Code to Simplify

The `AccessPermissions` type in `src/types/identity.ts` currently has:
```typescript
interface AccessPermissions {
  read: boolean;
  write: boolean;
  manage: boolean;
}
```

**Simplify to:**
```typescript
type AccessType = 'full' | 'session-invite';

interface AccessEntry {
  identityId: string;
  signingPublicKey: string;
  keyExchangePublicKey: string;
  label?: string;
  grantedAt: number;
  accessType: AccessType;
  // For session invites only:
  sessionId?: string;
  expiresAt?: number;
}
```

**Files affected by simplification:**
- `src/types/identity.ts` - Remove AccessPermissions, simplify to AccessType
- `src/lib/tmux-lite/crypto/access-control.ts` - Remove permission checks
- `src/core/access.ts` - Simplify addAccess, remove formatPermissions
- `src/commands/access.ts` - Remove permission flags
- `src/web/src/components/MachineList.tsx` - Remove permission badges
- `src/web/src/hooks/useRelayConnection.ts` - Simplify MachineInfo type
- `src/relay/server.ts` - Remove permission-based routing
- `src/serve/client-session-manager.ts` - Remove permission checks

## Key Implementation Decisions

### 1. Terminal Handling (TUI)

Use **ghostty-opentui** (`github.com/remorses/ghostty-opentui`) for both:
- **Local sessions**: Connect directly to tmux-lite
- **Remote sessions**: Connect through relay with encryption

### 2. TUI Relay Connection

TUI can be started with flags to connect to a relay:

```bash
# Connect to relay
gssh --relay wss://relay.example.com

# Or just start TUI locally (default)
gssh
```

### 3. Key Storage & Encryption

**TUI (Bun)**:
- Use Bun's native keychain access
- Store signing key and key exchange key in system keychain

**Web (Browser)**:
- Store keys in localStorage, **encrypted with user-defined PIN**
- Use PBKDF2 to derive encryption key from PIN
- Encrypt with AES-GCM

## Implementation Phases

### Phase 0: Simplify Access Model ✅
- [x] Replace `AccessPermissions` with `AccessType` enum ('full' | 'session-invite')
- [x] Update `AccessEntry` type in `src/types/identity.ts`
- [x] Permission helpers in `src/serve/types.ts`: `canWrite()`, `canManage()`, `canAttachSession()`
- [x] Update handshake to use simplified access
- [x] Update all permission checks to just check access type

### Phase 1: Web PIN Encryption ❌
- [ ] Add PIN setup flow to web auth
- [ ] Encrypt identity keys with PIN in localStorage
- [ ] Add PIN unlock on app load
- [ ] Create `src/shared/crypto/pin-encryption.ts`

### Phase 2: Shared Component Foundation ✅
- [x] Create `src/shared/` directory structure
- [x] Define `MachineProvider` interface in `src/shared/providers/MachineProvider.ts`
- [x] Create `LocalMachineProvider` in `src/shared/providers/LocalMachineProvider.ts`
- [x] Create `RemoteMachineProvider` in `src/shared/providers/RemoteMachineProvider.ts`
- [x] Create shared types in `src/shared/types.ts`

### Phase 3: Extract SpacesBrowser ✅
- [x] Extract `SpacesBrowser.tsx` logic from web component
- [x] Create `SpacesBrowser.web.tsx` using the hook

### Phase 4: Port SpacesBrowser to TUI ✅
- [x] Create `SpacesBrowser.tui.tsx`
- [x] Integrate into existing TUI app.tsx

### Phase 5: MachineList Component ✅
- [x] Create `MachineList.tsx` logic
- [x] Create web and TUI renderers
- [x] Add "Local" as first machine in TUI

### Phase 6: TUI Relay Connection ✅
- [x] Add `--relay` CLI flag
- [x] Add relay WebSocket connection to TUI
- [x] Create `RemoteMachineProvider` for TUI
- [x] `useRemoteMachines` hook in `src/tui/hooks/`

### Phase 7: TUI Terminal with Ghostty ✅ Complete
- [x] Add ghostty-opentui dependency
- [x] Integrate into Terminal component for local sessions
- [x] Handle remote stream with ghostty
- [x] Persistent terminal mode with proper cleanup

### Phase 8: Inbox & Flows ✅
- [x] Extract inbox logic to shared component (`Inbox.tsx`, `Inbox.web.tsx`, `Inbox.tui.tsx`)
- [x] Create Flow component (`Flow.tsx`, `Flow.web.tsx`, `Flow.tui.tsx`)
- [x] TUI inbox via `useInboxTUI` hook

## File Structure

```
src/shared/
├── components/
│   ├── MachineList.tsx
│   ├── MachineList.web.tsx
│   ├── MachineList.tui.tsx
│   ├── SpacesBrowser.tsx
│   ├── SpacesBrowser.web.tsx
│   ├── SpacesBrowser.tui.tsx
│   ├── Inbox.tsx
│   ├── Inbox.web.tsx
│   ├── Inbox.tui.tsx
│   └── types.ts
├── providers/
│   ├── MachineProvider.ts       # Interface
│   ├── LocalMachineProvider.ts  # Filesystem + tmux-lite
│   └── RemoteMachineProvider.ts # Relay + encryption
├── crypto/
│   └── pin-encryption.ts        # Web PIN-based key encryption
└── hooks/
    ├── useNavigation.ts
    └── useMachineConnection.ts
```

## Dependencies

```json
{
  "ghostty-opentui": "^x.x.x"   // TUI terminal rendering
}
```

Note: Keychain access via Bun native API (no additional deps needed).

---

## Recent Additions (2025-01)

### Phase 9: Daemon Management ✅

Added daemon lifecycle management for `gssh serve`:

- [x] PID file management (`~/gitspace/.serve/serve.pid`)
- [x] Unix socket status server (`~/gitspace/.serve/serve.sock`)
- [x] `gssh serve start` - background daemon
- [x] `gssh serve stop` - graceful shutdown
- [x] `gssh status` - query all daemons
- [x] Access command forwarding to running daemon
- [x] `useDaemonStatus` hook in TUI

**Files:**
- `src/serve/daemon.ts` - Daemon lifecycle
- `src/commands/status.ts` - Status CLI
- `src/tui/hooks/useDaemonStatus.ts` - TUI integration

---

*Last updated: 2025-01*
