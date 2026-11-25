import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountHandleFromUrl, enrollmentTokenForLocation } from './browser-enrollment.js';
import { installDomains, loadInstallDomains, setInstallDomains } from './install-domains.js';
import { DEFAULT_DOMAINS } from '@gitspace/protocol-environment/domains';

afterEach(() => setInstallDomains(DEFAULT_DOMAINS));

describe('install domains in the browser app', () => {
  it('learns them from the Worker that served it', async () => {
    const fetcher = vi.fn(async () => Response.json({ account: 'git.acme.example', service: 'relay.acme.example' }));
    expect(await loadInstallDomains('https://brad.git.acme.example', fetcher)).toEqual({ account: 'git.acme.example', service: 'relay.acme.example' });
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toBe('https://brad.git.acme.example/v1/domains');
    expect(accountHandleFromUrl(new URL('https://brad.git.acme.example/'))).toBe('brad');
    expect(accountHandleFromUrl(new URL('https://brad.gitspace.sh/'))).toBeNull();
    expect(accountHandleFromUrl(new URL('https://api.git.acme.example/'))).toBeNull();
  });

  it('keeps GitSpace\'s own when the Worker does not answer them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await loadInstallDomains('https://brad.gitspace.sh', async () => new Response('no', { status: 404 }))).toEqual(DEFAULT_DOMAINS);
    expect(await loadInstallDomains('https://brad.gitspace.sh', async () => Response.json({ account: 'not a domain' }))).toEqual(DEFAULT_DOMAINS);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(installDomains()).toEqual(DEFAULT_DOMAINS);
    expect(accountHandleFromUrl(new URL('https://brad.gitspace.sh/'))).toBe('brad');
  });

  it('refuses an enrollment link of another install', () => {
    setInstallDomains({ account: 'git.acme.example', service: 'relay.acme.example' });
    const page = new URL('https://brad.git.acme.example/');
    expect(() => enrollmentTokenForLocation('https://brad.gitspace.sh/#enroll=abc', page)).toThrow();
  });
});
