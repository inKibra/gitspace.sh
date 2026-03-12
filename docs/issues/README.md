# Polish Issues: Final Backlog

These issues capture the final polish pass needed to make the three-chapter GitSpace journey feel reliable and elegant in practice.

## Priority order

P0:

1. `01-host-sync-diagnostics-after-login.md`
2. `02-hosted-relay-startup-deterministic.md`
3. `03-external-relay-identity-pinning-for-cloud-bootstrap.md`
4. `04-cloudflared-preflight-and-install-ux.md`
5. `05-client-relay-trust-verification-and-pinning.md`
6. `06-cloud-bootstrap-token-hardening.md`

P1:

7. `07-cloud-connect-ux-workspace-to-machine.md`
8. `08-cloud-launch-machine-first-repo-optional.md`
9. `09-noninteractive-golden-path.md`

## Release gate (minimum)

Before calling the polish phase complete:

- [x] hosted relay startup is deterministic and never silently downgrades
- [x] host readiness diagnostics are visible after login
- [x] external-relay cloud bootstrap works with pinned relay identity and a cloud-reachable relay URL
- [x] client relay trust path is explicit and key mismatch is rejected
- [ ] cloud bootstrap token path has full race/replay protections

## Current status

- Done: `01`, `02`, `03`, `05`, `07`
- In progress: `06`
- Remaining: `04`, `08`, `09`
- Follow-up fixes landed after the initial backlog writeup:
  - cloud flows now fail closed when only a local/private relay URL is saved
  - relay owner binding no longer leaves the vault in a broken "initialized" state
