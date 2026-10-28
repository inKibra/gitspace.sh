/**
 * The POSIX installer served at `/install`, installing from `distributionUrl` unless GITSPACE_DISTRIBUTION_URL names
 * another base. It verifies the client named by `stable/<platform>.txt` against that channel's SHA-256 before replacing
 * an installation; `sh -s -- --pair <token> [--label <label>]` then links the computer with `gitspace machine setup`.
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
  *) fail 'Only x64 and arm64 machines have prebuilt runtimes. Use GitSpace in the browser without pairing this machine.' ;;
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
  hash_command=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  hash_command=shasum
else
  fail 'SHA256 verification requires sha256sum (Linux coreutils) or shasum (macOS).'
fi

install_dir="\${GITSPACE_INSTALL_DIR:-\${HOME}/.local/bin}"
mkdir -p "$install_dir"
staging=$(mktemp -d "\${install_dir}/.gitspace-install.XXXXXX")
trap 'rm -rf "$staging"' 0
trap 'exit 1' 1 2 15
# No redirects: channel metadata and immutable assets must be served by this trusted distribution origin.
curl --fail --silent --show-error --max-time 60 --max-filesize 1024 "\${base}/stable/\${platform}.txt" -o "\${staging}/channel" 
{
  IFS= read -r marker || fail 'Incomplete release channel.'
  IFS= read -r release || fail 'Incomplete release channel.'
  IFS= read -r expected || fail 'Incomplete release channel.'
  if IFS= read -r extra; then fail 'Unexpected release channel data.'; fi
} < "\${staging}/channel"
[ "$marker" = gitspace-distribution-v1 ] || fail 'Unsupported release channel format.'
case "$release" in
  ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) fail 'Invalid release identifier.' ;;
esac
[ "\${#release}" -le 128 ] || fail 'Invalid release identifier length.'
case "$expected" in
  ''|*[!a-f0-9]*) fail 'Invalid release SHA256.' ;;
esac
[ "\${#expected}" -eq 64 ] || fail 'Invalid release SHA256 length.'
curl --fail --silent --show-error --max-time 600 --max-filesize 536870912 "\${base}/releases/\${release}/\${platform}/gitspace" -o "\${staging}/gitspace"
if [ "$hash_command" = sha256sum ]; then
  actual=$(sha256sum "\${staging}/gitspace")
else
  actual=$(shasum -a 256 "\${staging}/gitspace")
fi
actual="\${actual%% *}"
[ "$actual" = "$expected" ] || fail 'Downloaded client failed SHA256 verification; the existing installation has not been changed.'
chmod 755 "\${staging}/gitspace"
"\${staging}/gitspace" --version || fail 'The verified client cannot run on this OS/CPU. Upgrade the OS or use GitSpace in the browser without pairing; the existing installation has not been changed.'
# Same-filesystem rename leaves an existing client untouched on any download or verification failure.
mv -f "\${staging}/gitspace" "\${install_dir}/gitspace"
printf 'Installed GitSpace %s (%s) at %s/gitspace\\n' "$release" "$platform" "$install_dir"
case ":\${PATH}:" in
  *":\${install_dir}:"*) ;;
  *) printf 'Add %s to PATH to run gitspace.\\n' "$install_dir" ;;
esac
if [ -z "$pair" ]; then
  printf 'Create your account in the browser at https://gitspace.sh. Machine pairing is optional; run the pairing command shown in the app.\\n'
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
