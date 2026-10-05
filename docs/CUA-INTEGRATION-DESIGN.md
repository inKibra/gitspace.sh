# Cua Integration: Desktops for Workspaces

> **Status: Draft for planning.** Assumes the Pi runtime (`docs/PI-RUNTIME-DESIGN.md`) has landed: Workspace DO, `runtime-machine`, Chord, pi-durable tasks. Claims marked **[unverified]** need a spike before they become decisions.

## 1. Summary

Each GitSpace workspace can **open** or **pin** a desktop: a Cua Space (a Linux container, or a macOS/Windows/Linux VM) that the workspace agent and its people can see and operate. GitSpace owns which desktops a workspace has, where they run, who controls them, and their lifecycle. Cua owns running, streaming, and driving them.

- **Open:** a desktop for the current work. It is deleted when the workspace closes or is archived.
- **Pinned:** a desktop that belongs to the workspace until someone deletes it. It survives close and reopen, and the agent reattaches to it.

In GitSpace the user-facing name is **desktop**. "Space" already means a workspace inside GitSpace (`space_id`, `SpaceAuthorityDO`).

## 2. What Cua provides

From Cua's docs (trycua/cua, read 2026-10-02):

| Piece | What it is | License |
|---|---|---|
| cua SDK (`@trycua/cua` 0.2.0, Rust core with bindings) | Create, reuse, delete Spaces; shell, files, screenshots, input, windows, streams, presence, agents | MIT; prebuilt for Linux x64/arm64, macOS, Windows |
| `cua daemon` / `cua daemon mcp` | The SDK as a shared local service; MCP server with 33 Spaces tools and `group:action` permissions (`spaces:readonly`, ...) | MIT |
| cua-spacesd | Guest daemon in a Space on port 3211 (gRPC); shell, files, input, accessibility, media | **FSL-1.1-MIT** (`libs/cua-spacesd`) |
| Cua Driver | Accessibility tree, screenshots, background click/type/scroll on macOS, Windows, Linux | MIT |
| Lume | macOS VMs on Apple silicon | MIT |
| Cua Spaces app, Keyvault, Teleport, media protocol/transport, Cua Volume | Mac app, stream decoder (`stream_session`), Keyvault, session teleport, presence cursors | **FSL-1.1-MIT** (no competing products; each release becomes MIT after two years) |

Placement axes on every create: `on` (`local`, `cloud`, `direct:<addr>`, `aws`/`gcp`/`modal`), `kind` (`container`/`vm`), `runtime` (gVisor, runc, QEMU, Lume; KubeVirt in Cua cloud). Create reports progress phases `preparing → pulling → creating → booting → waiting_for_services → connecting → ready`. Media sessions are ticketed WebSockets carrying `h264` (or `bgra`/`png`) frames. Presence gives each participant a named cursor.

**License boundary (`trycua/cua` `LICENSING.md`).** The SDK, CLI, Cua Driver and Lume are MIT. Everything that makes a Space a *Space* is FSL: cua-spacesd (the guest daemon behind shell, files, streaming and presence), Teleport, Keyvault, the media protocol and transport, and the Spaces apps. **Decision (owner, 2026-10-02):** GitSpace integrates with Cua and is not a competing product, so using the FSL components unmodified as Cua ships them is in scope. GitSpace still does not vendor, fork, or redistribute FSL code.

## 3. Goals and non-goals

Goals:
1. A workspace lists its desktops; an agent or person opens one with one action, choosing image and location.
2. Pinned desktops persist across workspace close, reopen, and machine restarts of the workspace's agent.
3. The agent operates a desktop through typed tools: observe (accessibility tree plus screenshot), act, shell, files.
4. People watch any desktop of a workspace live in the GitSpace UI, each with their own cursor, and can take control and hand it back.
5. Desktops can reach the workspace's preview services, so an agent can test what it builds in a real browser or app.
6. Every desktop action is attributed and audited in the workspace history.

