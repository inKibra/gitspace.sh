import { z } from 'zod';

/** First line of `install/<platform>.txt`, the metadata an account serves for the installer. */
export const INSTALL_METADATA_MARKER = 'gitspace-install-v2';

const hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const size = z.coerce.number().int().nonnegative();
/** What a computer installs from its account (`install/<platform>.txt`): the release, its portable manifest's SHA-256,
 * the platform's pinned Bun (its upstream archive, and the executable `member` inside it) and the release's client. */
export const installMetadataSchema = z.object({
  release: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u),
  portableSha256: hex64,
  bun: z.object({ sha256: hex64, size, executableSha256: hex64, executableSize: size, member: z.string().regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/u) }),
  cli: z.object({ sha256: hex64, size }),
});
export type InstallMetadata = z.infer<typeof installMetadataSchema>;

/** The metadata as the installer script reads it: one field group per line. */
export function formatInstallMetadata(metadata: InstallMetadata): string {
  const { release, portableSha256, bun, cli } = installMetadataSchema.parse(metadata);
  return `${[INSTALL_METADATA_MARKER, release, portableSha256, `bun ${bun.sha256} ${bun.size} ${bun.executableSha256} ${bun.executableSize} ${bun.member}`, `cli ${cli.sha256} ${cli.size}`].join('\n')}\n`;
}

export function parseInstallMetadata(text: string): InstallMetadata {
  const [marker, release, portableSha256, bun, cli, ...rest] = text.split('\n');
  if (marker !== INSTALL_METADATA_MARKER || rest.some(line => line !== '')) throw new Error('Unsupported install metadata format');
  const [bunTag, sha256, archiveSize, executableSha256, executableSize, member] = (bun ?? '').split(' ');
  const [cliTag, cliSha256, cliSize] = (cli ?? '').split(' ');
  if (bunTag !== 'bun' || cliTag !== 'cli') throw new Error('Invalid install metadata');
  return installMetadataSchema.parse({ release, portableSha256, bun: { sha256, size: archiveSize, executableSha256, executableSize, member }, cli: { sha256: cliSha256, size: cliSize } });
}

/**
 * The POSIX installer an account serves at `/install`, installing that account's release from `distributionUrl` (its
 * `/distribution/v1`) unless GITSPACE_DISTRIBUTION_URL names another base. `install/<platform>.txt` names the release,
 * the platform's pinned Bun (its upstream archive's SHA-256 and size, and the executable's inside it) and the release's
 * client (`cli/gitspace.js`); each download is checked against them before anything is replaced. It installs Bun under
 * `~/.local/share/gitspace/bun/<sha256>/`, the client under `~/.local/share/gitspace/releases/<release>/`, and
 * `~/.local/bin/gitspace` running that client on that Bun. `sh -s -- --pair <token> [--label <label>]` then links the
 * computer with `gitspace machine setup`, which builds the machine runtime from the same release.
 */
