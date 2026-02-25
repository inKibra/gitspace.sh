FROM oven/bun:1.3.9

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  bash \
  lsof \
  && rm -rf /var/lib/apt/lists/*

RUN arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) cf_arch="amd64" ;; \
    arm64) cf_arch="arm64" ;; \
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}" -o /usr/local/bin/cloudflared; \
  chmod +x /usr/local/bin/cloudflared

WORKDIR /workspace
COPY . .

RUN bun install --frozen-lockfile

ENTRYPOINT ["bash", "/workspace/scripts/e2e/container/run-inside.sh"]
