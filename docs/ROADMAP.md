# Roadmap

Rough order agreed 2026-10-17. Each item's design holds its own phases and open questions.

1. **GitHub App** — one App per tenant: creation and install (G0), remote tracking, PR review automation, write-back. `docs/GITHUB-INTEGRATION-DESIGN.md`
2. **Cloud credentials** — project sign-ins with the AWS MFA provider first, and the general credential framework (vault, scope, expiry, injection) other providers build on. `docs/PROJECT-SIGNINS-DESIGN.md` §2
3. **Aperture** — spikes, then B0. `docs/APERTURE-DESIGN.md`
4. **Trusted workloads (OIDC)** — each tenant as an OIDC issuer; clouds trust it once and workspaces get short-lived role credentials with no logins. #158 `docs/PROJECT-SIGNINS-DESIGN.md` §4

Follow-up, unscheduled: a cloud AWS tool that calls AWS APIs from the Worker with a project's credentials, for workspaces and crons with no machine. `docs/PROJECT-SIGNINS-DESIGN.md` §3
