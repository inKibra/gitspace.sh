---
name: space-process-config
description: Configure and start GitSpace workspace processes with explicit ports, health checks, and observable events.
---

# GitSpace Process Config

Use this skill when asked to configure, run, debug, or instrument workspace processes such as dev servers, workers, preview apps, or background services.

## Contract

- A process config must tell operators how the process starts, how it chooses a port, how readiness is detected, and where failures surface.
- Do not hide port selection. If a server needs `PORT`, set it explicitly or document the default and collision behavior.
- Prefer one process per independently observable service.
- Make process output machine-observable when possible: emit structured event lines for lifecycle, URL, readiness, errors, and shutdown.
- Never claim a process is ready until a health check, URL response, or explicit readiness event proves it.

## `.gitspace/processes.json` shape

Teach the actual GitSpace process config file, not an invented readiness schema:

```json
{
  "processes": [
    {
      "name": "web",
      "command": "bun",
      "args": ["run", "dev"],
      "cwd": ".",
      "env": {
        "HOST": "127.0.0.1"
      },
      "ports": [{ "name": "web", "protocol": "http" }],
      "events": { "enabled": true },
      "restart": "on-failure"
    }
  ]
}
```

Current process config supports command/args/cwd/env/instances/autostart/restart/events/ports. It does not currently have first-class readiness-check or stop-timeout fields, so readiness must be emitted by the process and verified by the operator/agent.

## Starting a server with process config

When adding a dev server process:

1. Pick a stable process id, e.g. `web`, `api`, `worker`.
2. Choose the command exactly as a maintainer would run it.
3. Set `cwd` to the workspace path or the package directory that owns the command.
4. Declare `ports` so GitSpace can allocate/expose ports and inject process env.
5. Prefer `HOST=127.0.0.1` for local-only development unless remote/browser access requires otherwise.
6. Configure the process to emit a valid `process.ready` event after bind.
7. Verify readiness with a health check, URL response, or explicit readiness event; do not imply start success equals readiness.

## PORT instrumentation

With managed ports, GitSpace can inject:

- `PORT`
- `GITSPACE_PORT_<NAME>`
- `GITSPACE_PORTS_JSON`

A server should read the injected port when present and then report the actual bound port after `listen()` succeeds. Requested/default port, GitSpace allocated port, fallback port, and actual bound port are distinct; logs must not conflate them.

```ts
const requestedPort = Number(process.env.PORT ?? process.env.GITSPACE_PORT_WEB ?? 5173);
const host = process.env.HOST ?? '127.0.0.1';

server.listen(requestedPort, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : requestedPort;
  const now = new Date().toISOString();
  const eventId = `process.ready.${process.pid}.${Date.now()}`;

  console.log(`@event ${JSON.stringify({
    event: 'process.ready',
    eventId,
    timestamp: now,
    level: 'info',
    message: 'Server listening',
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    pid: process.pid,
    processName: 'web',
    correlationId: eventId,
  })}`);
});
```

If the server auto-selects a fallback port, capture the actual bound port from `server.address()` and emit that. Do not keep reporting the requested port after fallback.

## Failure handling

- Port in use: surface the port and process id that failed; suggest either stopping the owner or choosing a new configured port.
- Missing dependency: report the missing binary/package and the install command already used by the repo, if observed.
- Readiness timeout: include last output lines and whether the process is still running.
- Crash after ready: preserve exit code, signal, and recent events.
