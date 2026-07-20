---
name: space-event-logs
description: Use GitSpace structured event logs to understand process lifecycle, readiness, errors, and correlated workflows.
---

# GitSpace Event Logs

Use this skill when asked to inspect app behavior, process lifecycle, or failures using event logs.

## Contract

- Event logs are observations. Use them to establish timing, correlation, and failure boundaries.
- Do not infer success from absence of errors.
- Prefer structured fields over free-text parsing.
- Preserve correlation ids when following a request, job, or workflow across events.

## Event format

GitSpace defaults to prefix-based wide events:

```text
@event {"event":"process.ready","eventId":"process.ready.123.1700000000000","timestamp":"2026-05-06T12:00:00.000Z","level":"info","message":"Server listening","processName":"web","port":5173,"url":"http://127.0.0.1:5173","correlationId":"startup-web-123"}
```

Expected fields:

- `event`: stable emitted event name, e.g. `process.start`, `process.url`, `process.ready`, `process.error`, `request.failed`.
- `eventId`: unique event id for show/detail lookup.
- `timestamp`: ISO timestamp from the emitter when possible.
- `level`: `debug`, `info`, `warn`, or `error`.
- `message`: human-readable summary.
- `processName`: process identity when the event is process-related.
- `correlationId`: canonical field for following related work. If the app has a domain `requestId`, copy it into `correlationId` or include both.

Current CLI note: the emitted payload field `event` is currently queried with `--event <name>` or `--filter eventName=<name>`.

## How to use events

1. Find the first event for the process or correlation id.
2. Follow state transitions in timestamp order: `process.start` -> `process.url` -> `process.ready` -> request/job events -> `process.exit`/`process.error`.
3. Negative cases matter: `process.start` without later `process.ready`, `process.error` before `process.exit`, ready URL emitted before actual readiness, and crashes after ready.
4. Compare event timestamps with terminal output and user-reported time.
5. For readiness, look for explicit `process.ready` and verify the URL separately when possible.
6. For failures, capture the earliest error event and the final exit/crash event.

## Query workflows

```sh
# Recent events for one process
space events tail --process web --limit 50

# Recent errors for one process
space events tail --process web --level error --limit 50

# Follow one request/workflow by correlation id
space events list --correlation-id req_123 --limit 200

# Oldest startup events in a time window
space events list --process web --since 30m --event process.start --head 20

# Bounded time window: --since and --until both accept a duration or ISO timestamp
space events list --process web --since 2h --until 30m --limit 200

# Control sort order explicitly (asc = oldest first, desc = newest first)
space events list --process web --since 1h --order asc

# Inspect one event in full
space events show --event-id evt_123
```

### `list --tail` vs `tail` — two different things

`--tail [n]` is BOTH a flag on `list` and a separate `events tail` subcommand.
They are not interchangeable:

- **`space events list --tail [n]`** — a *windowing* flag. `list` applies your
  filters across the log, then returns the NEWEST n of the matches. Its
  counterpart is `--head [n]` (oldest n). Use this when you want the last n
  events *matching a query*.
- **`space events tail`** — a *subcommand* with its own defaults (`--limit 50`
  rather than list's 100) and its own flag set. It is the "show me what just
  happened" verb, and it is the ONLY one that can stream: `--follow`.
  Without `--follow` it prints recent events and exits.

`tail` also takes `--event-id <id>` and `--correlation-id <id>`, so you can
follow a single correlated workflow live:

```sh
space events tail --correlation-id req_123 --follow
```

Both verbs share `--filter`, `--process`, `--level`, `--event`, `--event-id`,
`--correlation-id`, `--since`, and `--until`. Only `list` has `--head`,
`--tail`, and `--order`; only `tail` has `--follow`.

## Instrumentation guidance

- Emit `process.start` before launching expensive setup.
- Emit `process.url` when the intended URL is known.
- Emit `process.ready` only after the server is actually accepting traffic.
- Emit `process.error` with an error code/category; include stack traces only when safe.
- Emit `process.exit` with exit code and signal.
- Include `port`, `host`, `url`, `pid`, and `processId` when available.

## Evlog parity target

Use these logs to:

- review logging patterns: scattered logs, missing context, weak errors, and correlation gaps;
- guide wide-event adoption: event schemas, structured error fields, migration steps;
- analyze logs: debug failures, inspect slow operations, follow correlation ids, detect recurring patterns;
- compare startup events with process readiness and crash events.

## Hooks into goal validation

Events are observations. They become validation evidence only when scoped to a requirement and judged.

- Saved event excerpts can be attached as `test-output` or `note` evidence: `space events list --process web --since 5m > /tmp/web.log && space goal artifact attach --requirement "<title>" --path /tmp/web.log`.
- For an event-driven judgment (e.g. "process emits `process.ready` before the timeout"), wire the rubric as a command judgment whose command greps the event stream and exits zero on success: `--judge command --judge-command "space events list --process web --event process.ready --since 1m | jq -se 'length > 0'" --expect exit-zero`.
- Use `correlationId` to bind a workflow's events into one evidence bundle before attaching.
- `process.ready` is not a goal readiness signal. Goal readiness only comes from `space goal status` after requirements are judged.
