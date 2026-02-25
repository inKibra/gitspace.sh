#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/workspace"
SPRITE_STATE_FILE="/tmp/gssh-test-sprite.state"
GITSPACE_API_BASE="${GITSPACE_API_URL:-https://api.gitspace.sh}"

required_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    printf "Missing required env var: %s\n" "$key" >&2
    exit 1
  fi
}

required_env E2E_SUBDOMAIN
required_env GITSPACE_TOKEN_INPUT
required_env SPRITES_TOKEN_INPUT
required_env E2E_DEVICE_FINGERPRINT

KEEP_ON_FAIL="${KEEP_ON_FAIL:-0}"

HOST_RESERVED="0"
SPRITE_NAME=""
TUNNEL_TOKEN=""

release_subdomain() {
  bun -e '
    const apiBase = process.env.GITSPACE_API_BASE;
    const token = process.env.GITSPACE_TOKEN_INPUT;
    const subdomain = process.env.E2E_SUBDOMAIN;
    const fingerprint = process.env.E2E_DEVICE_FINGERPRINT;
    if (!apiBase || !token || !subdomain || !fingerprint) process.exit(1);

    const res = await fetch(`${apiBase}/subdomains/${encodeURIComponent(subdomain)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Device-Fingerprint": fingerprint,
      },
    });

    if (res.status === 404) process.exit(0);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`release failed (${res.status}): ${body}`);
      process.exit(1);
    }
  '
}

cleanup() {
  local exit_code=$?
  local should_keep="0"

  if [[ "$exit_code" -ne 0 && "$KEEP_ON_FAIL" == "1" ]]; then
    should_keep="1"
  fi

  if [[ "$should_keep" == "1" ]]; then
    printf "\n[keep-on-fail] Preserving resources for debugging.\n"
    printf "Subdomain: %s\n" "$E2E_SUBDOMAIN"
    if [[ -n "$SPRITE_NAME" ]]; then
      printf "Sprite: %s\n" "$SPRITE_NAME"
    fi
    printf "Relay state file: /tmp/gssh-test-relay.state\n"
    printf "Sprite state file: %s\n" "$SPRITE_STATE_FILE"
    return
  fi

  if [[ -n "$SPRITE_NAME" ]]; then
    bash "$REPO_ROOT/scripts/manual/destroy-test-sprite.sh" "$SPRITE_NAME" || true
  fi

  bash "$REPO_ROOT/scripts/manual/stop-test-relay.sh" || true

  if [[ "$HOST_RESERVED" == "1" ]]; then
    (
      cd "$REPO_ROOT"
      release_subdomain || true
    )
  fi
}
trap cleanup EXIT

cd "$REPO_ROOT"

export SPRITES_TOKEN="$SPRITES_TOKEN_INPUT"

printf "Reserving subdomain: %s\n" "$E2E_SUBDOMAIN"
reserve_output="$({
  GITSPACE_API_BASE="$GITSPACE_API_BASE" bun -e '
    const apiBase = process.env.GITSPACE_API_BASE;
    const token = process.env.GITSPACE_TOKEN_INPUT;
    const subdomain = process.env.E2E_SUBDOMAIN;
    const fingerprint = process.env.E2E_DEVICE_FINGERPRINT;
    if (!apiBase || !token || !subdomain || !fingerprint) throw new Error("Missing reserve inputs");

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Device-Fingerprint": fingerprint,
    };

    const check = await fetch(`${apiBase}/subdomains/check?name=${encodeURIComponent(subdomain)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Device-Fingerprint": fingerprint,
      },
    });

    if (!check.ok) {
      throw new Error(`availability check failed (${check.status})`);
    }

    const checkJson = await check.json();
    if (!checkJson?.available) {
      throw new Error(`subdomain unavailable: ${checkJson?.reason ?? "unknown"}`);
    }

    const reserve = await fetch(`${apiBase}/subdomains`, {
      method: "POST",
      headers,
      body: JSON.stringify({ subdomain }),
    });

    if (!reserve.ok) {
      const body = await reserve.text().catch(() => "");
      throw new Error(`reserve failed (${reserve.status}): ${body}`);
    }

    const reserveJson = await reserve.json();
    let tunnelToken = reserveJson?.tunnelToken;
    if (!tunnelToken) {
      const tokenRes = await fetch(`${apiBase}/subdomains/${encodeURIComponent(subdomain)}/token`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Device-Fingerprint": fingerprint,
        },
      });
      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => "");
        throw new Error(`token fetch failed (${tokenRes.status}): ${body}`);
      }
      const tokenJson = await tokenRes.json();
      tunnelToken = tokenJson?.tunnelToken;
    }

    if (!tunnelToken || typeof tunnelToken !== "string") {
      throw new Error("missing tunnel token in reserve response");
    }

    process.stdout.write(tunnelToken);
  '
})"

if [[ -z "$reserve_output" ]]; then
  printf "Failed to reserve subdomain or get tunnel token.\n" >&2
  exit 1
fi

TUNNEL_TOKEN="$reserve_output"
export RELAY_TEST_TUNNEL_TOKEN="$TUNNEL_TOKEN"
HOST_RESERVED="1"

printf "Starting named relay and test sprite...\n"
bash "$REPO_ROOT/scripts/manual/start-test-relay-and-sprite.sh" --named --subdomain "$E2E_SUBDOMAIN"

if [[ ! -f "$SPRITE_STATE_FILE" ]]; then
  printf "Sprite state file missing: %s\n" "$SPRITE_STATE_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$SPRITE_STATE_FILE"

if [[ -z "${SPRITE_NAME:-}" ]]; then
  printf "Sprite state does not include SPRITE_NAME\n" >&2
  exit 1
fi

printf "Running connectivity verification in sprite: %s\n" "$SPRITE_NAME"

E2E_SPRITE_NAME="$SPRITE_NAME" bun -e '
  const { SpritesProvider } = await import("./src/relay/control/sprites-provider.ts");
  const token = process.env.SPRITES_TOKEN_INPUT;
  if (!token) throw new Error("SPRITES_TOKEN_INPUT missing");
  const spriteName = process.env.E2E_SPRITE_NAME;
  if (!spriteName) throw new Error("E2E_SPRITE_NAME missing");

  const provider = new SpritesProvider({ token, appId: "e2e" });
  const result = await provider.execWorkspaceCommand(spriteName, {
    command: ["bash", "-lc", "bash /tmp/verify-relay-connectivity.sh"],
  });

  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.exitCode !== 0) {
    throw new Error(`verify-relay-connectivity.sh exited with ${result.exitCode}`);
  }
  if (!result.stdout.includes("ws-open")) {
    throw new Error("WS probe did not report ws-open");
  }
'

printf "\nE2E completed successfully.\n"