export function installScript(distributionUrl: string): string {
  return `#!/bin/sh
set -eu
umask 077

fail() { printf 'GitSpace install: %s\\n' "$*" >&2; exit 1; }
# Options follow \`sh -s --\`: --pair links this computer to the account after the install succeeds.
pair=
label=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pair) [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--pair needs the pairing token from Add a computer.'; pair=$2; shift 2 ;;
    --pair=?*) pair=\${1#--pair=}; shift ;;
    --label) [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--label needs a machine label.'; label=$2; shift 2 ;;
    --label=?*) label=\${1#--label=}; shift ;;
    *) fail "Unknown option $1. Usage: sh -s -- [--pair <token> [--label <label>]]" ;;
  esac
done
[ -n "$pair" ] || [ -z "$label" ] || fail '--label names the computer being paired; use it with --pair.'
command -v curl >/dev/null 2>&1 || fail 'curl is required. Install curl, then run this installer again.'
command -v unzip >/dev/null 2>&1 || fail 'unzip is required to unpack Bun. Install unzip, then run this installer again.'
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)
    os=linux
    libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    case "$libc" in
      'glibc '*) ;;
      *) fail 'Linux requires glibc; Alpine/musl is not supported. Use a glibc-based Linux distribution, or use GitSpace in the browser without pairing.' ;;
    esac
    ;;
  *) fail 'Supported platforms are macOS and glibc Linux, on x64 or arm64. On Windows use WSL2. Browser access needs no machine installation.' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail 'Only x64 and arm64 machines are supported. Use GitSpace in the browser without pairing this machine.' ;;
esac
platform="\${os}-\${arch}"
base="\${GITSPACE_DISTRIBUTION_URL:-${distributionUrl}}"
base="\${base%/}"
case "$base" in
  *'?'*|*'#'*|*'@'*|*[[:space:]]*) fail 'Distribution URL must not contain credentials, whitespace, a query, or a fragment.' ;;
esac
case "$base" in
  https://*) ;;
  http://localhost:*/*|http://127.0.0.1:*/*|http://\\[::1\\]:*/*) ;;
  *) fail 'Distribution URL must use HTTPS. HTTP is allowed only for a local release smoke server.' ;;
esac
if command -v sha256sum >/dev/null 2>&1; then
  sha_of() { set -- $(sha256sum "$1"); printf '%s' "$1"; }
elif command -v shasum >/dev/null 2>&1; then
  sha_of() { set -- $(shasum -a 256 "$1"); printf '%s' "$1"; }
else
  fail 'SHA256 verification requires sha256sum (Linux coreutils) or shasum (macOS).'
fi
size_of() { set -- $(wc -c < "$1"); printf '%s' "$1"; }
# Checks a downloaded file against the SHA-256 and size the account named for it.
verify() { [ "$(sha_of "$1")" = "$2" ] && [ "$(size_of "$1")" = "$3" ] || fail "$4 failed SHA256 verification; the existing installation has not been changed."; }
hex64() { case "$1" in ''|*[!a-f0-9]*) return 1 ;; esac; [ "\${#1}" -eq 64 ]; }
count() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }

install_dir="\${GITSPACE_INSTALL_DIR:-\${HOME}/.local/bin}"
data_dir="\${GITSPACE_DATA_DIR:-\${HOME}/.local/share/gitspace}"
case "\${install_dir}\${data_dir}" in *"'"*) fail 'Install directories must not contain a single quote.' ;; esac
mkdir -p "$install_dir" "$data_dir"
staging=$(mktemp -d "\${data_dir}/.install.XXXXXX")
trap 'rm -rf "$staging"' 0
trap 'exit 1' 1 2 15
# No redirects: metadata and immutable files must be served by this account's own origin.
fetch() { curl --fail --silent --show-error --proto '=https,http' --max-time "$3" --max-filesize "$4" "$1" -o "$2"; }
fetch "\${base}/install/\${platform}.txt" "\${staging}/metadata" 60 4096 || fail 'This account has no release to install. Launch one with the machine target, then run this installer again.'
{
  IFS= read -r marker || fail 'Incomplete install metadata.'
  IFS= read -r release || fail 'Incomplete install metadata.'
  IFS= read -r portable || fail 'Incomplete install metadata.'
  IFS= read -r bun_line || fail 'Incomplete install metadata.'
  IFS= read -r client_line || fail 'Incomplete install metadata.'
  if IFS= read -r extra; then fail 'Unexpected install metadata.'; fi
} < "\${staging}/metadata"
[ "$marker" = ${INSTALL_METADATA_MARKER} ] || fail 'Unsupported install metadata format.'
case "$release" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) fail 'Invalid release identifier.' ;;
esac
[ "\${#release}" -le 160 ] || fail 'Invalid release identifier length.'
hex64 "$portable" || fail 'Invalid release digest.'
set -- $bun_line
[ "$#" -eq 6 ] && [ "$1" = bun ] || fail 'Invalid Bun pin.'
bun_sha=$2 bun_size=$3 bun_exe_sha=$4 bun_exe_size=$5 bun_member=$6
hex64 "$bun_sha" && hex64 "$bun_exe_sha" && count "$bun_size" && count "$bun_exe_size" || fail 'Invalid Bun pin.'
case "$bun_member" in ''|/*|*..*|*[!A-Za-z0-9._/-]*) fail 'Invalid Bun archive member.' ;; esac
set -- $client_line
[ "$#" -eq 3 ] && [ "$1" = cli ] || fail 'Invalid client pin.'
client_sha=$2 client_size=$3
hex64 "$client_sha" && count "$client_size" || fail 'Invalid client pin.'

bun_path="\${data_dir}/bun/\${bun_exe_sha}/bun"
if [ ! -x "$bun_path" ] || [ "$(sha_of "$bun_path")" != "$bun_exe_sha" ]; then
  fetch "\${base}/natives/\${bun_sha}" "\${staging}/bun.zip" 600 536870912 || fail 'Bun could not be downloaded from this account.'
  verify "\${staging}/bun.zip" "$bun_sha" "$bun_size" 'The Bun archive'
  unzip -p "\${staging}/bun.zip" "$bun_member" > "\${staging}/bun" || fail 'The Bun archive has no executable.'
  verify "\${staging}/bun" "$bun_exe_sha" "$bun_exe_size" 'Bun'
  chmod 755 "\${staging}/bun"
  mkdir -p "\${data_dir}/bun/\${bun_exe_sha}"
  mv -f "\${staging}/bun" "$bun_path"
fi
client_path="\${data_dir}/releases/\${release}/gitspace.js"
fetch "\${base}/releases/\${release}/cli/gitspace.js" "\${staging}/gitspace.js" 600 268435456 || fail 'The client could not be downloaded from this account.'
verify "\${staging}/gitspace.js" "$client_sha" "$client_size" 'The client'
mkdir -p "\${data_dir}/releases/\${release}"
mv -f "\${staging}/gitspace.js" "$client_path"
printf '#!/bin/sh\\nexec '"'"'%s'"'"' '"'"'%s'"'"' "$@"\\n' "$bun_path" "$client_path" > "\${staging}/gitspace"
chmod 755 "\${staging}/gitspace"
"\${staging}/gitspace" --version >/dev/null || fail 'The verified client cannot run on this OS/CPU. Upgrade the OS or use GitSpace in the browser without pairing; the existing installation has not been changed.'
# Same-filesystem rename leaves an existing launcher untouched on any download or verification failure.
mv -f "\${staging}/gitspace" "\${install_dir}/gitspace"
printf 'Installed GitSpace %s (%s) at %s/gitspace\\n' "$release" "$platform" "$install_dir"
case ":\${PATH}:" in
  *":\${install_dir}:"*) ;;
  *) printf 'Add %s to PATH to run gitspace.\\n' "$install_dir" ;;
esac
if [ -z "$pair" ]; then
  printf 'Machine pairing is optional; run the pairing command shown in your account (Settings, Machines, Add a computer).\\n'
  exit 0
fi
# Piped to sh, standard input is the rest of this script; setup must not read it.
if [ -n "$label" ]; then
  "\${install_dir}/gitspace" machine setup --pair "$pair" --label "$label" </dev/null
else
  "\${install_dir}/gitspace" machine setup --pair "$pair" </dev/null
fi
`;
}
