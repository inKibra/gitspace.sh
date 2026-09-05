# GitSpace

GitSpace is a browser workspace for coding agents across your own computers and cloud machines. Workspaces keep their code, agent conversation, goals, review evidence, artifacts, and services together.

You or an agent can modify GitSpace from a workspace and release changes through the account's release system. Worker, frontend, machine, and OMP are separate account-governed targets.

## Start in the browser

1. Open [gitspace.sh](https://gitspace.sh) with an invitation and choose your permanent account handle.
2. Save the recovery key in a password manager and confirm it before creating the account.
3. Choose **Open GitSpace** to enroll the browser and enter your account.
4. Create a cloud machine or choose **Settings > Machines > Add a computer**.
5. Connect an agent provider, create a project and workspace, and try a small task.

No local installation is required for account creation or cloud-only use. The [getting-started guide](https://gitspace.sh/docs/getting-started) walks through both paths.

## Connect your own computer

Install Git and the OpenSSH client on the computer first. Then follow the account's **Add a computer** walkthrough:

```sh
curl -fsSL https://gitspace.sh/install | sh
```

The installer selects a published platform build and verifies its checksum. GitSpace supplies its own runtime; no source checkout, separately installed Bun, or local build is needed.

Generate a short-lived pairing command in the browser and run it on that computer:

```sh
gitspace machine setup --pair <token>
```

Compare the signing key shown in the terminal and browser before approving the computer. Setup downloads the verified runtime and starts it. The computer receives its own machine identity, not your account root private key.

Local commands operate that machine:

```sh
gitspace machine status
gitspace doctor
gitspace machine stop
gitspace machine start
gitspace open
```

The account release system manages runtime changes. There is no separate local update command. See the [CLI reference](https://gitspace.sh/docs/cli-reference).

## Workspace workflow

- Plan with goals, requirements, workflows, and durable notes.
- Run OMP agents on the machine that owns the workspace.
- Answer structured questions and inspect diffs in the browser.
- Keep review threads, journals, evidence, and change guides with the work.
- Manage services, events, crons, secrets, plugins, and releases from their account or workspace surfaces.

Cloud machines are temporary. In **Settings > Machines**, **Stop** saves supported workspace state before stopping the machine. If saving fails, the machine stays online. **Start** runs a fresh machine environment and restores saved workspaces, not the old machine disk.

Workspace checkpoints save the Git branch, commits, staged and unstaged tracked changes, non-ignored untracked files, agent conversation, and GitSpace artifacts. They do not save installed packages, machine-local configuration, ignored files, or arbitrary files elsewhere on the machine, including its home directory. Ask a normal workspace agent to install tools as needed; those changes are temporary.

Closing a workspace, stopping a cloud machine, and destroying a machine are different operations. Controlled workspace close, Stop, and provider replacement publish durable checkpoints before releasing ownership. After an unexpected interruption, the last completed checkpoint is the recovery limit; uncheckpointed work may be lost. Automatic recovery from unclean disk loss and a returning-machine recovery ZIP are not implemented yet.

## Security

The account root authorizes browser devices. An account-wide delegating browser can approve a separate machine identity. Requests carry device signatures; artifact/checkpoint blobs are encrypted and machine credentials are sealed to machine keys.

The production RPC path is not fully end-to-end encrypted. Treat the account Worker, relay, and machine hosts as part of the documented trust boundary. See [Security boundaries](https://gitspace.sh/docs/security/remote-access).

## Development

The v1 implementation lives in `packages/`. A source checkout is for development, not installation. Existing root `src/` and npm `gssh` entrypoints belong to the older product and are not the v1 onboarding path.

```sh
bun install --frozen-lockfile
bun run dev
bun run typecheck:packages
```

`bun run dev` starts the self-development environment. Release builds use the pinned toolchain and native platform workflow in `.github/workflows/publish-distribution.yml`.

Cloud container images build on GitHub through `.github/workflows/publish-container.yml`. Push a `container-*` tag to build and publish that commit.

- Set the repository variable `CLOUDFLARE_ACCOUNT_ID`.
- Set `CLOUDFLARE_API_TOKEN` with registry write access. For a one-off run, fresh `CLOUDFLARE_REGISTRY_USERNAME` and `CLOUDFLARE_REGISTRY_PASSWORD` secrets also work; these credentials expire.
- The workflow checks packaged Bun, walgit, and OMP before uploading. Its `cloud-container-reference` artifact records the immutable image digest and source commit.
- Publication does not change running machines. Deploy the digest through `packages/sandbox-worker/scripts/rollout.ts`, which checkpoints machines before replacing the provider image.

Bun's module mocks leak between test files in a shared process. Use isolated processes for trusted machine/core results, for example:

```sh
bun scripts/test-isolated.ts packages/account-machine/test packages/core/test
```

Worker packages use their own Vitest/Cloudflare test commands.

## Documentation and license

- [User documentation](https://gitspace.sh/docs)
- [Agent workflow](https://gitspace.sh/docs/agent-workflow)
- [Fleet architecture](docs/FLEET.md)
- [License](LICENSE), including its non-compete clause

Contributions are welcome through pull requests.
