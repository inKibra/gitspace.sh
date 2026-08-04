# Handoff: agent state desync, PTY jank, and workspace status priority

## Context

This workspace has multiple in-flight changes from prior work. Do not assume every modified file belongs to one change. Before editing, inspect the exact files you intend to touch and coordinate with the other active agent.

The main problem under investigation was inconsistent projected state and janky/slow browser PTY reproduction for agent sessions. Separately, two small workspace status priority changes were just implemented and verified.

## Latest completed change: workspace status priority

User expectation:
- A running service or terminal should not make a workspace green by itself.
- Agent state should drive non-error primary colors:
  - permission/question needed => orange
  - busy agent => green
  - idle/waiting agent => blue
  - no agents => dim
- Services/terminals should still contribute red on failures.

Files changed:
- `src/app/workspaces/workspace-status.ts`
- `src/app/workspaces/__tests__/workspace-status.test.ts`

Current behavior:
- `deriveWorkspaceStatusSummary()` no longer returns green from `services.green > 0` alone.
- `deriveWorkspacePrimaryColorFromMachineSummary()` no longer returns green from `runningProcessCount > 0` alone.
- Service/process/terminal failures still contribute red.

Verification run:
- `bun test src/app/workspaces/__tests__/workspace-status.test.ts`
- Result observed: 10 pass, 0 fail, 24 assertions.

## High-confidence root causes found for agent jank/desync

### 1. One stuck websocket command can block unrelated traffic

Code pointers:
- `src/serve/client-session-manager.ts:176-180`
  - Per-connection inbound queue serializes every message.
- `src/serve/client-session-manager.ts:271-275`
  - Attached agent commands are awaited in that serialized queue.
- `src/serve/client-session-manager.ts:379-381`
  - Attached command path awaits `sendTmuxLiteCommand()`.
- `src/lib/remote-session/session-handler.ts:1165-1190`
  - Generic typed command path awaits `sendTmuxCommand()` with no server-side timeout.
- `src/session/backends/remote-session-backend.ts:2058-2069`
  - Browser timeout only rejects browser promise; it does not unblock the server queue.

Why it matters:
- A hung command such as `get_notification_config` can leave subsequent attach/start/prompt/control messages queued behind it on the server.
- This matches symptoms: command timeout, stalled reattach, unresponsive start, tool calls blocked.

Suggested fix:
- Split traffic lanes:
  - PTY writes: ordered per pane, no long awaits.
  - attach/detach/resize: short per-pane control path.
  - typed commands: concurrent by requestId with server-side timeout.
  - agent prompt/permission/dialog: per-agent-session lane, not global websocket lane.

### 2. Machine snapshots overwrite fresher direct agent state

Code pointers:
- `src/session/backends/remote-session-backend.ts:1639-1643`
  - On `machine_snapshot`, client replaces snapshot, emits derived state, then assigns `agentStateCache = machineSnapshotToAgentState(message.snapshot)`.
- `src/session/backends/remote-session-backend.ts:2340-2415`
  - Direct `agent_state_update` deltas carry richer, fresher runtime state.
- `src/machine/state/selectors.ts:55-137`
  - `machineSnapshotToAgentState()` is lossy:
    - fabricated retry attempt/next time,
    - drops pending questions,
    - creates placeholder permission payloads.

Suggested fix:
- Treat direct `agent_state_snapshot`/`agent_state_update` as canonical for agent runtime.
- Add per-workspace/session revision or sequence.
- Do not let lower-fidelity machine snapshots overwrite newer direct agent state.

### 3. Multiple hand-written agent reducers diverge

Code pointers:
- `src/lib/tmux-lite/agent-event-manager.ts`
  - Canonical-ish server manager.
- `src/session/backends/remote-session-backend.ts:2340-2415`
  - Browser applies agent deltas independently.
- `src/commands/serve.ts:1088-1144`
  - Serve keeps `currentAgentSnapshot` using another partial reducer.

Observed differences:
- `src/commands/serve.ts:1096-1102` fallback state omits fields required by `WorkspaceAgentState`.
- `src/commands/serve.ts:1119-1120` ignores `agent_session_error`.
- Serve reducer does not handle question/todo/model/queued-message deltas fully.
- Remote question removal leaves an empty array, while canonical manager deletes empty entries.

