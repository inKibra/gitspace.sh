# Machine distribution: one platform-neutral release per launch

> **Status: Decided direction (2026-10-28). D0 built (2026-10-28): every machine launch and default-release build also produces the portable release, and its natives are mirrored by hash; checks 1 and 4 done (§8). D1–D3 not built.** Replaces the per-platform client builds and the pin-based account installer (SIMPLIFICATION entry 107).

## 1. Summary

A launch builds one platform-neutral release: the machine and CLI JavaScript, plus a list of each platform's native files by upstream URL and SHA-256. The account serves it. A computer installs with one command from its account, runs the JavaScript on a pinned Bun at once, and later compiles its own ahead-of-time executable in the background when Bun's AOT compiler is usable. Every platform follows every launch; nothing is built per platform.

## 2. What exists today

- **A machine build is almost entirely platform-neutral.** The Darktop build of `b3ec7e0f` holds `machine.js`, `host-runtime.js`, `machine-bootstrap.js`, `machine-update.js` and `machine-worker.js` (about 11 MB), `native/bin/rg` and `native/bin/git-lfs` (about 20 MB), and `machine-native.json` requiring Bun 1.4.0 and a glibc floor. No `.node` addons; nothing is compiled.
- **The native files are upstream releases, pinned for all four platforms in one source file,** `packages/deployment/src/native-pins.ts`: Bun 1.4.0, ripgrep 14.1.1 and git-lfs 3.8.0 for darwin-arm64, darwin-x64, linux-arm64 and linux-x64. The per-platform build (`native-build.ts`, `release.ts`) reads its own platform's entries from it and checks the archive and the extracted executable against them.
- **Why a build is per platform today:** a build packs the natives of the platform it runs on, records its ABI from the host (`readelf` glibc versions on Linux, the build host's OS on macOS), and compiles the CLI with `bun build --compile`. `release.ts` refuses to build one platform on another for these reasons. A launch on Darktop therefore produces a Linux x64 build only, and a Mac paired to the account falls back to the pinned default release.
- **Installers:** the global `gitspace.sh/install` reads one stable channel (it served a 2026-09-05 client that could not read today's pairing tokens until 2026-10-28, entry 105). The account installer (entry 107) serves the client of the account's pinned default, which is older than the account's own release.
- **The machine runtime already runs JavaScript on a private Bun** (`release.ts`: "A private Bun preserves process.execPath for machine and supervisor children"); only the CLI is compiled.

## 3. The release

- **One build per launch, on any Linux:** the account's build machine, or a Cloudflare cloud machine when the account has none. Output: the JavaScript bundles and a manifest.
- **The manifest** names, per platform, each native file (Bun, `rg`, `git-lfs`) by upstream URL, SHA-256, size and its ABI floor (glibc version, macOS version), pinned in source beside the hashes. No binaries ride in the release; a host fetches natives by hash and keeps them across releases.
- **Mirror:** native files are stored in the account's own storage by SHA-256 the first time a launch names them; updates fetch from the mirror, never from GitHub at update time.

As built (D0), in code the "portable release" (`@gitspace/protocol/machine-release`):

- `buildPortableRelease(root, out)` (`packages/deployment/src/builders.ts`) writes `out/portable.manifest.json` and the files it names under `out/portable/`: `machine/` (`machine.js`, `machine-worker.js`, `host-runtime.js`, `machine-update.js`, `machine-bootstrap.js` and their source maps, the same bundles as a machine generation) and `cli/gitspace.js` (the CLI as JavaScript, about 0.9 MB; `bun cli/gitspace.js` runs it). It takes about a second; no native file is downloaded or packed. It refuses to run on a Bun other than the pinned one. Not in it: the distribution runtime's `host.js` and `rpc-probe.js`, which embed one platform generation's machine manifest hash (`GITSPACE_INITIAL_MACHINE_MANIFEST_HASH`); D1 decides what an installed host trusts first.
- The manifest (`portableManifestSchema`) holds `bunVersion`, every file's path, SHA-256 and size, and `natives`: for each of the four platforms exactly one `bun`, `rg` and `git-lfs`, each with `version`, upstream `url` (only that project's GitHub release downloads), `sha256` and `size` of the asset, `member` (the executable inside the archive), `executable` (its SHA-256 and size once extracted) and `abi` (`{ os: 'linux', glibc }`, null when statically linked, or `{ os: 'darwin', macos }`). A native whose ABI is for the other OS, a missing platform or tool, a non-upstream URL, or a Bun other than `bunVersion` is refused.
- **Launches:** the launcher (`deployment-launcher.ts`) builds it with the machine target when the source tree has `buildPortableRelease`, uploads each file to the account's DATA at `releases/<sha>/portable/<path>` and then the manifest at `releases/<sha>/portable.manifest.json`, and stages it as the release record's `artifacts.portable`. Before staging, the account checks the manifest's digest and that every file it names is in DATA with that SHA-256 and size, then copies into its own storage every native the manifest names that it lacks (`portable-release.ts`, `mirrorNatives`, each download checked against its pinned SHA-256 and size); either failing refuses the stage. The per-platform machine artifact is built and staged as before, its machine process and worker compiled to bytecode (below).
- **Defaults:** the default-release build (`default-release-cli.ts build`) builds it into the default as `portable` (`defaults/releases/<commit>/portable.manifest.json`, files under `…/portable/`), verified with the rest of the default.
- **Mirror:** `users/<account>/natives/sha256/<sha256>` in the account's own storage, copied by the account when it stages a launch; machines read it through the data endpoint (`natives/sha256/<sha256>`, read only). The default-release publish job keeps its own copy in the platform's releases bucket for defaults.

## 4. Install

`curl -fsSL https://<handle>.gitspace.sh/install | sh -s -- --pair <token>`. Built (2026-10-29): everything comes from the account; the platform serves nothing for an install.

1. The account names what to install at `distribution/v1/install/<platform>.txt` (`formatInstallMetadata`): its install release (`TenantReleasesDO.installRelease`: the selected machine release, else the account's default release), that release's portable manifest digest, the platform's pinned Bun archive and the executable in it, and the release's `cli/gitspace.js`.
2. The script (`installScript`) downloads the Bun archive from the account's copy (`distribution/v1/natives/<sha256>`, only natives that release names) and the client (`distribution/v1/releases/<release>/cli/gitspace.js`), checking each against the metadata; it installs Bun at `~/.local/share/gitspace/bun/<sha256>/bun`, the client under `~/.local/share/gitspace/releases/<release>/`, and `~/.local/bin/gitspace` running that client on that Bun. It needs `curl`, `unzip` and `sha256sum` or `shasum`.
3. `gitspace machine setup --pair <token>` pairs, then builds the runtime (`installRuntime`, `cli/src/bootstrap.ts`) through the signed data endpoint: the release's portable manifest, its machine files and this platform's `rg` and `git-lfs` from the account's copy, assembled and compiled here (`assembleMachineGeneration`), with `bin/bun` the client's own Bun and `host.js` starting the generation's `machine-bootstrap.js` with that generation's manifest as its trust anchor.

The computer runs exactly the account's release from its first minute, on any of the four platforms. With no machine release selected, machines follow that same install release, the account's default. Cloud machines still boot from the platform's container image, which carries a runtime from the native distribution; moving them to the account's release is still to do.

## 5. Updates

Built (2026-10-29), in `release-follower.ts`. A machine takes a release's built generation when it was built for its platform, architecture, Bun and native ABI (`validateExecutableCompatibility`); otherwise it builds its own from the portable release (`assembleMachineGeneration`): the release's machine JavaScript, its platform's pinned `rg` and `git-lfs` from the account's mirror, and its machine process and worker compiled for its Bun. A release for another Bun is refused with that reason. Each machine's failure is kept on the release as its own (`machineErrors`). A machine on a follower from before this needs one manual update to get it.

**Compiling:** `compileMachineBundles` turns `machine.js` and `machine-worker.js` (ES module bundles) into CommonJS with Bun bytecode beside them (`.jsc`), their source maps still mapping to the TypeScript. The launching machine compiles its own platform's generation; every other machine compiles the one it builds. Measured on Darktop: loading `machine.js` takes about 200 ms instead of 270 ms, for about 25 MB more per generation. The host, its updater and bootstrap stay ES modules (they await at top level and run briefly).

## 6. Ahead-of-time compilation (later)

Bun's `bun build --compile --aot` ([oven-sh/bun#45631](https://github.com/oven-sh/bun/pull/45631)) compiles TypeScript to machine code with no JIT; on Claude Code's CLI it measured first prompt 318 → 141 ms, peak private memory 185 → 45 MB, CPU 1,542 → 512 ms. It has no cross-compilation (each platform's executable is built on that platform), builds take tens of seconds and gigabytes of memory with no cache, TypeScript 7 type errors stop the build, built-ins cannot be modified, and code made with `new Function` (zod 4) is interpreted. Only Linux x64 is fully tested.

So each machine compiles its own: after an install or update the JavaScript runs at once, and the host compiles the AOT executable in the background, swapping it in when the build succeeds and staying on the JavaScript when it fails. CLI first (largest gain, smallest program), then the host. Off until AOT ships in a Bun release and our code builds under its rules (#166). Until then, `--bytecode` (architecture-independent, built once centrally) is the available startup gain.

## 7. GitHub's role

Verification only: a small macOS and arm64 job installs a published release from scratch and checks it starts and pairs, run when Bun, ripgrep or git-lfs versions change. Cloudflare cannot run macOS.

## 8. To check before building

1. Cloudflare containers can run the build (Bun, git; a JavaScript build). **Checked (D0): yes.** The cloud machine image (`packages/sandbox-worker/Dockerfile`, final stage: `cloudflare/sandbox:0.12.9`, Ubuntu 22.04, Bun 1.4.0 at `/usr/local/bin/bun`, git 2.34.1, git-lfs, binutils) was rebuilt locally without its `/opt/gitspace` runtime layers and run with standard-1's limits (`docker run --cpus 0.5 --memory 4g`). In it: `git clone` of the repository at `23cb05f0` plus the D0 change, `bun install --frozen-lockfile` (64 s, peak RSS 304 MiB), `buildPortableRelease` (4 s, peak RSS 241 MiB), then `bun portable/cli/gitspace.js --version` printed `1.0.0`. The checkout with `node_modules` is 3.0 GB of standard-1's 8 GB disk; the release is 33 MB.
2. Upstream Bun, `rg` and `git-lfs` run on macOS when fetched by `curl` (no quarantine attribute), proven by the verification job.
3. Where the CLI uses `process.execPath` to start the host (a compiled CLI's path is `gitspace`; under the wrapper it is Bun).
4. The ABI floors per platform, pinned once from the upstream files. **Checked (D0):** the twelve assets were downloaded with `curl`, hashed with `sha256sum` (the archive digests equal the ones already pinned from upstream's checksums), and each executable extracted (`unzip -p`, `tar -xzOf`) and hashed. Linux floor: the newest `GLIBC_` version `readelf --version-info` lists, null when `readelf -l` shows no interpreter (static). macOS floor: the Mach-O `LC_BUILD_VERSION` minos. Result, pinned in `native-pins.ts`:

   | Platform | Bun 1.4.0 | ripgrep 14.1.1 | git-lfs 3.8.0 | Platform floor |
   |---|---|---|---|---|
   | darwin-arm64 | macOS 13.0 | macOS 13.0 | macOS 13.0 | macOS 13.0 |
   | darwin-x64 | macOS 13.0 | macOS 14.0 | macOS 13.0 | macOS 14.0 |
   | linux-arm64 | glibc 2.17 | glibc 2.18 | static | glibc 2.18 |
   | linux-x64 | glibc 2.17 | static (musl) | static | glibc 2.17 |

## 9. What it replaces

The per-platform client builds and `bun build --compile` CLI; the pin-based account installer (entry 107); the default-release re-pin to get a current client. The distribution and default-release pipelines remain only to give a new account its first release, which is the same one-build output.

## 10. Milestones

| ID | Milestone | Exit |
|---|---|---|
| D0 | Platform-neutral release (built) | A launch produces JavaScript + a per-platform native manifest; natives mirrored by hash; checks 1 and 4 done |
| D1 | Install | The account installer installs the account's release on all four platforms with one command; checks 2 and 3 done; the verification job passes |
| D2 | Updates | The host updater follows launches on all four platforms; the pin-based installer and per-platform client builds are deleted |
| D3 | AOT | Behind a setting: background AOT compile and swap, CLI first; after #166 |
