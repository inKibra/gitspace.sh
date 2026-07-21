# Plan: Native `ask` tool dialog (Approach B)

**Goal:** Make the pi/omp agent's `ask` tool work in GitSpace's web UI with a faithful
multi-question dialog (multi-select, recommended default, inline "Other" free-text),
rendered through GitSpace's own host-UI dialog pipeline — not the SDK's TUI-only path.

**Status:** Investigated & designed. Not started. This doc is a handoff for an implementing agent.

---

## Background / why `ask` is currently unavailable

- The SDK's builtin `ask` tool is `createIf(f){ return f.hasUI ? new AskTool(f) : null }` and its
  `execute` does `if(!ctx.hasUI || !ctx.ui) throw` — it requires a bound UI context at run time.
- It renders by **looping `ctx.ui.select(...)`** — single-choice per question. Lossy: no multi-select,
  no inline "Other", no multi-question view.
- **`ExtensionUIContext` has no `ask` method** (`node_modules/@oh-my-pi/pi-coding-agent/dist/types/extensibility/extensions/types.d.ts`).
  It has `select/confirm/input/editor/custom/...`. The builtin `ask` only ever calls `select`.
- GitSpace's host UI bridge (`OmpHostUIContext`) implements a **subset** (`select/confirm/input/editor/notify/status/widget/...`)
  and excludes the low-level `custom()` component path, which "falls through to the Pi TUI fallback" — GitSpace has no real TUI,
  so anything needing `custom()` can't render.

### Why we can't just register a replacement tool
- **No settings-level tool disable** (`disabledTools`/`allowedTools`) exists in the SDK surface.
- `customTools` is documented as **"in addition to built-in tools"** and `normalizeToolNames` dedups
  "first-seen order" → a same-named custom `ask` most likely **collides rather than overrides**.
