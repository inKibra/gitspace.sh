# GitHub Integration: an App per Tenant

> **Status: Draft for planning (2026-10-16).** Claims marked **[unverified]** need a spike before they become decisions.

## 1. Summary

Each GitSpace account (tenant) creates its own GitHub App from GitSpace in one click and installs it on the organizations and repositories it works with. The App gives GitSpace three things:

1. **Events:** GitHub tells the tenant what happened (pull requests, comments, issues, pushes, checks), and project automations turn events into agent work.
2. **Access:** short-lived installation tokens for reading, fetching and pushing private repositories, including checking whether a project is behind its remote, all without a machine.
3. **Write-back:** Change Guides, review threads and workspace status posted to pull requests.

## 2. Why one App per tenant

| Concern | One shared GitSpace App | One App per tenant (chosen) |
|---|---|---|
| Which GitSpace handles an event | Lookup from installation id to tenant in the platform | Built in: the App's webhook points at its own tenant |
| Two tenants on one repository | One installation shared; a link step; `@gitspace` is ambiguous | Each tenant installs its own App; `@gitspace-<handle>` names the target |
| Adding a permission | Every installation of every tenant is asked | Only that tenant's App changes; each tenant upgrades on its own |
| Secrets | One private key for everyone, held by the platform | Each tenant's private key and webhook secret in its own vault |

## 3. Creating and installing the App

- **Create:** Settings → GitHub → **Create GitHub App** runs GitHub's App manifest flow. GitSpace fills in the name (`GitSpace <handle>`), the webhook URL (`https://<tenant-host>/github/webhook`), the callback and setup URLs, the permissions and events for the features the tenant turned on, and **public** installability. GitHub returns the App id, private key, webhook secret and client credentials; they go into the tenant's vault.
- **Owner:** the App belongs to the tenant owner's personal GitHub account by default (decided 2026-10-17); the create screen also offers an organization they administer. One personal App installs into every organization the tenant works in, each organization's admin approving the install once; GitHub can transfer the App to an organization later.
- **Public, but only GitSpace-started installs count.** A public App can be installed on any account, which is what lets one App serve your personal repositories and every organization (Deedible, Golconda, Inkibra) across all your projects. To keep strangers from pointing your App at their repositories:
  - every install starts from GitSpace with a signed, expiring `state`;
  - the setup callback records the installation only when the `state` verifies;
  - any installation GitSpace did not start is ignored, and GitSpace uninstalls it through the API;
  - webhooks from unknown installations are dropped after the signature check.
- **Installation records** (tenant storage): installation id, account (user or org), repository selection, permissions granted, who installed it, when.
- **Upgrading:** GitSpace lists features with the permissions each needs and whether the App has them. Changing an existing App's permissions happens on the App's GitHub settings page (GitSpace links there); each installation then accepts the new permissions on GitHub. **[unverified]** whether an App's permissions can be updated through the API rather than the settings page.

Default permissions: `metadata: read`, `contents: write`, `workflows: write`, `pull_requests: write`, `issues: write`, `checks: write`, `statuses: write`. `contents: write` and `workflows: write` are defaults (decided 2026-10-17) because the account's SSH key already pushes the same branches, workflow files included; it lets the account push, merge and tag without a machine. Each call requests an installation token narrowed to its one repository and the permissions it needs, and GitSpace pushes only a workspace's own branch and merges the user approved; GitHub branch rules still apply. Events: `pull_request`, `issue_comment`, `pull_request_review_comment`, `issues`, `push`, `check_suite`, `installation`, `installation_repositories`.

### Decisions for G0 (2026-10-17)

- **First install:** the inKibra organization, with **selected repositories** (each organization chooses its repositories; GitHub can widen it later).
- **One path per repository:** a repository an installation covers uses installation tokens for imports, fetches and pushes; the account SSH key remains only for repositories no installation reaches (other organizations, other hosts). Never one, then the other.
- **Projects link themselves:** when an installation covers a repository that projects already use, they link to it, each with a project notice.
- **Webhooks in G0** are verified, recorded once and listed; nothing acts on them until G2. The App subscribes to every planned event from the start, so later phases ask for no new approval.
- **Name:** `GitSpace <handle>`, public, plain description.
- **Key rotation in G0:** GitHub creates App private keys only on the App's settings page, so rotation is: generate a key there, upload it to GitSpace, which verifies it against GitHub before switching; the old key is then deleted on GitHub.

## 4. Routing inside a tenant

