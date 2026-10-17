import { describe, expect, it } from 'vitest';
import { upstreamLoginEvent } from '../src/upstream-oauth.js';

describe('cloud sign-in events', () => {
  it('drops the note about a loopback port the cloud could never receive a redirect on', () => {
    expect(upstreamLoginEvent({ type: 'info', message: 'Could not listen on http://127.0.0.1:1455/auth/callback; paste the final redirect URL to continue. bind EADDRINUSE 127.0.0.1:1455' })).toBeNull();
    expect(upstreamLoginEvent({ type: 'info', message: 'Opening your browser' })).toEqual({ type: 'progress', message: 'Opening your browser' });
  });

  it('tells the person to paste the address a loopback redirect leaves in their browser', () => {
    const loopback = upstreamLoginEvent({ type: 'auth_url', url: 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&agent_name_hint=pi', instructions: 'If the callback does not complete, paste the final redirect URL here.' });
    expect(loopback).toMatchObject({ type: 'auth', instructions: expect.stringContaining('paste it below') });
    expect(loopback?.type === 'auth' ? new URL(loopback.url).searchParams.get('agent_name_hint') : null).toBe('GitSpace');
    // A provider that redirects to a real site keeps its own instructions.
    expect(upstreamLoginEvent({ type: 'auth_url', url: 'https://example.com/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fdone', instructions: 'Approve on the site' })).toMatchObject({ instructions: 'Approve on the site' });
  });
});
