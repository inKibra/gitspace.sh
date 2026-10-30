# Tenant releases: the platform publishes, the account decides

Status: proposal for review (2026-10-30). Nothing here is built.

## Today

- **The channel** is the platform's default release: `defaults/account.json` in the platform's `RELEASES` bucket points
  at a manifest (`defaultReleaseSchema`) naming a worker manifest and modules, frontend files, a cloud image, native
  machine artifacts and the portable release, all under `defaults/releases/<commit>/`. `publish-default.yml` writes it.
- **A new account** gets the channel's worker, uploaded by the platform with a `DEFAULT_ACCOUNT_RELEASE` pin
  (`<commit>:<manifest sha256>`) among its bindings. The platform injects that pin again on every later swap.
- **Its frontend**, until the account launches one of its own, is fetched from the platform: the tenant proxies
  `/v1/default-releases/<pin>/frontend/*` to the platform route `defaultFrontendResponse`.
- **Back to stable** asks the platform to `revert { to: 'channel' }`: the platform swaps the tenant script to whatever
  the channel pointer names at that moment (`loadChannel`). The frontend selection is cleared, so the platform-served
  default frontend returns. Machines already decide inside the account (`stableMachineRelease`, since `fbd0e978`).
- **The inference check** before Back to stable asks which worker the platform runs, because the channel's capability is
  only known on the platform side.
- **Cloud machine images** come from the channel's `image` through the platform's compute provider.

So "stable" for the worker and frontend means "whatever the platform's pointer says when you click", and the account
serves a frontend it does not hold.

## Design

### 1. The channel is published, not served

`publish-default.yml` writes each channel release, unchanged in format, and a channel pointer to a **public** R2 bucket
on its own domain (for example `channel.gitspace.sh`). Objects are immutable and named by commit and digest, and the
manifest's SHA-256 is the pin. No platform Worker route serves the channel. The platform Worker reads the same objects
only to create a new account's first script, and for cloud images until those move too (out of scope here).

### 2. An account adopts a channel release into its own storage

`release.adopt(pin)` in the account's releases object:

1. reads the manifest from the channel and checks it against the pin;
2. copies the worker manifest and modules, the frontend files and the portable manifest to
   `releases/<commit>/…` in account storage. Each object is a streamed R2 put carrying its SHA-256, so R2 refuses wrong
   bytes and the Worker hashes nothing (the CPU limit that broke native mirroring). The copy runs in batches across alarm
   turns, which keeps each turn under its subrequest and CPU limits and lets an interrupted copy resume;
3. mirrors the natives the portable release pins, as staging already does;
4. records an ordinary release: source `{ kind: 'channel', commit, pin }`, with `inferenceVersion` from the manifest.

After that an adopted release is like any launched one. Launching it is the existing stage, then the platform's
`/deploy` reading the worker manifest from account storage, and the frontend and machines follow the account's
selection.

### 3. The account decides what stable is

`stable` is one release record per account, stored by its releases object and shown in Settings → Releases. A release
becomes stable when it has (proposed; see the decisions below):

- applied on the worker and served the frontend,
- been applied by every machine that was online for it, and
- run for a soak period (24 h) without a Back to stable.

You can also mark any applied release stable yourself. **Back to stable** launches the stable release to the worker,
the frontend and every machine through the normal launch path; the platform only deploys a manifest from account
storage, as it does for any launch. Machines with no selection, and new computers, follow the same stable release, which
replaces `stableMachineRelease`. The inference check reads `inferenceVersion` from the release record, with no platform
call.

### 4. Updates from the channel are the account's choice

Settings → Releases → Updates: **Automatic**, **Notify** or **Off**.

- **Automatic:** a new channel release is adopted and launched to every target. If the platform's health probe fails, its
  existing automatic revert returns the worker to the previous active release; the account marks the release failed and
  stays where it was. Machines apply it as they apply any selection, each reporting its own failure.
- **Notify:** a notice in the account offers the update with one button (adopt and launch).
- **Off:** the channel is listed and nothing else happens.

### 5. The frontend is always the account's

The tenant serves only frontends held in account storage. A new account adopts the release it was created from, named
by its `DEFAULT_ACCOUNT_RELEASE` binding, as the last step of creation, before its hostname routes. An existing account
adopts its pinned release once, the first time the new tenant release starts. Its frontend selection then names that
release, and the proxy is gone.

## What leaves the platform

- `defaultFrontendResponse` and the `/v1/default-releases/*` route.
- `revert { to: 'channel' }` and the channel fallback in `loadFallback`. A failed swap reverts to the previous active
  release only.
- Injecting `DEFAULT_ACCOUNT_RELEASE` on every swap. It is set once, at creation.
- The platform worker version in the inference check.

The platform keeps uploading scripts with their bindings, probing health and reverting a failed swap, and creating
accounts from the channel, which needs no tenant to exist.

## Order of work

1. Channel bucket and domain; `publish-default.yml` writes there as well as to `RELEASES` (operator).
2. Adoption and `channel` release sources; frontend served from account storage only; existing accounts adopt their pin.
3. Stable selection; Back to stable through launch; machines and installs follow stable.
4. Updates setting and the channel check.
5. Platform cleanup (the list above), once every tenant runs a release from step 2.

Cloud machine images installing from the account's release is the same principle and comes after this.

## Decisions for you

1. **How an account learns of a new channel release.**
   - (a) When Settings → Releases opens, and when a new tenant release starts. Nothing scheduled.
   - (b) Also a daily check by the releases object.
   - (c) The platform tells every account when a release is published. That needs platform fan-out code.
   - Recommended: (a) + (b). An account on Automatic otherwise waits until someone opens Releases.
2. **What makes a release stable.**
   - (a) Automatic after the 24 h soak above, plus marking it yourself.
   - (b) Only when you mark it.
   - (c) The newest release that applied everywhere, with no soak.
   - Recommended: (a).
3. **Updates setting for new accounts.**
   - Notify, or Automatic.
   - Recommended: Notify until the automatic path has run on a few accounts.
4. **Where the channel lives.**
   - (a) A public bucket on its own domain, with no platform code.
   - (b) The current `RELEASES` bucket behind a platform route.
   - Recommended: (a).
