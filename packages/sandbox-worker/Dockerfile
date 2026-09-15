FROM rust:1.97.1-bullseye AS rust-toolchain

# Build every native dependency on the sandbox's glibc, using the same maintained
# pinned-source helper and authenticated machine tree as native distributions.
FROM ubuntu:22.04 AS builder
COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git build-essential protobuf-compiler libprotobuf-dev cmake clang pkg-config libssl-dev binutils unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY patches ./patches
RUN bun install --filter @gitspace/account-machine --filter @gitspace/account-omp --filter @gitspace/deployment --frozen-lockfile
# Cache is keyed by source pin, patch digest, toolchains, OS and architecture.
# The binary and patch snapshot remain inside the authenticated machine tree.
RUN --mount=type=cache,target=/native-cache GITSPACE_NATIVE_CACHE=/native-cache GITSPACE_RUNTIME_LAYER_COUNT=16 bun packages/sandbox-worker/scripts/build-runtime.ts

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
# No image-global WalGit: the selected machine owns native/walgit and its provenance.
RUN /opt/gitspace/machine/native/walgit --version && /opt/gitspace/machine/native/walgit --help >/dev/null
