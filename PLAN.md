# Remove `gitspace-status` Extension and `pi-runtime-update` Sideband

## Goal
Delete the old extension-backed runtime metadata path for Pi agent sessions:
- `src/lib/tmux-lite/agents/extensions/gitspace-status.ts`
- `src/lib/tmux-lite/agents/pi-runtime-status.ts`
- `pi-runtime-update` protocol + server handling
- all wiring that exists only to receive extension sideband updates

Keep:
- VirtualTerminal/in-process SDK rendering path for agent sessions
- TUI + web agent monitoring parity for status, permissions, questions, errors, last message, model info, and todo state

## Current state
Agent rendering already uses the SDK/VirtualTerminal path.
The remaining extension-backed fields are:
- `pendingPermissions`
- `pendingQuestions`
- some retry/error/status updates
- `lastMessage`

Native SDK/session event coverage already exists for:
- `agent_start` / `agent_end`
- `message_update`
- `auto_retry_start` / `auto_retry_end`
- `tool_execution_start` / `tool_execution_end`
- todo/model state we already wired

The only confirmed gap is **permission state**: I did not find a public `AgentSessionEvent` for permission waiting/resolved transitions.

## Decision
Remove the extension today by replacing its data flow with **in-process native bridges** at the coordinator/runtime layer.

That means:
- no extension module
- no socket sideband command
- no PTY child env plumbing for runtime secret/socket
- all session metadata comes from in-process objects and direct event subscriptions

## Implementation plan

### 1. Replace question tracking with native tool execution events
**Files:**
- `src/lib/tmux-lite/agents/pi-coordinator.ts`
- `src/lib/tmux-lite/agent-control.ts`
- `src/lib/tmux-lite/agent-event-manager.ts`

**Change:**
Use `session.subscribe(...)` events already available from `AgentSession`:
- on `tool_execution_start` where `toolName === 'ask'`
  - synthesize a `PendingQuestion`
  - publish to `AgentEventManager`
- on `tool_execution_end` where `toolName === 'ask'`
  - remove that pending question

**Why:**
This removes `pendingQuestions` dependence on `tool_call` / `tool_result` extension handlers.

**Acceptance:**
- Ask prompts still show as pending questions in TUI/web
- Question counts/badges remain correct without extension loading

### 2. Replace retry/error/status updates with native session events
**Files:**
- `src/lib/tmux-lite/agents/pi-coordinator.ts`
- `src/lib/tmux-lite/agent-control.ts`

**Change:**
Extend `PiCoordinator.bindSessionEvents()` to forward native SDK events directly:
- `agent_start` -> busy
- `agent_end` -> idle
- `auto_retry_start` -> retry status + error message
- `auto_retry_end` -> busy/idle + final error clear/set
- `message_update` -> last message preview

We already do part of this; make it complete so no status/error field relies on sideband.

**Acceptance:**
- Busy/idle/retrying badges still work
- Error text still appears in workspace/session UI
- Last assistant preview still updates

### 3. Replace permission tracking with direct in-process permission bridge
**Files:**
- likely one or more of:
  - `src/lib/tmux-lite/agents/pi-coordinator.ts`
  - `src/lib/tmux-lite/agents/virtual-interactive-mode.ts`
  - `src/lib/tmux-lite/agents/omp-types.ts`
  - new helper under `src/lib/tmux-lite/agents/`

**Change:**
Use an in-process listener against the same permission-gate source the extension currently listens to.

The extension currently depends on event channels:
- `gitspace:permission.waiting`
- `permission-gate:waiting`
- `gitspace:permission.resolved`
- `permission-gate:resolved`

Instead of loading an extension just to subscribe to those, wire the equivalent listener directly in the process hosting the SDK session / extension runtime.

Two viable implementation routes:
1. **Preferred:** access the extension/event bus already present on the in-process session/runtime and subscribe directly from coordinator/runtime bootstrap
2. **Fallback if needed:** add a narrow helper in our runtime wrapper that exposes permission wait/resolve callbacks from the in-process SDK boundary

**Critical rule:**
Do not reintroduce a separate transport or sideband command. The replacement must stay in-process.

**Acceptance:**
- Permission-needed states still appear in workspace lists/detail panes
- Permission counts stay accurate
- Resolved permissions disappear immediately

