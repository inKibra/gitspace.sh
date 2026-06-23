---
name: space-run-process
description: Run and inspect GitSpace workspace processes without masking startup, readiness, or crash failures.
---

# GitSpace Run Process

Use this skill when asked to start, restart, stop, inspect, or troubleshoot a workspace process.

## Contract

- Starting a process is not success; readiness is success.
- Report the command, cwd, effective env values relevant to behavior, and readiness proof.
- Do not run destructive or externally visible commands unless the user requested them.
- Prefer the workspace's process abstraction over ad-hoc shell commands when a process config exists.

## Current commands

Inside a workspace:

```sh
space service list
space service start --name web
space service stop --name web
space service attach --name web
space service open --name web --local
space events tail --filter processName=web --limit 50
```

Outside a workspace, use the `gssh workspace service ... --project <p> --workspace <w>` variants.

## State model

- `configured`: process exists in `.gitspace/processes.json`.
- `started`: GitSpace created or found a managed session.
- `running`: session has not exited.
- `ready`: explicit readiness event, health check, or URL response succeeded.
- `failed`: process exited non-zero, crashed, hit a port conflict, missed a dependency, or emitted an error event.
- `timed out`: no readiness proof arrived before the wait budget; report whether it is still running.

## Workflow

1. Inspect configured processes for the workspace.
2. Confirm non-secret env such as `PORT`, `HOST`, and API base URLs. Report secret presence/source only in masked form; never print secret values.
3. Start the configured service. For restart today, stop then start unless a dedicated restart API exists; verify the old instance exited first.
4. Watch service attachment/logs and recent events until ready, failed, or timed out.
5. If ready, verify the advertised URL or health check.
6. If failed, report the exact failed command, exit status, and relevant logs/events.

## Hooks into goal validation

Process output is often the evidence a goal requirement is asking for. Don't capture it separately from the validation contract:

- For `test-output` requirements with command generation, the rubric command is the process command. Wire it via `space goal requirement add --gen command --gen-command "<test command>" --judge command --judge-command "<test command>" --expect exit-zero`, then call `space goal artifact run --requirement "<title>"`. The run captures stdout/stderr/exit and auto-judges on exit-zero.
- For requirements that depend on process readiness (e.g. "API responds at /healthz"), prefer a command judgment that exits zero when readiness is observed (`curl --fail -sS http://127.0.0.1:$PORT/healthz`). Wire it as `--judge command --judge-command "<probe>" --expect exit-zero`.
- When attaching saved process logs as evidence, scope to a requirement: `space goal artifact attach --requirement "<title>" --path <log-path>`.
- A process being `ready` does not mark a goal requirement `accepted`. The mapping is explicit: a successful command judgment writes the review.
