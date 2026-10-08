import { describe, expect, it } from 'bun:test';
import { EnvironmentBundleSchema, bundleTerminalSection, terminalEnvironment } from '@gitspace/protocol-environment';

const bundle = (terminal: unknown, extra: Record<string, unknown> = {}) => ({ version: 1, profiles: { base: { secrets: ['GH_TOKEN'], values: ['APP_MODE'] } }, values: { APP_MODE: {} }, terminal, ...extra });
const accepts = (terminal: unknown) => EnvironmentBundleSchema.safeParse(bundle(terminal)).success;

describe('bundle terminal section', () => {
  it('accepts checkout-relative and home-relative path entries with plain env values', () => {
    expect(accepts({ path: ['node_modules/.bin', '.gitspace/bin', '~/.cargo/bin'], env: { NODE_ENV: 'development', _JAVA_OPTIONS: '-Xmx1g', npm_config_color: 'false' } })).toBe(true);
    expect(accepts({})).toBe(true);
    expect(EnvironmentBundleSchema.safeParse(bundle(undefined)).success).toBe(true);
  });

  it('rejects absolute, escaping, empty, and PATH-separator path entries', () => {
    for (const entry of ['', '/usr/local/bin', '../bin', 'bin/../../etc', 'node_modules//.bin', 'bin/', './bin', '~', '~/', '~user/bin', 'bin/~x', 'a:b', 'a\\b', '~/../etc']) {
      expect(accepts({ path: [entry] })).toBe(false);
    }
  });

  it('rejects PATH, reserved, invalid, secret-like, and declared value or secret env names', () => {
    for (const name of ['PATH', 'GITSPACE_TOKEN_SCOPE', 'GITSPACE_MODE', '1BAD', 'BAD-NAME', '', 'DATABASE_PASSWORD', 'STRIPE_API_KEY', 'GH_TOKEN', 'APP_MODE']) {
      expect(accepts({ env: { [name]: 'x' } })).toBe(false);
    }
    expect(accepts({ env: { REMOTE: 'https://user:pass@example.com/repo.git' } })).toBe(false);
    expect(accepts({ env: { AUTH: 'Bearer abc.def' } })).toBe(false);
    expect(accepts({ extra: true })).toBe(false);
  });

  it('reads leniently: missing, malformed, or invalid bundles contribute no terminal section', () => {
    expect(bundleTerminalSection(JSON.stringify(bundle({ path: ['node_modules/.bin'] })))).toEqual({ path: ['node_modules/.bin'] });
    expect(bundleTerminalSection(null)).toBeNull();
    expect(bundleTerminalSection('{')).toBeNull();
    expect(bundleTerminalSection(JSON.stringify(bundle(undefined)))).toBeNull();
    expect(bundleTerminalSection(JSON.stringify(bundle({ path: ['node_modules/.bin'] }, { profiles: {} })))).toBeNull();
    expect(bundleTerminalSection(JSON.stringify(bundle({ path: ['/bin'] })))).toBeNull();
  });
});

describe('terminalEnvironment', () => {
  const inherited = { PATH: '/usr/bin:/repo/node_modules/.bin:/bin', HOME: '/home/dev', LANG: 'C' };

  it('prepends resolved entries in bundle order, expands ~/, and drops inherited duplicates', () => {
    expect(terminalEnvironment({ checkoutRoot: '/repo/', home: '/home/dev/', inherited, bundle: { path: ['node_modules/.bin', '~/.cargo/bin', '.gitspace/bin', 'node_modules/.bin'], env: { NODE_ENV: 'test' } } })).toEqual({
      PATH: '/repo/node_modules/.bin:/home/dev/.cargo/bin:/repo/.gitspace/bin:/usr/bin:/bin',
      HOME: '/home/dev',
      LANG: 'C',
      NODE_ENV: 'test',
    });
  });

  it('builds PATH from entries alone when nothing is inherited and lets bundle env override inherited values', () => {
    expect(terminalEnvironment({ checkoutRoot: '/repo', home: '/h', inherited: { LANG: 'C' }, bundle: { path: ['bin'], env: { LANG: 'en_US.UTF-8' } } })).toEqual({ PATH: '/repo/bin', LANG: 'en_US.UTF-8' });
  });

  it('returns the inherited environment unchanged without a bundle or path entries', () => {
    expect(terminalEnvironment({ checkoutRoot: '/repo', home: '/h', inherited, bundle: null })).toEqual(inherited);
    expect(terminalEnvironment({ checkoutRoot: '/repo', home: '/h', inherited, bundle: { env: { A: 'b' } } })).toEqual({ ...inherited, A: 'b' });
  });
});