Suggested fix:
- Introduce one shared `applyAgentDeltaToWorkspaceState()` / `applyAgentDeltaToAgentState()` and use it in all three places.

### 4. SDK engine and React hook event mapping diverge

Code pointers:
- `src/session/useSessionEngine.ts:51-174`
- `src/sdk/engine/engine.ts:72-168`

Concrete divergence:
- Hook preserves `script_output.workspaceId` at `src/session/useSessionEngine.ts:134-147`.
- SDK drops `workspaceId` at `src/sdk/engine/engine.ts:135-148`.
- Hook preserves session context on `session_exited`; SDK treats it like detach.

Suggested fix:
- Extract shared `backendEventToActions(backendKey, event): SessionEngineAction[]` and use it from both implementations.

### 5. Host UI dialog/working message state is backend-global, not agent-session-scoped

Code pointers:
- `src/session/types.ts:79-80`
  - One `pendingDialogRequest` and one `agentWorkingMessage` per backend.
- `src/session/reducer.ts:462-478`
  - Backend-global overwrite.
- `src/lib/tmux-lite/agents/host-ui-bridge.ts:22-53`
  - Dialog request includes `sessionId`.
- `src/lib/tmux-lite/agents/host-ui-bridge.ts:75-78`
  - Working message includes `sessionId`.
- `src/components/NativeAgentSurfaceConnected.web.tsx:24-25`
  - UI reads backend-global pending dialog/message.

Suggested fix:
- Store by `agentSessionId`:
  - `pendingDialogByAgentSessionId`
  - `workingMessageByAgentSessionId`
- `NativeAgentSurfaceConnected` should read using its resolved agent session id.

### 6. Multi-pane agent dialog ownership is single-session-per-socket

Code pointers:
- `src/lib/tmux-lite/server.ts:306-307`
  - Global maps: `agentSessionWatchOwners`, `agentDialogOwners`.
- `src/lib/tmux-lite/server.ts:3201-3207`
  - Agent attach calls `deleteOwnedEntries(agentSessionWatchOwners, socket)` and then owns only the newly attached session.
- `src/lib/tmux-lite/server.ts:326-335`
  - Dialog delivery requires owner for the specific session.
- `src/lib/tmux-lite/server.ts:490-497`
  - Missing owner throws `No watching client for session ...`.

Why it matters:
- In a browser with multiple visible agent panes over one websocket, attaching pane B can remove pane A's dialog ownership.

Suggested fix:
- Do not delete all prior owned agent sessions on attach.
- Track watcher ownership by `{connectionId, paneId, agentSessionId}` or allow each socket to own multiple agent sessions.
- Remove ownership on pane detach/socket close.

### 7. Same tmux session cannot be viewed by multiple panes without kicking

Code pointers:
- `src/lib/tmux-lite/server.ts:1735-1739`
  - Opening a session socket kicks any existing client.
- `src/session/backends/remote-session-backend.ts:735-783`
  - Remote backend can create multiple panes pointing at sessions.
- `src/lib/tmux-lite/agents/pi-coordinator.ts:528-537`
  - Agent attach reuses existing tmux session when one exists.

Implication:
- Multiple panes for different agent sessions can work.
- Two panes attached to the same underlying tmux session will fight; second attach kicks first.

Suggested fix:
- Either enforce one visible pane per tmux session in UI, or implement true multi-client fanout in tmux-lite session server.

### 8. Browser websocket has no send/backpressure boundary

Code pointers:
- `src/session/adapters/browser-remote.ts:29`
  - Direct `socket.send(data)`.
- `src/session/backends/remote-session-backend.ts:1329-1342`
  - PTY writes direct to websocket.
- `src/session/backends/remote-session-backend.ts:1994-2007`
  - Control writes direct to websocket.
- `src/serve/client-session-manager.ts:646-648`
  - Server forwards PTY frames to browser as they arrive.

Suggested fix:
- Add small browser send queue checking `WebSocket.bufferedAmount`.
- Prioritize control frames over PTY frames.
- Longer-term: pane-level ACK/high-low watermark so server can pause/resume per pane.

### 9. Replay requests use singleton pending state

