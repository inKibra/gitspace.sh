# Connection & State Management

This document describes how GitSpace handles WebSocket connections, disconnections, and terminal state synchronization.

> **Related:** See [PROTOCOL.md](./PROTOCOL.md) for message/frame format, [REMOTE-DESIGN.md](./REMOTE-DESIGN.md) for security model.

> **Implementation Note:** The web client (`src/web/`) currently lacks the
> auto-reconnection logic described below. While the relay connection has a
> 15-second heartbeat, neither the relay nor terminal connections implement
> exponential backoff reconnection. This is a known gap - disconnections
> require manual user intervention to reconnect.

## Overview

GitSpace uses a **stateful server, stateless client** model:

- **Server (tmux-lite)**: Maintains authoritative terminal state via xterm-headless
- **Client (browser/CLI)**: Just a view into server state, can be discarded and rebuilt

This means connection drops are trivial to handle - the client simply reconnects and gets the current state.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  Server (your machine)                 Client (anywhere)                    │
│  ┌─────────────────────────────┐       ┌─────────────────────────────┐      │
│  │                             │       │                             │      │
│  │  xterm-headless             │       │  xterm.js                   │      │
│  │  ┌───────────────────────┐  │       │  ┌───────────────────────┐  │      │
│  │  │ $ npm run dev         │  │◀─────▶│  │ $ npm run dev         │  │      │
│  │  │ > ready on :3000      │  │  wss  │  │ > ready on :3000      │  │      │
│  │  │ █                     │  │       │  │ █                     │  │      │
│  │  └───────────────────────┘  │       │  └───────────────────────┘  │      │
│  │                             │       │                             │      │
│  │  AUTHORITATIVE STATE        │       │  DISPOSABLE VIEW            │      │
│  │  (survives disconnects)     │       │  (rebuilt on reconnect)     │      │
│  │                             │       │                             │      │
│  └─────────────────────────────┘       └─────────────────────────────┘      │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Why Terminals Are Different

Unlike chat or event streams, terminals don't need message replay:

| Chat Stream | Terminal |
|-------------|----------|
| Every message matters | Only current screen matters |
| Miss a message = data loss | Miss output = just refresh |
| Need exactly-once delivery | Need current state |
| Offset-based replay | Screen buffer sync |

**The terminal screen is the data.** Old output that scrolled off is gone (or in scrollback). When reconnecting, the client just needs to know what's on screen right now.

---

## Connection Lifecycle

### Initial Connection

```
Client                          Relay                           Server
   │                               │                               │
   │  1. Connect to relay          │                               │
   │  ─────────────────────────▶   │                               │
   │                               │                               │
   │  2. Sign connect message      │                               │
   │  ─────────────────────────▶   │                               │
   │                               │  3. Route to machine          │
   │                               │  ─────────────────────────▶   │
   │                               │                               │
   │  4. X3DH handshake (4 phases) │                               │
   │  ◀════════════════════════════╪═══════════════════════════▶   │
   │                               │                               │
   │  5. E2E encrypted channel established                         │
   │  ◀════════════════════════════╪═══════════════════════════▶   │
   │                               │                               │
   │  6. Attach to session (encrypted)                             │
   │  ═══════════════════════════════════════════════════════▶     │
   │                               │                               │
   │  7. State sync (encrypted)    │                               │
   │  ◀═══════════════════════════════════════════════════════     │
   │                               │                               │
   │  8. Stream output (encrypted) │                               │
   │  ◀═══════════════════════════════════════════════════════     │
```

See [PROTOCOL.md](./PROTOCOL.md) for X3DH handshake details.

### Disconnection & Reconnection

```
Client                          Relay                           Server
   │                               │                               │
   │  streaming...                 │                               │
   │  ◀════════════════════════════╪═══════════════════════════    │
   │                               │                               │
   ╳  NETWORK DIES                 │                               │
   │                               │                               │
   │                               │  (relay notices client gone)  │
   │                               │  (server keeps running)       │
   │                               │  (xterm-headless continues)   │
   │                               │                               │
   │  (client detects disconnect)  │                               │
   │  (exponential backoff...)     │                               │
   │                               │                               │
   │  Reconnect                    │                               │
   │  ─────────────────────────▶   │                               │
   │                               │                               │
   │  Re-sign connect message      │                               │
   │  ─────────────────────────▶   │                               │
   │                               │                               │
   │  Re-attach (same session)     │                               │
   │  ═══════════════════════════════════════════════════════▶     │
   │                               │                               │
   │  State sync (CURRENT screen)  │                               │
   │  ◀═══════════════════════════════════════════════════════     │
   │                               │                               │
   │  Resume streaming             │                               │
   │  ◀════════════════════════════╪═══════════════════════════    │
```

