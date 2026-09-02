FROM oven/bun:1.3.0 AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY patches ./patches
RUN bun install --filter @gitspace/machine --frozen-lockfile
# `/opt/gitspace/host.js` supervises generations; the shipped machine bundle
# lives in `/opt/gitspace/machine/` (`machine.js` + `drizzle/`) as the first one.
RUN mkdir -p /out/machine \
  && bun build packages/machine/src/host.ts packages/machine/src/rpc-probe.ts --target=bun --external omp-legacy-pi-modules --outdir=/out \
  && bun build packages/machine/src/runtime.ts --target=bun --external omp-legacy-pi-modules --outdir=/out/machine --entry-naming=machine.js

FROM docker.io/cloudflare/sandbox:0.12.9
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out /opt/gitspace
COPY --from=builder /app/node_modules/.bun/@oh-my-pi+pi-natives-linux-x64@18.0.6/node_modules/@oh-my-pi/pi-natives-linux-x64/pi_natives.linux-x64-modern.node /opt/native/pi_natives.linux-x64-modern.node
# Generations run from `$GITSPACE_ENVIRONMENT_ROOT/machine/generations/<hash>/`, so the
# addon must also sit next to the bun binary, which the natives loader probes regardless of bundle location.
RUN cp /opt/native/pi_natives.linux-x64-modern.node "$(dirname "$(which bun)")/pi_natives.linux-x64-modern.node"
COPY walgit /usr/local/bin/walgit
RUN chmod 0755 /usr/local/bin/walgit
COPY --from=builder /app/packages/core/drizzle /opt/gitspace/machine/drizzle
