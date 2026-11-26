import { describe, expect, test } from 'bun:test';
import {
  accountUrl, domainsFromMeta, withDomainsMeta, withDomainsPage, apiUrl, DEFAULT_DOMAINS, domainsFromSettings, EnvironmentError, handleOfAccountHostname, hostedServiceSuffix,
  ingressUrlAllowed, isInstallHostname, platformUrl, relayUrl, sandboxesHostname, serviceDomainOfRelayUrl, siteUrl,
} from '../src/index.js';

const onPrem = domainsFromSettings({ ACCOUNT_DOMAIN: 'git.acme.example', SERVICE_DOMAIN: 'relay.acme.example' });

describe('install domains', () => {
  test('unset or empty settings are GitSpace\'s own domains', () => {
    expect(domainsFromSettings({})).toEqual(DEFAULT_DOMAINS);
    expect(domainsFromSettings({ ACCOUNT_DOMAIN: '', SERVICE_DOMAIN: '' })).toEqual({ account: 'gitspace.sh', service: 'gssh.dev' });
  });

  test('GitSpace\'s own URLs are unchanged by default', () => {
    expect(accountUrl(DEFAULT_DOMAINS, 'brad')).toBe('https://brad.gitspace.sh');
    expect(relayUrl(DEFAULT_DOMAINS, 'brad')).toBe('https://brad.gssh.dev');
    expect(apiUrl(DEFAULT_DOMAINS)).toBe('https://api.gitspace.sh');
    expect(siteUrl(DEFAULT_DOMAINS)).toBe('https://gitspace.sh');
    expect(platformUrl(DEFAULT_DOMAINS)).toBe('https://platform.gssh.dev');
    expect(sandboxesHostname(DEFAULT_DOMAINS)).toBe('sandboxes.gitspace.sh');
    expect(hostedServiceSuffix(DEFAULT_DOMAINS, 'u-1')).toBe('--u-1-srv.gssh.dev');
  });

  test('an install\'s domains make its URLs', () => {
    expect(accountUrl(onPrem, 'brad')).toBe('https://brad.git.acme.example');
    expect(relayUrl(onPrem, 'brad')).toBe('https://brad.relay.acme.example');
    expect(apiUrl(onPrem)).toBe('https://api.git.acme.example');
    expect(platformUrl(onPrem)).toBe('https://platform.relay.acme.example');
    expect(hostedServiceSuffix(onPrem, 'u-1')).toBe('--u-1-srv.relay.acme.example');
  });

  test('an account hostname names its handle only under the install\'s account domain', () => {
    expect(handleOfAccountHostname(onPrem, 'brad.git.acme.example')).toBe('brad');
    expect(handleOfAccountHostname(onPrem, 'BRAD.git.acme.example')).toBe('brad');
    expect(handleOfAccountHostname(onPrem, 'brad.gitspace.sh')).toBeNull();
    expect(handleOfAccountHostname(onPrem, 'brad.gitXacme.example')).toBeNull();
    expect(handleOfAccountHostname(onPrem, 'a.brad.git.acme.example')).toBeNull();
    expect(handleOfAccountHostname(DEFAULT_DOMAINS, 'brad.gitspace.sh')).toBe('brad');
  });

  test('a malformed domain is refused, not replaced by the default', () => {
    for (const ACCOUNT_DOMAIN of ['https://acme.example', 'Acme.Example', 'acme', 'acme.example.', '*.acme.example']) {
      expect(() => domainsFromSettings({ ACCOUNT_DOMAIN })).toThrow(EnvironmentError);
    }
  });

  test('install hosts are reserved from service ingress, beside GitSpace\'s own', () => {
    expect(isInstallHostname(onPrem, 'x.relay.acme.example')).toBe(true);
    expect(isInstallHostname(onPrem, 'acme.example')).toBe(false);
    expect(ingressUrlAllowed('https://issuer.relay.acme.example/', onPrem)).toBe(false);
    expect(ingressUrlAllowed('https://brad.git.acme.example/', onPrem)).toBe(false);
    expect(ingressUrlAllowed('https://brad.gitspace.sh/', onPrem)).toBe(false);
    expect(ingressUrlAllowed('https://issuer.acme.example/', onPrem)).toBe(true);
  });

  test('a machine learns the service domain from its account\'s relay URL', () => {
    expect(serviceDomainOfRelayUrl('https://brad.gssh.dev', 'brad')).toBe('gssh.dev');
    expect(serviceDomainOfRelayUrl('https://brad.relay.acme.example/', 'brad')).toBe('relay.acme.example');
    expect(serviceDomainOfRelayUrl('https://other.gssh.dev', 'brad')).toBeNull();
    expect(serviceDomainOfRelayUrl('not a url', 'brad')).toBeNull();
  });

  test('a served page names the domains, and an app reads them; a page naming none is GitSpace\'s own, invalid ones an error', () => {
    const page = withDomainsMeta('<!doctype html><html><head><title>x</title></head><body></body></html>', onPrem);
    expect(page).toContain('<head><meta name="gitspace-domains" content="{&quot;account&quot;:&quot;git.acme.example&quot;');
    const content = /content="([^"]*)"/u.exec(page)![1]!.replace(/&quot;/gu, '"');
    expect(domainsFromMeta(content)).toEqual(onPrem);
    expect(domainsFromMeta(null)).toEqual(DEFAULT_DOMAINS);
    expect(() => domainsFromMeta('{"account":"gitspace.sh"}')).toThrow(EnvironmentError);
    expect(() => withDomainsMeta('<p>no head</p>', onPrem)).toThrow(EnvironmentError);
    // Served on by another Worker: one page, one set of domains (the last Worker's).
    const again = withDomainsMeta(withDomainsMeta('<html><head></head></html>', DEFAULT_DOMAINS), onPrem);
    expect(again.match(/gitspace-domains/gu)).toHaveLength(1);
    expect(again).toContain('git.acme.example');
  });

  test('a Worker names them in an app page it serves, and leaves any other response alone', async () => {
    const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"e1"', 'content-length': String(body.length) } });
    const page = await withDomainsPage(html('<html><head></head><body></body></html>'), onPrem);
    expect(await page.text()).toContain('<head><meta name="gitspace-domains"');
    expect(page.headers.get('etag')).toBe('W/"e1-git.acme.example-relay.acme.example"');
    expect(page.headers.get('content-length')).toBeNull();
    expect(await (await withDomainsPage(html('released index'), onPrem)).text()).toBe('released index');
    const script = new Response('let x = 1;', { headers: { 'content-type': 'text/javascript' } });
    expect(await withDomainsPage(script, onPrem)).toBe(script);
  });
});
