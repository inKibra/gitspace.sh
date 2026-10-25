import { describe, expect, it } from 'bun:test';
import { tabWithinGrant } from '../src/commands.js';

const grant = { origins: ['app.example'] };

describe('a tab inside its workspace grant', () => {
  it('stays inside while Chrome reports its debugger target URL as empty mid-navigation', () => {
    expect(tabWithinGrant(grant, { tabUrl: 'https://app.example/form', pendingUrl: 'https://app.example/form', targetUrl: '' })).toBe(true);
  });
  it('is outside as soon as it is navigating off the grant, before the new page commits', () => {
    expect(tabWithinGrant(grant, { tabUrl: 'https://app.example/form', pendingUrl: 'https://elsewhere.example/', targetUrl: 'https://app.example/form' })).toBe(false);
  });
  it('is outside when its committed or target URL is off the grant', () => {
    expect(tabWithinGrant(grant, { tabUrl: 'https://elsewhere.example/', targetUrl: 'https://app.example/' })).toBe(false);
    expect(tabWithinGrant(grant, { tabUrl: 'https://app.example/', targetUrl: 'https://elsewhere.example/' })).toBe(false);
    expect(tabWithinGrant(grant, { tabUrl: '', targetUrl: 'https://app.example/' })).toBe(false);
  });
  it('is inside while a tab opened on a granted page has not committed it yet, and outside when it opens elsewhere', () => {
    expect(tabWithinGrant(grant, { tabUrl: '', pendingUrl: 'https://app.example/form', targetUrl: 'https://app.example/form' })).toBe(true);
    expect(tabWithinGrant(grant, { tabUrl: '', pendingUrl: 'https://app.example/form', targetUrl: '' })).toBe(true);
    expect(tabWithinGrant(grant, { tabUrl: '', pendingUrl: 'https://elsewhere.example/' })).toBe(false);
  });
});
