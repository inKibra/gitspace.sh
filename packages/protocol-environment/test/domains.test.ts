import { describe, expect, test } from 'bun:test';
import {
  accountUrl, apiUrl, DEFAULT_DOMAINS, domainsFromSettings, EnvironmentError, handleOfAccountHostname, hostedServiceSuffix,
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
});
