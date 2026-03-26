const GITSPACE_HOST_SUFFIX = '.gitspace.sh';
const TMUX_HOSTING_INPUT_PATTERN = /^[a-z0-9-]+(?:\.serve)*(?:\.gitspace\.sh)?$/;

export function normalizeTmuxHostingBaseHost(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('Hosting route cannot be empty');
  }
  if (!TMUX_HOSTING_INPUT_PATTERN.test(trimmed)) {
    throw new Error('Hosting route must be a reserved subdomain or gitspace.sh hostname');
  }

  const withoutDomain = trimmed.endsWith(GITSPACE_HOST_SUFFIX)
    ? trimmed.slice(0, -GITSPACE_HOST_SUFFIX.length)
    : trimmed;
  const rootSubdomain = withoutDomain.replace(/(?:\.serve)+$/, '');
  if (!rootSubdomain) {
    throw new Error('Hosting route must include a reserved subdomain');
  }

  return `${rootSubdomain}${GITSPACE_HOST_SUFFIX}`;
}

export function parseTmuxHostingBaseHost(input: string): { rootHost: string; rootSubdomain: string } {
  const rootHost = normalizeTmuxHostingBaseHost(input);
  const rootSubdomain = rootHost.slice(0, -GITSPACE_HOST_SUFFIX.length);
  return {
    rootHost,
    rootSubdomain,
  };
}