**Key insight:** The server doesn't care that the client was gone. It just sends current state when asked.

---

## State Sync Protocol

### Attach Request

When a client attaches to a session (initial or reconnect):

```typescript
interface AttachRequest {
  type: 'attach';
  sessionId: string;
}
```

### State Sync Response

Server responds with complete terminal state:

```typescript
interface StateSync {
  type: 'state-sync';

  // Current screen buffer (ANSI-encoded)
  screen: string;

  // Cursor position
  cursorX: number;
  cursorY: number;

  // Terminal dimensions
  cols: number;
  rows: number;

  // Scrollback buffer (last N lines, ANSI-encoded)
  scrollback: string;

  // Process info
  title: string;         // Current process title
  cwd: string;           // Current working directory
}
```

### Incremental Output

After sync, server streams incremental output:

```typescript
interface Output {
  type: 'output';
  data: Uint8Array;  // Raw terminal output (ANSI sequences, text, etc.)
}
```

---

## Client Implementation

### Connection Manager

```typescript
class ConnectionManager {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000; // 30 seconds max

  constructor(
    private relayUrl: string,
    private credentials: Credentials,
    private terminal: Terminal,
  ) {}

  async connect(sessionId: string) {
    this.sessionId = sessionId;
    await this.establishConnection();
  }

  private async establishConnection() {
    try {
      this.ws = new WebSocket(this.relayUrl);

      this.ws.onopen = () => this.handleOpen();
      this.ws.onclose = () => this.handleClose();
      this.ws.onerror = (e) => this.handleError(e);
      this.ws.onmessage = (e) => this.handleMessage(e);

    } catch (err) {
      this.scheduleReconnect();
    }
  }

  private handleOpen() {
    this.reconnectAttempts = 0;

    // Authenticate
    this.send({
      type: 'auth',
      apiKey: this.credentials.apiKey,
    });

    // Attach to session
    this.send({
      type: 'attach',
      sessionId: this.sessionId,
    });
  }

  private handleClose() {
    this.ws = null;
    this.terminal.showDisconnected();
    this.scheduleReconnect();
  }

  private handleError(error: Event) {
    console.error('WebSocket error:', error);
    // onclose will fire next, triggering reconnect
  }

  private handleMessage(event: MessageEvent) {
    const msg = this.decrypt(event.data);

    switch (msg.type) {
      case 'state-sync':
        this.handleStateSync(msg);
        break;

      case 'output':
        this.terminal.write(msg.data);
        break;

      case 'error':
        this.handleServerError(msg);
        break;
    }
  }

  private handleStateSync(sync: StateSync) {
    // Clear terminal and render current state
    this.terminal.reset();
    this.terminal.resize(sync.cols, sync.rows);

    // Write scrollback first (if any)
    if (sync.scrollback) {
      this.terminal.write(sync.scrollback);
    }

    // Write current screen
    this.terminal.write(sync.screen);

    // Position cursor
    this.terminal.setCursor(sync.cursorX, sync.cursorY);

    this.terminal.showConnected();
  }

  private scheduleReconnect() {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.reconnectAttempts++;

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.establishConnection();
    }, delay);
  }

  // Send input to server
  sendInput(data: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Input during disconnect is discarded
      // User will notice and retype
      return;
    }

    this.send({
      type: 'input',
      data: data,
    });
  }

  // Send resize event
  sendResize(cols: number, rows: number) {
    this.send({
      type: 'resize',
      cols,
      rows,
    });
  }
}
```

### Reconnect Backoff

```
Attempt 1: wait 1 second
Attempt 2: wait 2 seconds
Attempt 3: wait 4 seconds
Attempt 4: wait 8 seconds
Attempt 5: wait 16 seconds
Attempt 6+: wait 30 seconds (max)
```

On successful connection, reset attempts to 0.

---

## Server Implementation

### Session State with xterm-headless

```typescript
import { Terminal } from 'xterm-headless';

class Session {
  private terminal: Terminal;
  private pty: IPty;
  private scrollback: string[] = [];
  private maxScrollback = 1000;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows });
    this.pty = spawn('bash', [], { cols, rows });

    // Capture output to both terminal and scrollback
    this.pty.onData((data) => {
      this.terminal.write(data);
      this.appendScrollback(data);
      this.broadcastOutput(data);
    });
  }

  getStateSync(): StateSync {
    // Serialize current screen buffer
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];

    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    return {
      type: 'state-sync',
      screen: this.serializeScreen(),
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      scrollback: this.scrollback.join('\n'),
      title: this.pty.process || 'bash',
      cwd: this.getCwd(),
    };
  }

  private serializeScreen(): string {
    // Use xterm's serialize addon or manual ANSI construction
    // Returns ANSI-encoded string that recreates the screen
    return serializeTerminal(this.terminal);
  }

  private appendScrollback(data: string) {
    // Simple line tracking for scrollback
    const lines = data.split('\n');
    this.scrollback.push(...lines);

    // Trim to max
    if (this.scrollback.length > this.maxScrollback) {
      this.scrollback = this.scrollback.slice(-this.maxScrollback);
    }
  }
}
```

