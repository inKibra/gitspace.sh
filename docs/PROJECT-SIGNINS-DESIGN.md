# Project Sign-ins: one cloud login per project

> **Status: Draft for planning (2026-10-17).** Claims marked **[unverified]** need a spike before they become decisions.

## 1. Problem

Interactive cloud logins happen once per workspace. Golconda's `.gitspace/lifecycle/machine/prepare/30-aws-login.sh` reads the IAM key and MFA serial from project values, asks for a six-digit code, calls `sts:GetSessionToken` and saves the session to `.gitspace/local/aws-dev-session.env` inside that checkout. Every workspace has its own checkout, so every workspace asks again; Deedible's setup has the same shape. An agent with no terminal cannot answer the prompt, so automatic setup skips it.

## 2. Project sign-ins

- **One session per project.** A sign-in record holds the session values (for AWS: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`), their expiry and who signed in, encrypted in the tenant vault beside the project's other secrets.
- **Read at command time.** Machine commands in any workspace of the project receive the values as environment, like project values. Nothing is copied into a checkout, so signing in again updates every workspace at once.
- **Signed in from a form.** For the AWS MFA pattern the account calls `GetSessionToken` itself (the IAM key is already a project secret; STS is HTTPS): the user types the code in GitSpace, from any device, with no machine or terminal. An IAM user's session can last up to 36 hours.
- **Expiry is one event.** One project notice before and at expiry, with a sign-in button. Commands that need an expired session fail with that message, and an agent asks the user through the question card, never a terminal prompt.
- **Setup scripts become optional.** A login script finds the project session and skips; its own login remains for use outside GitSpace.

### Filling a session

| Adapter | How | Needs a machine |
|---|---|---|
| AWS MFA session (first) | Form → account calls `sts:GetSessionToken` | No |
| AWS IAM Identity Center, gcloud, Azure | Browser device-code flow; the account renews with the refresh token **[unverified: refresh lifetimes per provider]** | No |
| Generic capture | Run an interactive script once in the base space terminal; keep the outputs it declares (`# gitspace: shares NAME …`) | Yes |

### Risk

A project session reaches every workspace and agent in the project; that is its purpose, and it means one person's MFA covers work they did not start. Mitigations: project scope, expiry, revoke, a record of which workspace used it and when, and an optional per-use approval for production roles.

## 3. Without a machine

Consumers today are machine commands (`aws`, `terraform`, `infra/with-aws`). Without a machine a sign-in can still be made ahead of time (form adapters) and still warns before expiry, but nothing uses it.

**Follow-up: a cloud AWS tool.** AWS APIs are signed HTTPS, so a tool could call them from the Worker with the project session: read CloudWatch logs, list and read S3 objects, check resources and deployment state, from a plan-phase workspace or a cron with no machine attached. It needs its own permission design (which services and actions, read-only by default). The session lives in the tenant vault, so the tool needs no change to sign-ins.

## 4. OIDC federation (alternative to stored sessions)

Instead of a person's session, the tenant becomes an OIDC identity provider and clouds trust it, as they trust GitHub Actions:

- The tenant publishes `https://<tenant-host>/.well-known/openid-configuration` and its JWKS; the signing key lives in the tenant vault.
- When a command needs credentials, the account mints a short-lived JWT (`iss` = tenant host, `aud` = the cloud's audience such as `sts.amazonaws.com`, `sub` naming project, workspace and phase) and exchanges it: AWS `AssumeRoleWithWebIdentity`, GCP workload identity federation, Azure federated credentials.
- One-time setup per cloud account: register the issuer and a role whose trust policy matches `sub`, for example only `project:golconda-idf-data-vault:*` for the dev role, or only the ship phase for a production role.

| | Project sign-in | OIDC federation |
|---|---|---|
| Human step | MFA code every session (≤36 h for AWS MFA) | None after the one-time cloud setup |
| Long-lived secret | IAM key in the project vault | None in the cloud account; the tenant's signing key |
| Identity in cloud logs | The person's IAM user | The role, with project and workspace in the session name |
| Scoping | Whole project | Per project, workspace or phase in the trust policy |
| Needs cloud admin rights | No | Yes, once (identity provider and role) |

Federation removes logins entirely where the user can change the cloud account's trust settings; sign-ins remain for accounts they cannot. Whoever controls the tenant can then assume the role, so the trust policy's `sub` conditions carry the security boundary. **[unverified]** AWS fetching the JWKS from a tenant host behind Cloudflare, and the thumbprint the AWS identity-provider API still asks for.

## 5. Order

1. **S0:** sign-in records, injection into machine commands, AWS MFA form, expiry notices.
2. **S1:** generic capture from an interactive script.
3. **S2:** device-code adapters (Identity Center, gcloud, Azure).
4. **Follow-up:** cloud AWS tool (§3).
5. **Spike:** OIDC issuer per tenant and one AWS role trusting it (§4).