### 4. Extend the native runtime bridge shape if needed
**Files:**
- `src/agents/agent-runtime-types.ts`
- `src/lib/tmux-lite/agent-event-manager.ts`
- `src/lib/tmux-lite/machine/build.ts`
- `src/machine/state/selectors.ts`
- any UI projection files already consuming counts

**Change:**
If permission/question/status updates need richer payloads, extend the in-memory runtime state types — not the wire protocol.

Keep one representation:
- `WorkspaceAgentState`
- `ExternalSessionRuntimeState`
- `MachineAgentSessionRecord`
- `AgentSessionInfo`

No compatibility shims.

**Acceptance:**
- All UI consumers still derive the same visible behavior from machine snapshot / selectors

### 5. Remove extension loading from Pi session creation/opening
**Files:**
- `src/lib/tmux-lite/agents/pi-runtime.ts`
- `src/lib/tmux-lite/agents/pi-coordinator.ts`

**Change:**
Delete use of `getGitspacePiExtensionPaths()` from:
- `createAgentSession(...)`
- `openPiSession(...)`
- any PTY/legacy attach code still appending `--extension ...gitspace-status.ts`

Then delete:
- `getGitspacePiExtensionPaths()`
- `src/lib/tmux-lite/agents/extensions/gitspace-status.ts`
- empty extension directory if unused

**Acceptance:**
- No agent session loads GitSpace’s runtime extension anymore
- No code path references `gitspace-status.ts`

### 6. Remove sideband protocol and server plumbing
**Files:**
- `src/lib/tmux-lite/agents/pi-runtime-status.ts`
- `src/lib/tmux-lite/protocol.ts`
- `src/lib/tmux-lite/server.ts`
- `src/lib/tmux-lite/agent-control.ts`
- any tests referencing runtime secret/socket env vars

**Change:**
Delete:
- `PI_RUNTIME_SOCKET_ENV`
- `PI_RUNTIME_SECRET_ENV`
- `PI_RUNTIME_TERMINAL_SESSION_ENV`
- HMAC signing / verification helpers
- `sendPiRuntimeUpdate(...)`
- `buildPiRuntimeChildEnvironment(...)`
- `configurePiRuntimeEnvironment(...)` if nothing else uses it
- `pi-runtime-update` command in protocol
- `case 'pi-runtime-update'` in server
- `applyPiRuntimeUpdate(...)` from agent-control if unused after native bridge is in place

**Acceptance:**
- No sideband runtime update protocol remains
- Agent metadata is entirely sourced from in-process runtime state

### 7. Remove leftover PTY-agent assumptions
**Files:**
- `src/lib/tmux-lite/server.ts`
- `src/lib/tmux-lite/agents/pi-coordinator.ts`
- `src/machine/state/selectors.ts`
- any machine/session record builders

**Change:**
Delete comments/naming/filters that imply agent sessions are PTY-driven when they are now virtual-session driven.
Keep regular shell sessions PTY-based.

Examples to check:
- comments mentioning `agent PTYs`
- special-case kinds like `agent-pty` if obsolete
- legacy env injection for agent child processes

**Acceptance:**
- Code tells the truth: agent sessions are in-process virtual sessions

## Verification checklist

### Required automated verification
1. `bun run build`
2. `bun test src/lib/tmux-lite/agents/__tests__/virtual-terminal.test.ts src/lib/tmux-lite/agents/__tests__/virtual-terminal-integration.test.ts`
3. any targeted tests for agent state projection / selectors if touched

### Required manual verification
1. Open GitSpace TUI and attach to an agent session
   - renders correctly
   - typing works
   - resize works
2. Open web UI and attach to same agent session
   - renders correctly
3. Trigger an ask question
   - pending question appears in UI
4. Trigger a permission-needed flow
   - permission indicator/count appears
   - resolves when approved
5. Trigger retry/error case if reproducible
   - retrying/error state appears correctly
6. Confirm no logs mention extension loading or `pi-runtime-update`

## Order of execution
1. Native question/status/error bridge
2. Native permission bridge
3. Remove extension loading
4. Remove sideband protocol/runtime-status plumbing
5. Clean up PTY-agent vestiges
6. Run build/tests/manual checks

## Risk
The only serious risk is permission-state parity. Everything else already has a clear native event source.

If permission state cannot be sourced directly from the in-process SDK/runtime without the extension, then we must first add a tiny in-process bridge at the runtime boundary before deleting the extension. But we still should not keep the old sideband transport.
