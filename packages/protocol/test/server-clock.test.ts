import { describe, expect, it } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  createSignedRpcFetch,
  decodeSignedRpcHeader,
  RPC_DEVICE_HEADER,
  SIGNED_REQUEST_EXPIRED_CODE,
  SIGNED_REQUEST_EXPIRED_MESSAGE,
  SIGNED_REQUEST_MAX_AGE_MS,
} from '../src/index.js';

const signingPrivateKey = ed25519.utils.randomSecretKey();
const deviceId = '123e4567-e89b-42d3-a456-426614174000';
const FIVE_MINUTES = 5 * 60_000;

/** An account whose clock runs `skewMs` ahead of this process and enforces the signed-request window. */
function account(skewMs: number, options: { forwardedDate?: string } = {}) {
  const timestamps: number[] = [];
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    const request = new Request(input, init);
    const header = decodeSignedRpcHeader(request.headers.get(RPC_DEVICE_HEADER) ?? '');
    if (!header) throw new Error('unsigned request');
    timestamps.push(header.timestamp);
    const now = Date.now() + skewMs;
    if (Math.abs(now - header.timestamp) > SIGNED_REQUEST_MAX_AGE_MS) {
      return Response.json({ status: 'error', error: { code: SIGNED_REQUEST_EXPIRED_CODE, message: SIGNED_REQUEST_EXPIRED_MESSAGE } }, { status: 401, headers: { date: new Date(now).toUTCString() } });
    }
    return new Response('ok', { headers: { date: options.forwardedDate ?? new Date(now).toUTCString() } });
  };
  return { timestamps, fetch: Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }) };
}

describe('server clock', () => {
  it('learns the account offset from the first expired rejection and signs within the window afterwards', async () => {
    const server = account(FIVE_MINUTES);
    const signed = createSignedRpcFetch({ deviceId, signingPrivateKey, fetch: server.fetch });

    const first = await signed('https://account.test/rpc', { method: 'POST', body: 'one' });
    expect(first.status).toBe(200);
    expect(server.timestamps).toHaveLength(2);
    expect(Math.abs(server.timestamps[1]! - (Date.now() + FIVE_MINUTES))).toBeLessThan(SIGNED_REQUEST_MAX_AGE_MS);

    const second = await signed('https://account.test/rpc', { method: 'POST', body: 'two' });
    expect(second.status).toBe(200);
    expect(server.timestamps).toHaveLength(3);
  });

  it('re-signs only once when the retry is also rejected', async () => {
    let attempts = 0;
    const alwaysExpired = Object.assign(async () => {
      attempts += 1;
      return Response.json({ status: 'error', error: { code: SIGNED_REQUEST_EXPIRED_CODE, message: SIGNED_REQUEST_EXPIRED_MESSAGE } }, { status: 401 });
    }, { preconnect: globalThis.fetch.preconnect });
    const response = await createSignedRpcFetch({ deviceId, signingPrivateKey, fetch: alwaysExpired })('https://account.test/rpc', { method: 'POST', body: 'x' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: SIGNED_REQUEST_EXPIRED_CODE } });
    expect(attempts).toBe(2);
  });

  it('does not learn from accepted responses, whose Date may be a forwarded machine clock', async () => {
    const server = account(0, { forwardedDate: new Date(Date.now() + FIVE_MINUTES).toUTCString() });
    const signed = createSignedRpcFetch({ deviceId, signingPrivateKey, fetch: server.fetch });
    await signed('https://account.test/rpc', { method: 'POST', body: 'one' });
    await signed('https://account.test/rpc', { method: 'POST', body: 'two' });
    expect(server.timestamps).toHaveLength(2);
    expect(Math.abs(server.timestamps[1]! - Date.now())).toBeLessThan(SIGNED_REQUEST_MAX_AGE_MS);
  });

  it('never retries a rejection other than expiry', async () => {
    let attempts = 0;
    const revoked = Object.assign(async () => {
      attempts += 1;
      return Response.json({ error: { code: 'RPC_DEVICE_UNKNOWN', message: 'Device is not enrolled or has been revoked' } }, { status: 401 });
    }, { preconnect: globalThis.fetch.preconnect });
    expect((await createSignedRpcFetch({ deviceId, signingPrivateKey, fetch: revoked })('https://account.test/rpc', { method: 'POST', body: 'x' })).status).toBe(401);
    expect(attempts).toBe(1);
  });
});