### Client Attach Handling

```typescript
class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private clients: Map<string, Set<Client>> = new Map();

  attachClient(client: Client, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      client.send({ type: 'error', message: 'Session not found' });
      return;
    }

    // Track this client
    if (!this.clients.has(sessionId)) {
      this.clients.set(sessionId, new Set());
    }
    this.clients.get(sessionId)!.add(client);

    // Send current state
    client.send(session.getStateSync());

    // Client is now receiving output stream
  }

  detachClient(client: Client, sessionId: string) {
    const clients = this.clients.get(sessionId);
    if (clients) {
      clients.delete(client);
    }
    // Session continues running regardless
  }

  broadcastOutput(sessionId: string, data: Uint8Array) {
    const clients = this.clients.get(sessionId);
    if (!clients) return;

    for (const client of clients) {
      client.send({ type: 'output', data });
    }
  }
}
```

---

## Connection Health

### Heartbeat / Keepalive

WebSocket connections can silently die. We use ping/pong to detect this:

```typescript
// Server side
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 10000;  // 10 seconds to respond

class ClientConnection {
  private heartbeatTimer: Timer | null = null;
  private pongReceived = true;

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (!this.pongReceived) {
        // Client didn't respond to last ping
        this.disconnect('heartbeat timeout');
        return;
      }

      this.pongReceived = false;
      this.ws.ping();
    }, HEARTBEAT_INTERVAL);

    this.ws.on('pong', () => {
      this.pongReceived = true;
    });
  }
}
```

### Client-Side Detection

```typescript
// Client side
class ConnectionManager {
  private lastActivity = Date.now();
  private activityCheckInterval: Timer | null = null;

  startActivityCheck() {
    this.activityCheckInterval = setInterval(() => {
      const idle = Date.now() - this.lastActivity;

      if (idle > 60000) {
        // No activity for 60 seconds, check connection
        this.sendPing();
      }
    }, 30000);
  }

  private handleMessage(event: MessageEvent) {
    this.lastActivity = Date.now();
    // ... process message
  }
}
```

---

## Edge Cases

### Resize During Disconnect

If the user resizes their terminal while disconnected:

1. Client reconnects with new dimensions
2. Client sends `resize` message
3. Server resizes PTY and xterm-headless
4. Server sends fresh state-sync with new dimensions

```typescript
async reconnect() {
  await this.establishConnection();

  // Send current terminal size
  this.sendResize(this.terminal.cols, this.terminal.rows);
}
```

### Session Ended During Disconnect

If the session exits while the client was disconnected:

```typescript
handleMessage(msg: Message) {
  switch (msg.type) {
    case 'error':
      if (msg.code === 'SESSION_NOT_FOUND') {
        this.terminal.showSessionEnded();
        this.stopReconnecting();
      }
      break;

    case 'exited':
      this.terminal.showExitCode(msg.exitCode);
      this.stopReconnecting();
      break;
  }
}
```

### Input During Disconnect

**We discard it.** User will notice the connection is down and retype.

```typescript
sendInput(data: Uint8Array) {
  if (!this.isConnected()) {
    // Show visual indicator that input isn't going through
    this.terminal.showDisconnectedIndicator();
    return;
  }

  this.send({ type: 'input', data });
}
```

---

## Visual Feedback

The client should clearly indicate connection state:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CONNECTED                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ $ npm run dev                                                        │    │
│  │ > ready on http://localhost:3000                                     │    │
│  │ █                                                                    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                    [●]      │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  DISCONNECTED                                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ $ npm run dev                                                        │    │
│  │ > ready on http://localhost:3000                                     │    │
│  │ █                                                                    │    │
│  │                                                                      │    │
│  │           ┌─────────────────────────────────┐                        │    │
│  │           │  ⚠ Connection lost              │                        │    │
│  │           │  Reconnecting in 4s...          │                        │    │
│  │           └─────────────────────────────────┘                        │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                    [○]      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Summary

| Scenario | Handling |
|----------|----------|
| **Network blip** | Auto-reconnect with backoff, state sync |
| **Long disconnect** | Same - state sync gives current screen + scrollback |
| **Input during disconnect** | Discarded - user will retype |
| **Resize during disconnect** | Applied on reconnect |
| **Session died** | Error message, stop reconnecting |
| **Dead connection** | Heartbeat detection, trigger reconnect |

**The core principle:** The server always knows the truth. Clients just ask "what does the screen look like now?" and render it.

---

*Last updated: 2025-01*
