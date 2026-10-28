# Machine distribution: one platform-neutral release per launch

> **Status: Decided direction (2026-10-28), not built.** Replaces the per-platform client builds and the pin-based account installer (SIMPLIFICATION entry 107).

## 1. Summary

A launch builds one platform-neutral release: the machine and CLI JavaScript, plus a list of each platform's native files by upstream URL and SHA-256. The account serves it. A computer installs with one command from its account, runs the JavaScript on a pinned Bun at once, and later compiles its own ahead-of-time executable in the background when Bun's AOT compiler is usable. Every platform follows every launch; nothing is built per platform.

## 2. What exists today

- **A machine build is almost entirely platform-neutral.** The Darktop build of `b3ec7e0f` holds `machine.js`, `host-runtime.js`, `machine-bootstrap.js`, `machine-update.js` and `machine-worker.js` (about 11 MB), `native/bin/rg` and `native/bin/git-lfs` (about 20 MB), and `machine-native.json` requiring Bun 1.4.0 and a glibc floor. No `.node` addons; nothing is compiled.
- **The native files are upstream releases, already pinned for all four platforms in source:** git-lfs 3.8.0 and ripgrep 14.1.1 (`packages/deployment/src/native-build.ts`), Bun 1.4.0 (`release.ts`), for darwin-arm64, darwin-x64, linux-arm64 and linux-x64.
- **Why a build is per platform today:** a build packs the natives of the platform it runs on, records its ABI from the host (`readelf` glibc versions on Linux, the build host's OS on macOS), and compiles the CLI with `bun build --compile`. `release.ts` refuses to build one platform on another for these reasons. A launch on Darktop therefore produces a Linux x64 build only, and a Mac paired to the account falls back to the pinned default release.
- **Installers:** the global `gitspace.sh/install` reads one stable channel (it served a 2026-09-05 client that could not read today's pairing tokens until 2026-10-28, entry 105). The account installer (entry 107) serves the client of the account's pinned default, which is older than the account's own release.
- **The machine runtime already runs JavaScript on a private Bun** (`release.ts`: "A private Bun preserves process.execPath for machine and supervisor children"); only the CLI is compiled.

## 3. The release

- **One build per launch, on any Linux:** the account's build machine, or a Cloudflare cloud machine when the account has none. Output: the JavaScript bundles and a manifest.
- **The manifest** names, per platform, each native file (Bun, `rg`, `git-lfs`) by upstream URL, SHA-256, size and its ABI floor (glibc version, macOS version), pinned in source beside the hashes. No binaries ride in the release; a host fetches natives by hash and keeps them across releases.
- **Mirror:** native files are stored in the platform's R2 by SHA-256 the first time a build names them; installs and updates fetch from the mirror, never from GitHub at install time.

## 4. Install

`curl -fsSL https://<handle>.gitspace.sh/install | sh -s -- --pair <token>`, served by the account (one command, as entry 107):

1. Check the platform and its ABI floor; download the pinned Bun, `rg` and `git-lfs` for it from the mirror, checking each SHA-256.
2. Download the account's current release JavaScript, checking its digest from the account's manifest.
3. Install `~/.local/bin/gitspace` as a wrapper that runs the CLI JavaScript on the pinned Bun.
4. Run `gitspace machine setup --pair <token>`.

The computer runs exactly the account's release from its first minute, on any of the four platforms.

## 5. Updates

The host updater takes the same release: new JavaScript (and new native files only when their hashes change), then a restart. A Mac follows every launch as Darktop does.

## 6. Ahead-of-time compilation (later)

Bun's `bun build --compile --aot` ([oven-sh/bun#45631](https://github.com/oven-sh/bun/pull/45631)) compiles TypeScript to machine code with no JIT; on Claude Code's CLI it measured first prompt 318 → 141 ms, peak private memory 185 → 45 MB, CPU 1,542 → 512 ms. It has no cross-compilation (each platform's executable is built on that platform), builds take tens of seconds and gigabytes of memory with no cache, TypeScript 7 type errors stop the build, built-ins cannot be modified, and code made with `new Function` (zod 4) is interpreted. Only Linux x64 is fully tested.

So each machine compiles its own: after an install or update the JavaScript runs at once, and the host compiles the AOT executable in the background, swapping it in when the build succeeds and staying on the JavaScript when it fails. CLI first (largest gain, smallest program), then the host. Off until AOT ships in a Bun release and our code builds under its rules (#166). Until then, `--bytecode` (architecture-independent, built once centrally) is the available startup gain.

## 7. GitHub's role

Verification only: a small macOS and arm64 job installs a published release from scratch and checks it starts and pairs, run when Bun, ripgrep or git-lfs versions change. Cloudflare cannot run macOS.

## 8. To check before building

1. Cloudflare containers can run the build (Bun, git; a JavaScript build).
2. Upstream Bun, `rg` and `git-lfs` run on macOS when fetched by `curl` (no quarantine attribute), proven by the verification job.
3. Where the CLI uses `process.execPath` to start the host (a compiled CLI's path is `gitspace`; under the wrapper it is Bun).
4. The ABI floors per platform, pinned once from the upstream files.

## 9. What it replaces

The per-platform client builds and `bun build --compile` CLI; the pin-based account installer (entry 107); the default-release re-pin to get a current client. The distribution and default-release pipelines remain only to give a new account its first release, which is the same one-build output.

## 10. Milestones

| ID | Milestone | Exit |
|---|---|---|
| D0 | Platform-neutral release | A launch produces JavaScript + a per-platform native manifest; natives mirrored by hash; checks 1 and 4 done |
| D1 | Install | The account installer installs the account's release on all four platforms with one command; checks 2 and 3 done; the verification job passes |
| D2 | Updates | The host updater follows launches on all four platforms; the pin-based installer and per-platform client builds are deleted |
| D3 | AOT | Behind a setting: background AOT compile and swap, CLI first; after #166 |
