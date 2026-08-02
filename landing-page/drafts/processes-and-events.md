---
status: DRAFT (markdown only — promote to an interactive episode later)
series: The agent fleet
working-title: What's running, and what happened
topic: the GitSpace process manager + the event capture system
grounded-in: real code (see "Notes for the episode build" at the bottom for file:line refs)
---

# What's running, and what happened

When you hand a task to a coding agent, it does more than write code. It starts a
dev server. It runs a worker. It prints a wall of logs. Then it tells you it is
done, and you are left with a terminal you did not open and output you never read.
Run one agent and you can squint at it. Run a fleet and you have no idea what is
running or what just happened.

GitSpace treats both as first-class: the processes your agents run, and the events
those processes throw off. Here is how, and the one rule that holds it together.

## A service is a tracked thing

A service starts life as a declaration in `.gitspace/processes.json`: a name, a
command, its ports, a restart policy. You start it with a command, not by typing
`npm run dev` into a shell and hoping.

```
$ gssh space service start --name web
web#1 started

$ gssh space service list
web#1 running
  http (http:31847)
    local:  http://localhost:31847
    remote: https://acme.gitspace.sh
```

It runs inside the tmux-lite daemon, not as a loose child of your shell, so it
outlives the terminal, carries a name, and you can attach to it later. Four
details make it more than a wrapper around spawn.

**Its port is stable.** The port is not random. It is seeded from a hash of the
workspace, the service, and the port name, searched over the 17000 to 47000 range.
So `web` in this workspace lands on the same port every run. Your local URL stops
moving between restarts.

**Stopping it kills the whole group.** A dev server spawns node, which spawns
esbuild. Kill node the naive way and esbuild lives on, holding your port. GitSpace
reads the POSIX process group and signals the group, so the orphan never happens.

**It restarts on your terms.** A policy of `never`, `on-failure`, or `always`,
with exponential backoff, and a watchdog that reconciles every five seconds. An
`on-failure` service that exits clean stays down; one that crashes comes back.

**It knows the difference between your process and a stranger's.** If the port is
already taken, GitSpace walks the offending process up its parent chain. If the
squatter is another GitSpace service, it offers to stop it. If it is some
unmanaged process, it offers to kill that pid, then waits for the port to actually
free before it starts. No blind `EADDRINUSE`.

## The rule: a snapshot never writes

Here is the principle underneath all of it. Reading the state of the fleet must
never change the fleet.

It sounds obvious until you watch it get violated. Just *listing* your services
could steal a running server's port, if the list path allocated ports the way the
start path does. So GitSpace splits them: one function allocates and may move a
port, and only `start` calls it. A second function only reads, and every reporting
and routing path uses that one. The read path never probes with `lsof` and never
writes a file.

That last point is not fussiness. The daemon is single threaded. One unbounded
`lsof` inside a snapshot build freezes the whole server, and then nothing
connects. So the port reader bounds `lsof` to two seconds and treats a timeout as
"no listener." The same rule shows up verbatim in the port allocator, the workspace
snapshot, and the trace log: watching stays cheap, and it cannot wedge the thing it
watches.

## Four ways to capture an event

GitSpace does not run everything through one event bus. It has four channels,
because each one has a different worst case, and a design tuned for capturing
history is the wrong design for surviving a freeze.

### Wide events: print, and it is captured

The runner reads a service's stdout one line at a time. Print plain text and you
get a log event. Print a JSON object and you get a structured event. Add a
`requestId` and every line sharing that id folds into one evolving snapshot with a
keyed timeline. Same pipe, three levels of structure, and nothing is thrown away
for a missing field. GitSpace calls it graceful fidelity: you never install a
logging SDK to get structured logs, you just print better.

Events land as NDJSON under `.gitspace/events/processes/`, and each file ships with
an index sidecar recording its time span, its levels, and its event names, so a
query can skip whole files instead of scanning them. You read it back with a
filter:

```
$ gssh space events tail --follow --level error --since 30m
```

### Agent events: the live mirror

A second channel lives only in memory, per workspace: which agent sessions are
running, which are blocked on a permission, which asked you a question. This is
what colors the fleet green, amber, and blue.