- Extension hooks can't substitute a tool: `tool_call` result is `{block?, reason?}` (**block-only**, returns an
  error to the model); `tool_result` only **replaces content post-hoc** (after execution; can't collect input there).

### The lever: patch the SDK (already an established GitSpace mechanism)
`package.json` → `patchedDependencies` already patches `@oh-my-pi/pi-coding-agent@16.3.4` and
`@oh-my-pi/pi-agent-core@16.3.4` (see `patches/`), with small surgical additions. We use the same mechanism:
teach the builtin `ask` to call a new optional `ExtensionUIContext.ask()` when the host provides one,
falling back to today's `select`-loop otherwise. **No tool-registry override, no `hasUI` gating change, no builtin disable.**

---

## Data shapes (mirror the SDK ask schema)

Request (server → client), added to `HostUIDialogRequest`:
```ts
{
  type: 'ask';
  id: string;
  sessionId: string;
  questions: Array<{
    id: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    multi?: boolean;
    recommended?: number; // index of default
  }>;
}
```
Response (client → server), added to `HostUIDialogResponse`:
```ts
{
  type: 'ask';
  id: string;
  results: Array<{
    id: string;
    selected: string[];    // chosen option labels (1 for single, N for multi)
    customInput?: string;  // "Other" free text
  }>;
}
```

---

## Implementation steps

### 1. SDK patch — route builtin `ask` through the host (the enabling change)
Patch `@oh-my-pi/pi-coding-agent@16.3.4` (via `bun patch`, add to `patchedDependencies`):
- Add optional `ask?(questions): Promise<AskResult>` to the `ExtensionUIContext` interface
  (`src/extensibility/extensions/types.ts`).
- In the `ask` tool's `execute` (`src/tools/ask.ts` or wherever `AskTool` lives in the published `src/`):
  if `typeof ctx.ui.ask === 'function'`, call `ctx.ui.ask(questions)` and map its results to the tool result;
  otherwise keep the existing `select`-loop fallback.
- Keep `createIf`/`hasUI` gating unchanged (GitSpace already passes `hasUI: true`).
> The existing patches diff against `src/...`, so the published package ships source — same workflow. Keep the diff minimal.

### 2. `src/lib/tmux-lite/agents/host-ui-bridge.ts`
- Add `ask` variant to `HostUIDialogRequest` (union starts line ~22).
- Add `ask` variant to `HostUIDialogResponse` (union line ~59).
- Extend **`isValidDialogResponseValue`** (line ~137) with an `ask` case — it currently `return false`s for
  unknown types, so an `ask` response is rejected until handled.
- Add `ask()` to the context built in `createContextForSession` (line ~174) → `this.requestDialog({ type:'ask', ... })`.
  `requestDialog` (line ~316) / `resolveDialog` (line ~281) / `PendingDialog` (line ~130) widen off the union automatically.

### 3. `src/lib/tmux-lite/agents/omp-types.ts`
- Add `ask(questions): Promise<AskResult>` to the `OmpHostUIContext` interface (~line 93).

### 4. `src/lib/tmux-lite/protocol.ts` — no structural change
- `agent-dialog-request { request: HostUIDialogRequest }` (line ~572) references the union, so `ask` rides along.
- Confirm the response carrier references `HostUIDialogResponse` the same way (widens automatically).

### 5. Client backend
- `src/session/backends/remote-session-backend.ts` (line ~2047) already forwards `message.request` verbatim — no change.
  Widen **`sendDialogResponse`**'s signature/typing to accept the `ask` response shape.
- `src/session/backend-event-actions.ts` (line ~91, `host_ui_dialog_request`) — passes through; verify no narrowing.

### 6. Web — the one real new component
- `src/components/HostUIDialogs.web.tsx`: add an **`AskDialog`** for `request.type === 'ask'` (siblings: select @96, confirm @143, input @178, editor @232).
  - Per question: radio (single) vs checkbox (multi); mark `recommended` as default; an "Other" row → free text.
  - On submit: `onResponse({ type:'ask', id, results })`.
- Wire it into the dialog switch in `src/components/NativeAgentSurface.web.tsx` (`pendingDialog` @46, `onDialogResponse` @52)
  and confirm `NativeAgentSurfaceConnected.web.tsx` `handleDialogResponse` (@161) forwards it.

### 7. (Optional) inline transcript rendering
- `PaneTerminalPanel.web.tsx` already renders `q:<id>` question blocks for `select` (line ~123). Optionally render `ask`
  the same inline way for a nicer in-transcript experience; not required for correctness.

---

## Verification
1. `bun run typecheck` (unions + signatures).
2. Restart the machine daemon (see below) and drive an agent turn that calls `ask` with (a) a single-choice question,
   (b) a multi-select question, (c) a question exercising "Other" free text.
3. Confirm the dialog renders on web, the answer round-trips (`sendDialogResponse` → `resolveDialog`), and the tool result
   reaches the model. Verify no `ask tool isn't available` / abort.
4. Confirm the `select`-loop fallback still works when the host doesn't implement `ask` (e.g., pure TUI).

## Restart notes
- The `ask` wiring lives in the **machine daemon** (tmux-lite serve process). Restart it to pick up server-side changes
  (from source: restart `bun src/index.ts machine serve …`; compiled: `bun run build` then restart).
- Web component changes need the app **web build/reload**.
- Patch changes require a reinstall so `patchedDependencies` re-applies (`bun install`).

## Open items / risks
- **`createIf`/`hasUI` timing:** on the failing session, confirm whether the builtin `ask` was absent (UI context not bound
  yet) vs present-but-aborting. Doesn't block B (the patch routes through `ctx.ui.ask` regardless), but may reveal a
  separate binding-order fix worth making.
- Keep the SDK patch tiny and re-check it against future `@oh-my-pi/pi-coding-agent` bumps (patches are version-pinned:
  `@16.3.4`).

## Explicitly out of scope (separate effort)
- **Async job manager.** Proven SDK behavior: a session gets its own manager only if no process-global singleton exists
  (`(!parentTaskPrefix && !AsyncJobManager.instance()) ? new AsyncJobManager(...) : undefined`). In GitSpace's
  one-process-many-agents daemon, only the first agent gets one. Enabling it for every agent requires **per-agent
  process/worker isolation**, not a flag — track separately (it also relieves the daemon event-loop overload).
