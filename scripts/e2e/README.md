# On-Demand Container E2E

This runner executes a full cloud relay + sprite connectivity flow in an isolated Docker container.

It uses your existing local account tokens (`GITSPACE_TOKEN`, `SPRITES_TOKEN`) and creates a unique subdomain per run.

## Run

```bash
bash scripts/e2e/run-on-demand.sh
```

Use a fixed subdomain:

```bash
bash scripts/e2e/run-on-demand.sh --subdomain e2e-my-test
```

Keep resources on failure for debugging:

```bash
bash scripts/e2e/run-on-demand.sh --keep-on-fail
```

## What it does

1. Builds and runs the E2E container.
2. Generates a fresh in-container machine identity.
3. Reserves subdomain on `gitspace.sh` using your token + device fingerprint.
4. Starts named relay + tunnel (isolated from host relay process).
5. Creates sprite and runs in-sprite relay connectivity verification.
6. Cleans up sprite, relay, and subdomain (unless `--keep-on-fail` and run fails).

## Required host state

- Logged-in gitspace token in keychain (`GITSPACE_TOKEN`) or env.
- Sprites token in keychain (via `getSpritesToken`) or `SPRITES_TOKEN` env.
- Local machine identity initialized (`gssh user identity init`) for device fingerprint.
- Docker available locally.