Every field is capped the moment it comes in. That is not housekeeping. The whole
agent state gets serialized into each machine snapshot, and one unbounded field
once turned that serialization into a multi-second stall that wedged the daemon.
So an error caps at 4000 characters, a queued message at 2000, the queue at 20
messages, the todo list at 200. A small data bug had become a systemic failure,
and the fix was a cap.

### The runtime trace: forensics that survive a freeze

Thirty-four points inside the daemon each write a single JSON line to
`.agent/gitspace-runtime-trace.jsonl` on command, snapshot, and agent boundaries,
and also push it to a 400-entry ring in memory. The write is synchronous on
purpose. It lands on disk before a freeze can strand a buffered async write, and
because it only fires on boundaries and not on every keystroke, the cost is under a
millisecond.

When the daemon still answers, "report a problem" reads the ring. When the daemon
is wedged, the relay tails the file from the outside. This is the one channel built
to be readable at the exact moment everything else has stopped responding.

### The phase journal and edit breadcrumbs: provenance you did not write

The last channel is durable and committed to git. You do not author the record.
The agent supplies its intent and its outcome; the system snapshots the rest,
which requirements advanced, which reviews resolved, which files changed, and then
commits the code repo with the outcome as the headline. Commit order becomes the
story of the work by construction.

Underneath it, every mutating tool call an agent makes, every write and edit and
bash and patch, drops a breadcrumb: a timestamp, the session, the file. At the end
of the turn it flushes append-only to `blame/edits.jsonl` on the artifacts branch.
So when you later ask which change first touched a line, attribution is a lookup,
not a fuzzy guess after the fact.

## What you can answer now

- What is running: `service list`.
- What happened: `events tail`.
- Why it broke: the trace.
- Where a line came from: the journal and the breadcrumbs.

None of those answers moved a port, killed a server, or wedged the daemon. That is
the whole design in one sentence: know what your fleet is doing, and never disturb
it to find out.

---

## Notes for the episode build (not part of the post)

Interactive island ideas, one per section, in the ep01/ep02 style:
- **service-list** — a live `service list` with the state pips (running green, failed
  red), the hash-stable port, and local/remote URLs. Toggle a restart to show
  backoff.
- **kill-the-group** — a small process tree (dev → node → esbuild); click "kill
  parent" and watch the orphan survive, then "kill group" and watch it all go.
- **graceful-fidelity** — three toggle states of the same stdout line: plain string
  → JSON event → correlated snapshot folding N lines into one keyed timeline.
- **four-channels** — a 2x2: wide events (NDJSON + index), agent events (in-memory,
  capped), runtime trace (sync jsonl + ring), journal/breadcrumbs (git). Each cell
  names its worst case.
- **the-snapshot-rule** — animate the read-vs-start port split: a "list" that
  (wrongly) steals a port vs the real read path that cannot.

Ties into the series: this is the operational floor under "Fleet Green" (Nº 01) and
the provenance layer that feeds the change guide (Nº 03) and agent-blame (Nº 05) —
the breadcrumb log is literally where the change guide's attribution comes from.

Source references (for the proof / accuracy pass):
- Process manager: `src/lib/processes/manager.ts:53`, `runner.ts:71`,
  `allocations.ts:173` (hash-seeded ports) & `:284` (read vs start split),
  `ports.ts:6` (lsof timeout) & `:76` (managed vs unmanaged conflict),
  `src/lib/tmux-lite/process-tree.ts:19` (group signal),
  `workspace-runtime.ts:22` (running/failed counts), CLI `src/commands/process.ts`.
- Wide events: `src/lib/events/collector.ts:140` (fidelity) & `:403` (snapshots),
  `src/types/events.ts:39`, storage `src/lib/events/paths.ts`, CLI
  `src/commands/events.ts`.
- Agent events + the cap incident: `src/lib/tmux-lite/agent-event-manager.ts:72`.
- Runtime trace: `src/utils/trace-log.ts:37` (sync-write rationale), consumer
  `src/lib/tmux-lite/problem-report.ts`.
- Phase journal + breadcrumbs: `src/core/phase-journal.ts:326`,
  `src/lib/tmux-lite/agents/edit-breadcrumbs.ts:19`.

Verify the exact `service list` and `events tail` output shapes against the real
CLI before publishing (the blocks above are close but should be captured live).
