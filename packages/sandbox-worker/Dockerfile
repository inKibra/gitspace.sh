FROM rust:1.97.1-bullseye AS walgit-builder
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler libprotobuf-dev cmake clang pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /walgit
RUN git init . && git remote add origin https://github.com/tobi/walgit.git && git fetch --depth 1 origin 6d8fa54ba0f83072a1a50317bb6c8c1afa5a3cd1 && git checkout --detach FETCH_HEAD
COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun
RUN cd web && bun install --frozen-lockfile && bun run build
RUN cargo build --locked --release -p walgit-cli && strip --strip-debug target/release/walgit

FROM oven/bun:1.4.0 AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY patches ./patches
RUN apt-get update && apt-get install -y --no-install-recommends binutils && rm -rf /var/lib/apt/lists/*
RUN bun install --filter @gitspace/account-machine --filter @gitspace/account-omp --filter @gitspace/deployment --frozen-lockfile
# The host bootstrap embeds the initial OMP manifest digest. Both payloads have
# their own native addons, source maps and authenticated sidecar inventory.
RUN GITSPACE_RUNTIME_LAYER_COUNT=16 bun packages/sandbox-worker/scripts/build-runtime.ts

FROM docker.io/cloudflare/sandbox:0.12.9
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client binutils && rm -rf /var/lib/apt/lists/*
# Each file exists in exactly one layer. Large native libraries get their own
# layer; the remaining files are packed into 128 MiB groups at build time.
COPY --from=builder /runtime-layers/00/ /opt/gitspace/
COPY --from=builder /runtime-layers/01/ /opt/gitspace/
COPY --from=builder /runtime-layers/02/ /opt/gitspace/
COPY --from=builder /runtime-layers/03/ /opt/gitspace/
COPY --from=builder /runtime-layers/04/ /opt/gitspace/
COPY --from=builder /runtime-layers/05/ /opt/gitspace/
COPY --from=builder /runtime-layers/06/ /opt/gitspace/
COPY --from=builder /runtime-layers/07/ /opt/gitspace/
COPY --from=builder /runtime-layers/08/ /opt/gitspace/
COPY --from=builder /runtime-layers/09/ /opt/gitspace/
COPY --from=builder /runtime-layers/10/ /opt/gitspace/
COPY --from=builder /runtime-layers/11/ /opt/gitspace/
COPY --from=builder /runtime-layers/12/ /opt/gitspace/
COPY --from=builder /runtime-layers/13/ /opt/gitspace/
COPY --from=builder /runtime-layers/14/ /opt/gitspace/
COPY --from=builder /runtime-layers/15/ /opt/gitspace/
# Native ABI compatibility includes the exact Bun version used by the builder.
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
# Build against glibc 2.31, below the sandbox's 2.35; never copy a host-linked binary.
COPY --from=walgit-builder /walgit/target/release/walgit /usr/local/bin/walgit
RUN /usr/local/bin/walgit --version && /usr/local/bin/walgit --help >/dev/null
