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