- Webhook → verify `X-Hub-Signature-256` with the tenant's secret → record the delivery id once (duplicates are dropped) → route by repository.
- A repository maps to every project in the tenant whose remote is that repository (several projects may share one, as Deedible's did).
- **Mentions:** a comment acts on the tenant only when it mentions `@gitspace-<handle>` (the App's bot name). Target: the workspace already attached to that pull request or issue; otherwise the project marked as the default for the repository; otherwise GitSpace replies asking which project.
- An event no automation matches is recorded and dropped.

## 5. Project automations

Automations work like project crons (`ProjectCronsDO`, scoped runs) with an event in place of a schedule. Each one is a trigger, a filter, an instruction, and where it runs:

| Trigger | Example |
|---|---|
| PR opened or updated | Create a review workspace from the PR (`workspace.create` from a PR exists), run the Reviewer, post the Change Guide as a check |
| `@gitspace-<handle>` comment on a PR or issue | Send the comment as an instruction to that workspace's agent |
| Issue labeled `gitspace` | Create a workspace with the issue as its goal |
| Push to the base branch | Mark the project behind its remote and offer **Update base** (§7) |
| Check failed on a PR | The PR's workspace agent investigates and reports |

Rules (from `docs/SIMPLIFICATION.md`): a delivery is recorded once and becomes one run; failures are reported on the run, never retried in a loop; nothing polls GitHub when webhooks are available.

## 6. Write-back to GitHub

### Who authors pushes and pull requests

Two modes (decided 2026-10-17):

- **Bot (default):** the installation token pushes and opens the pull request as the App's bot; the body names who asked ("Requested by @bradleat via GitSpace"). Commits keep their own author and committer. The requester can approve, since GitHub ignores only the author's own approval.
- **Author:** GitSpace acts with the requester's GitHub user token (the same App's "Sign in with GitHub", needed for G3 comments anyway; the refresh token is kept per person in the vault). Pushes and the pull request are the requester's, shown "via GitSpace"; someone else must approve.

The tenant sets the default for its projects. A repository can require author mode for every tenant by committing `.gitspace/github.json` with `{ "pullRequests": "author" }`: the policy goes through the team's own review and binds everyone's GitSpace. GitHub's rules cannot express this: "require approval of the most recent reviewable push" excludes only the last pusher, which in bot mode is the bot. Author mode arrives with the GitHub sign-in in G3; until then every pull request uses bot mode. **[unverified]** whether an App's own review counts toward required approvals; GitSpace never approves its own pull requests either way.

- **Change Guide:** a check run whose summary is the guide (Markdown; GitHub limits the summary to about 65 KB, so long guides link to the full version), updated in place when the guide changes. A PR comment is the alternative for repositories where checks are noisy.
- **Review threads:** posted as review comments on the exact lines; resolving on either side resolves both.
- **Status:** a commit status or check showing "GitSpace: reviewing / ready / needs you".
- **Change Guide viewer link:** GitSpace comments on the PR with a short summary and a link to the guide rendered by GitSpace; updating the guide edits that comment rather than posting a new one. See §6.1.
- **Default:** write-back is per project and starts off. When on, posts are automatic; when off, each workspace has a **Post to GitHub** action.

### 6.1 Change Guide viewer and comments from readers

- **Viewing:** on public repositories anyone with the link can read the guide. On private repositories the reader signs in with GitHub and GitSpace checks, with the reader's token, that they can read the repository; a copied link alone shows nothing.
- **Commenting:** readers **sign in with GitHub** (the tenant App's user authorization) and comment on a section, a step or a file range in the guide. GitSpace posts the comment to the PR **as the reader**, through GitHub's API with their user token:
  - a note on a diff range becomes a review comment on those lines;
  - any other note becomes a PR comment that quotes the guide passage, with file references as permalinks at the PR's commit;
  - each posted comment carries a hidden marker (`<!-- gitspace-guide v1 guide=<id> section=<id> -->`).
- **Read-back:** the App's webhook delivers the comment like any other; the marker files it as a thread on the matching guide section, attributed to the reader's GitHub account, where the workspace agent can answer or act. Comments people write directly on GitHub (no marker) still reach the workspace through the normal PR events.
- **After merge or archive:** the viewer stays up read-only: the guide and its threads remain visible under the same access rules, and new comments are closed (the comment controls say why). Reopening the PR or restoring the workspace reopens comments.
- **What GitSpace keeps:** the reader's GitHub token lives only in their viewer session (expiring, encrypted cookie), never in the tenant's vault. GitSpace never accepts a comment that GitHub did not accept: identity, permissions and moderation stay with GitHub.

## 7. Behind the remote

- **Check without a machine:** the remote's branch heads come from one HTTPS request (`GET <repo>.git/info/refs?service=git-upload-pack`), the same request `remoteDefaultBranch` already makes (`account-worker/src/cloud-project.ts:14-18`). Private repositories use an installation token.
- **Push-driven:** with the App installed, a `push` webhook updates the stored remote head immediately; without it, the check runs when someone opens the project or presses refresh. No background polling.
- **Stored per project:** remote head of the base branch, when it was checked, and whether the project's copy contains it. **Per workspace:** behind its base (already in `stackStatus`), and behind its own remote branch when one exists (for example a PR branch others pushed to).
- **Shown** as a small marker beside the existing status, with **Update base** using the existing base-branch import.
- **The GitSpace project:** "behind" also means canonical `develop` is ahead of the release the tenant runs, which offers **Launch from canonical** (`docs/SIMPLIFICATION.md`, Batch 10).

## 8. Milestones

| ID | Milestone | Exit criteria |
|---|---|---|
| **G0** (shipped 2026-10-17, `8ac88a49`) | App creation and install | Manifest flow creates `GitSpace <handle>`; keys in the vault; installs started from GitSpace are recorded; an install GitSpace did not start is uninstalled; webhooks verified and recorded once. |
| **G1** | Remote tracking | Remote heads from `info/refs` with installation tokens; push webhooks update them; behind markers on projects and workspaces; **Update base**. |
| **G2** | PR review automation | PR opened → review workspace → Reviewer → Change Guide check, updated on new pushes; `@gitspace-<handle>` comments reach the workspace agent. |
| **G3** | Write-back and sharing | Review threads both ways, status checks, per-project write-back switch; Change Guide viewer link on the PR; sign in with GitHub to comment, posted as the reader and read back into guide threads; private repositories require sign-in and repository access. |
| **G4** | More triggers | Issues to workspaces, failed checks investigated. |

## 9. Open questions

1. Should a tenant be able to turn on `contents: write` per project, or only for the whole App?
2. When two projects in one tenant share a repository and no default is set, should a PR create a workspace in each, or ask?

## 10. References

- GitHub Docs: Registering a GitHub App from a manifest; Webhook events and payloads; Authenticating as a GitHub App installation; Check runs.
- `docs/APERTURE-DESIGN.md` (share links), `docs/SIMPLIFICATION.md` (rules; Batch 10).