Code pointers:
- `src/lib/remote-session/protocol.ts:57-64`
  - Replay frame has `requestId`.
- `src/lib/remote-session/protocol.ts:66-70`
  - Replay timeline has no `requestId`.
- `src/session/backends/remote-session-backend.ts:598-629`
  - Single global pending replay timeline.
- `src/session/backends/remote-session-backend.ts:632-685`
  - Dismiss/undismiss are singleton.

Suggested fix:
- Add requestId to all replay commands and store pending by requestId.

### 10. Inbox/notification mutations are not backend-scoped

Code pointers:
- `src/app.web.tsx:367-368`
  - Web reads inbox from active backend.
- `src/app/client/inbox.ts:43-68`
  - Clear/mark-read call multi methods with no backend scope.
- `src/sdk/engine/engine.ts:339-345`
  - SDK hard-routes clear/mark-read to local backend.
- `src/notifications/useNotifications.ts:147-155`
  - held/debounce/title maps keyed only by sessionId.
- `src/notifications/useNotifications.ts:171-175`
  - attach callback passes only sessionId.

Suggested fix:
- Add backend-scoped inbox mutations: `markInboxRead(backendKey, id)`, `clearInbox(backendKey, id)`.
- Carry `{backendKey, sessionId}` in notification/toast state.

## Smaller consistency findings

- Initial machine-watch sends duplicate snapshots:
  - `src/lib/tmux-lite/server.ts:2694-2700`
  - `src/lib/tmux-lite/server.ts:3385-3389`
  - Fix: send exactly one initial snapshot.

- Agent ask questions may remain stale on ask failure/interruption:
  - question add: `src/lib/tmux-lite/agents/pi-coordinator.ts:740-753`
  - question remove: `src/lib/tmux-lite/agents/pi-coordinator.ts:756-776`
  - Fix: clear/remove pending question on tool error/cancel/turn end.

- Agent runtime maps are keyed by bare `agentSessionId` in several places:
  - `src/lib/tmux-lite/agents/pi-coordinator.ts:183-188`
  - If Pi session ids are not globally unique, use `{workspaceId, agentSessionId}`.

- Relay logs cannot distinguish directory vs session websocket clients:
  - Directory: `src/relay-client/machine-directory-client.ts:96-100`
  - Session: `src/app/session/createSessionBackend.web.ts:93-95`
  - Fix: add `purpose=directory|session` query param and log it.

## Suggested implementation sequence

For a short, high-confidence fix pass:

1. Shared event mapping
   - Extract `backendEventToActions()` used by both `useSessionEngine` and `GitSpaceEngine`.

2. Shared agent reducer + revision
   - Implement `applyAgentDeltaToAgentState()`.
   - Use in `AgentEventManager`, remote backend, and serve snapshot reducer.
   - Add monotonic revision/sequence and ignore stale machine snapshot agent projections.

3. Split server message lanes
   - Remove global per-websocket await queue for long commands.
   - Add server-side timeouts.
   - Preserve ordering only where needed: per pane PTY, per agent command lane.

4. Scope host UI state by agent session / pane
   - Dialogs and working messages should not be backend-global.
   - Fix `agentSessionWatchOwners` to support multiple agent sessions per socket.

5. Add minimal websocket backpressure
   - Browser-side queue with `bufferedAmount` high/low marks.
   - Control frame priority.

6. Backend-scope inbox and notification operations
   - Avoid local/remote mutation mismatch.

## Tests to run for touched areas

Focused tests already used recently:
- `bun test src/app/workspaces/__tests__/workspace-status.test.ts`
- `bun test src/session/__tests__/remote-session-backend.test.ts src/session/__tests__/reducer.test.ts src/components/__tests__/session-terminal-tail-window.test.ts`
- `bun test src/lib/tmux-lite/process-tree.test.ts src/lib/tmux-lite/process-run.integration.test.ts src/commands/__tests__/process.test.ts src/app/client/processes.test.ts`

Known caveat from earlier session:
- Full typecheck/build had pre-existing repo/dependency issues; do not claim they pass unless re-run and observed.

## Current workspace status note

`git status --short` showed many modified/added files, including changes unrelated to the latest workspace-status fix. Coordinate before editing broad areas.
