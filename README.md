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

Cloud machines can remain available and personalized. Closing a workspace and deleting a machine are different operations. Controlled workspace close and provider replacement publish durable checkpoints before releasing ownership. Unexpected disk loss can still lose uncheckpointed work; ignored files are excluded from checkpoints.

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
