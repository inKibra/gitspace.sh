// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOMAINS, withDomainsMeta } from '@gitspace/protocol-environment/domains';
import { accountHandleFromUrl, enrollmentTokenForLocation } from './browser-enrollment.js';
import { installDomains, setInstallDomains } from './install-domains.js';

const onPrem = { account: 'git.acme.example', service: 'relay.acme.example' };

afterEach(() => setInstallDomains(DEFAULT_DOMAINS));

describe('install domains in the browser app', () => {
  it('reads them from the page the Worker served, with no request', () => {
    document.documentElement.innerHTML = /<html>([\s\S]*)<\/html>/u.exec(withDomainsMeta('<html><head><title>GitSpace</title></head><body></body></html>', onPrem))![1]!;
    setInstallDomains(undefined);
    expect(installDomains()).toEqual(onPrem);
    expect(accountHandleFromUrl(new URL('https://brad.git.acme.example/'))).toBe('brad');
    expect(accountHandleFromUrl(new URL('https://brad.gitspace.sh/'))).toBeNull();
    expect(accountHandleFromUrl(new URL('https://api.git.acme.example/'))).toBeNull();
  });

  it('reads GitSpace\'s own from a page an older Worker served, and refuses a page naming invalid ones', () => {
    // A release applies its frontend and Worker separately: this app can be served by a Worker that names none.
    document.documentElement.innerHTML = '<head></head><body></body>';
    setInstallDomains(undefined);
    expect(installDomains()).toEqual(DEFAULT_DOMAINS);
    expect(accountHandleFromUrl(new URL('https://brad.gitspace.sh/'))).toBe('brad');
    document.documentElement.innerHTML = '<head><meta name="gitspace-domains" content="{&quot;account&quot;:&quot;gitspace.sh&quot;}"></head><body></body>';
    setInstallDomains(undefined);
    expect(() => installDomains()).toThrow('names no valid install domains');
  });

  it('refuses an enrollment link of another install', () => {
    setInstallDomains(onPrem);
    expect(() => enrollmentTokenForLocation('https://brad.gitspace.sh/#enroll=abc', new URL('https://brad.git.acme.example/'))).toThrow();
  });
});