Non-goals (V1):
- Running coding agents *inside* a desktop (Cua's `agent_start`). The workspace agent stays in the Workspace DO and drives the desktop.
- Cua Cloud (metered) and the user's own AWS/GCP/Modal accounts. Later milestone (§12).
- Session Teleport from the user's Mac. Later milestone, behind Cua's Keyvault consent (§8.2).
- Replacing the GitSpace browser relay or Aperture (§10).

## 4. Concepts

```text
Workspace (Workspace DO)
└── gitspace.desktops            document, one row per desktop
    ├── desktop "web-e2e"        open    · linux container · on machine Darktop
    └── desktop "mac-build"      pinned  · macOS VM (Lume) · on machine Studio
```

| Concept | Meaning |
|---|---|
| **Desktop** | A Cua Space attached to exactly one workspace. GitSpace records it; Cua runs it. |
| **Host machine** | The GitSpace machine whose `runtime-machine` holds the cua SDK connection for the desktop. Local desktops run on it; `direct` desktops are reached through it. |
| **Retention** | `open` or `pinned`. Changing it is a document write, not a new desktop. |
| **Control lease** | At most one writer at a time: `agent`, a named person, or `none`. Observers are unlimited. |

### 4.1 `gitspace.desktops` document

```ts
type Desktop = {
  id: DesktopId;                       // GitSpace id (branded); never Cua's id
  name: string;                        // unique within the workspace
  retention: 'open' | 'pinned';
  placement:
    | { kind: 'machine'; machineId: MachineId; runtime: 'gvisor' | 'runc' | 'qemu' | 'lume' }
    | { kind: 'direct'; machineId: MachineId; address: string };   // existing cua-spacesd, reached via machineId
  image: string;                       // e.g. ghcr.io/trycua/linux:24.04, a macOS Lume image
  resources: { cpus: number; memoryMb: number; diskGb?: number; gpu?: 'paravirtual' | 'virgl' | 'nvidia' };
  services: Record<string, number>;    // named guest ports
  cua: { spaceId: string } | null;     // null until creation reaches ready
  lease: { holder: 'agent' | { userId: UserId }; since: string } | null;
  createdBy: Actor;
  createdAt: string;
};
```

Live status (`creating`, `ready`, `suspended`, `unreachable`, `deleting`) is derived from the host machine's reports and the open task; it is not stored as a field anyone writes by hand.

### 4.2 Tasks

Desktop lifecycle runs as pi-durable tasks in the Workspace DO, dispatched to the host machine:

| Task | Phases | Notes |
|---|---|---|
| `OpenDesktop` | validate placement → `Spaces.create` with progress → record `cua.spaceId` → apply lease | Progress phases stream to the UI through Chord. Creation uses a GitSpace `create_id`, so a retried phase cancels or adopts instead of creating twice. |
| `CloseDesktop` | release lease → close streams → `delete` → remove row | `open` desktops get this task when the workspace closes or archives. |
| `ReattachDesktops` | for each pinned row: resolve on host → mark ready or unreachable | Runs when the workspace or its host machine reconnects. Never recreates silently: a missing pinned desktop is reported, and recreating it is an explicit action. |

Workspace deletion lists pinned desktops and asks before deleting them.

## 5. Where desktops run

| Placement | How | Requirements | V1 |
|---|---|---|---|
| Linux container on a GitSpace machine | cua SDK in `runtime-machine`, `on: local`, gVisor or runc | Docker or Podman on the machine | Yes |
| Linux/Windows VM on a GitSpace machine | `on: local`, QEMU | KVM on the machine | Yes |
| macOS VM on a GitSpace machine | `on: local`, Lume | The machine is an Apple-silicon Mac on macOS 26+ | Yes |
| Existing cua-spacesd | `on: direct:<addr>`, reached from a GitSpace machine | Network path from that machine | Yes |
| User's AWS/GCP/Modal | Cua's cloud connectors | Cloud CLI sign-in on a machine; costs money | Later |
| Cua Cloud | `on: cloud` | cua.ai account; metered | Later |

- The cua SDK is **embedded** in `runtime-machine` (`embedded()`), not a separately managed `cua daemon`, so desktop lifetime follows GitSpace's process supervision. **[unverified]** that embedded mode exposes everything we need on Linux; fallback is a supervisor-managed `cua daemon` on a private socket.
- Machine capabilities (§7.2 of the runtime design) gain `desktops: { runtimes: [...], gpu: [...] }`, read from Cua (`Spaces.gpu_support`, local runtimes). The `machines` tool shows them; `desktops.open` fails early with the reason when nothing can host the requested image.
- WSL2 machines: gVisor/runc under Docker Desktop **[unverified]**; KVM is usually unavailable.

## 6. Agent tools

Desktop tools are machine tools routed to the desktop's **host machine**, not to the conversation's working-copy machine. This matches the runtime rule that agents choose a machine only when dispatching work: opening a desktop is a dispatch.

| Tool | Does | Cua call |
|---|---|---|
| `desktops.list` | Workspace desktops with status, lease, host, image | Document plus host status |
| `desktops.open({ name, image?, on?, kind?, resources?, services?, pin? })` | Starts `OpenDesktop`; returns when ready or with progress | `Spaces.create` (`reuse` for same name) |
| `desktops.pin` / `desktops.unpin` | Change retention | None |
| `desktops.close({ name })` | Starts `CloseDesktop` | `delete` |
| `desktop.observe({ name, window?, include: ['tree' \| 'screenshot'] })` | Accessibility tree with element references, optional screenshot; one compact result | Cua Driver tools via `call_tool` |
| `desktop.act({ name, observationId, target, action, args })` | Click, type, scroll, key, drag on an element from a specific observation; rejected when the agent does not hold the lease or the observation is stale | Cua Driver tools |
| `desktop.shell({ name, command })` | Run a command in the guest | `space_bash` / spacesd shell |
| `desktop.files` (`put`, `get`, `list`) | Move files between the working copy or `local://` and the guest, sha256-checked | spacesd files |
| `desktop.tools({ name })` / `desktop.call({ name, tool, args })` | Pass-through to Cua Driver or declared guest services | `list_tools` / `call_tool` |

Why typed tools instead of mounting `cua daemon mcp` through `pi-mcp`:
- GitSpace must decide placement, retention, leases, and audit; the raw MCP tools act with the machine user's full authority on every Space the daemon knows about, not only this workspace's.
- One routing table: desktop calls go through the relay to the host machine like other machine tools.
- `desktop.call` keeps the Driver's evolving tool surface available without re-wrapping each tool.

Observation follows the same principle as Aperture's browser runtime: references to observed elements rather than model-written selectors, freshness checks before input, screenshots only when asked.

## 7. People: viewing and control

### 7.1 Streaming in the browser

1. The UI asks the Workspace DO to view desktop `X`; the DO dispatches to the host machine.
2. `runtime-machine` mints a media session (`open_stream`, ticket plus WebSocket URL) and attaches with `attach_stream`.
3. Encoded `h264` frames travel to the browser over the GitSpace relay as a binary stream; the browser decodes them with WebCodecs `VideoDecoder` and draws to a canvas.
4. Input from the viewer goes back the same way and is sent as control messages (`send_control`) only when the viewer holds the lease.

The browser never talks to Cua's relay or to spacesd directly, so a desktop has the same trust boundary as the rest of the workspace (account Worker, relay, machine host). **[unverified]**: relay throughput for a 1080p stream, keyframe recovery after packet loss, and whether `attach_stream` frames are directly WebCodecs-compatible (Annex B vs AVCC). Spike D0 measures these.

### 7.2 Presence and control lease

- Every viewer and the agent join Cua presence with their GitSpace identity, so each has a labelled cursor.
- Writes require the **lease**. Requesting control as a person moves the lease to them and **mechanically** suspends the agent's `desktop.act`, `desktop.shell` input paths, and pass-through calls marked as input. The agent sees `lease_held_by_user` and waits.
- Handing back returns the lease; the agent's next `desktop.observe` is required before it can act (old observation IDs are invalidated).
- The agent requests help with the existing `ask` flow: "Take over desktop `web-e2e` to finish sign-in." The ask links straight into the viewer.

## 8. Credentials and secrets

### 8.1 What goes into a desktop

- No agent credential files are copied in: GitSpace sets `CUA_SPACES_AGENT_CREDENTIALS_HOME=none` for every create.
- Project secrets reach a desktop only through an explicit `desktops.open({ env })` naming secrets, under the same machine-trust rules as lifecycle runs. They are recorded by name, never by value.
- Provider tokens (model credentials) never enter a desktop.

### 8.2 Session Teleport (later)

Cua's Teleport moves a signed-in app session (for example a Chrome profile) from the user's Mac into a desktop. It only works through the Cua Keyvault: `teleport_app` returns a `request_id`, the user approves in the Cua app with Touch ID or the login password, and a retry delivers. GitSpace can surface the pending request and its manifest in the workspace, but approval stays in Cua; the automation caller can never self-approve. This needs the Cua app on the user's Mac, so it is opt-in and not available from Linux-only setups.

### 8.3 Three vaults

GitSpace's credential vault, Cua's Keyvault, and Aperture's planned credential manager would each hold browser credentials. V1 avoids the question: no stored-credential fill into desktops. Before adding any, decide one owner per credential and one realm rule, following Aperture's invariants (a credential has exactly one owner; realm checked before injection; plaintext never reaches the agent).

## 9. Workspace integration

- **Previews:** a desktop on the workspace's host machine reaches preview services on the host network **[unverified for gVisor networking]**. On another machine it uses the workspace's GitSpace service URL. `desktops.open({ services })` and the workspace `services` list are connected so the agent opens the right URL without guessing ports.
- **Artifacts:** `desktop.observe` screenshots and recordings go to `local://desktops/<name>/...` and can be attached to goals, journal entries, and QA reports.
- **History:** every desktop tool call is a normal tool call in the conversation; lease changes and human takeovers are journal entries, so the transcript explains who did what.
- **Environments:** later, `.gitspace/bundle.json` may declare named desktops (image, services, pin) so `materialize` can open them. Not in V1, matching the "minimal changes to environment scripts" rule.

## 10. Relationship to Aperture

Aperture (Inkibra draft, 2026-10-02) is a browser platform built on the **person's real Chrome** through an extension and CDP, with grants, capability URLs, takeover, recording, review, and a trusted-operator credential manager. It lists Computer Use as a possible future sibling and out of scope.

| | Aperture | Cua desktops |
|---|---|---|
| What is shared | A real person's browser tab, window, or browser | An agent-owned machine (container or VM) |
| Identity inside | The person's signed-in session, or delegated operator credentials | Whatever the desktop is given; agent-owned by default |
| Control surface | CDP, WebMCP, semantic browser use, Playwright | Accessibility tree and input on any app, shell, files |
| Owner | Standalone Inkibra platform | GitSpace integration over Cua |

They compose:
- Cua desktops are the "Computer Use sibling" Aperture deferred, without building it ourselves.
- A Chrome inside a desktop can run the Aperture extension, giving the agent Aperture's semantic browser runtime there with an **agent-owned** credential realm, distinct from any operator realm.
- Shared vocabulary to keep identical across both: grant, capability, control lease (one writer, mechanical suspension), takeover and hand-back, recording plus event timeline, credential owner and realm.

GitSpace should consume both through the same workspace-level concepts (a workspace has browsers and desktops; the agent holds or waits for leases), not two unrelated tool families.

## 11. Licensing

- MIT: `@trycua/cua` (SDK), `@trycua/cua-driver`, Lume.
- FSL, used as an integration (owner decision, §2): cua-spacesd in Cua's images, media sessions, Teleport and Keyvault through the user's Cua install. Not vendored, forked, or redistributed by GitSpace.
- Pin exact versions (SDK is 0.2.0) behind `runtime-machine`; only that package imports Cua, mirroring the Pi dependency rule.

## 12. Milestones

| ID | Milestone | Exit criteria |
|---|---|---|
| **D0** | Spike | On a Linux GitSpace machine: embedded SDK creates `ghcr.io/trycua/linux:24.04`, runs a shell command, returns an accessibility tree and screenshot, streams h264 to a browser over the GitSpace relay with WebCodecs; measure latency and bandwidth. Repeat create on a Mac machine with Lume. |
| **D1** | Desktops in workspaces | `gitspace.desktops` document; `OpenDesktop`/`CloseDesktop`/`ReattachDesktops` tasks; open vs pinned; machine capabilities; `desktops.*` tools; desktop list in the Inspector with create progress. |
| **D2** | Agent operation | `desktop.observe`/`act`/`shell`/`files`/`tools`/`call`; observation freshness; audit in history; screenshots to `local://`. Golden test: agent opens a desktop, loads the workspace preview, completes a scripted UI flow. |
| **D3** | People | Live viewer in the UI, presence cursors, lease and takeover, `ask` deep-link to takeover. |
| **D4** | Beyond the machine | `direct` placement polish, user cloud accounts (with explicit cost approval), Teleport requests surfaced from the Cua Keyvault. |

## 13. Risks

| Risk | Mitigation |
|---|---|
| Cua is young (SDK 0.2.0) and changes fast | Exact pins; only `runtime-machine` imports it; D0 tests gate upgrades. |
| Stream over the GitSpace relay is too slow or too heavy | Measure in D0; fall back to lower resolution and frame rate, or a direct LAN path when viewer and machine share a network. |
| Desktops consume machine CPU/RAM next to builds | Resource limits on create; machine capability reports free capacity; refuse instead of overcommitting. |
| Pinned desktops outlive their purpose and cost money in clouds | Pinned rows are visible per workspace; workspace deletion asks; cloud placements (later) carry Cua's TTL and sweep. |
| Raw pass-through (`desktop.call`, `desktop.shell`) acts with broad authority inside the guest | Desktops are agent-owned machines with no personal credentials by default (§8.1); lease gating; audit. |

## 14. Open questions

1. Should one desktop be shareable between workspaces of the same project (for example a shared macOS build VM), or is "exactly one workspace" a hard rule?
2. Is a desktop's lease per desktop or per window?
3. Do subagents (multi-machine level 2) get their own desktops, or borrow the parent's under the lease?
4. Recording: Cua media plus our event timeline, or Aperture's recorder when the activity is in a browser?
5. When Aperture ships, does GitSpace's browser relay become an Aperture consumer, and do desktops run its extension by default?

## 15. References

- Cua: https://spaces.cua.ai/, `cua.ai/docs` pages `spaces/guides/use-from-an-agent`, `spaces/reference/{cloud,teleport}`, `cua-driver`, `cua-sdk/concepts/how-sandboxes-work`, `cua-sdk/reference/spaces/{create,streams}`, `cua-sdk/reference/spacesd/media`, `cua-cli/guides/mcp-server`; npm `@trycua/cua` 0.2.0 (MIT), `@trycua/cua-driver` 0.32.0 (MIT); GitHub `trycua/cua`.
- `docs/PI-RUNTIME-DESIGN.md`: Workspace DO, tasks, machine routing, placement, QA queue, type system.
- Aperture draft (Inkibra, 2026-10-02): grants, control lease, takeover, credential realms.
