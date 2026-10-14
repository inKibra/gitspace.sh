/** Code a verifier returns when a signature is otherwise valid but its timestamp is outside the window. */
export const SIGNED_REQUEST_EXPIRED_CODE = 'REQUEST_EXPIRED';
export const SIGNED_REQUEST_EXPIRED_MESSAGE = 'Signed request expired';

/**
 * The account's notion of now, as seen by one signing client. Verifiers accept a
 * narrow window around their own clock, so signers stamp requests with local time
 * corrected by the offset learned from the `Date` header of the account's responses.
 */
export interface ServerClock {
  now(): number;
  observe(response: Response): void;
}

export function createServerClock(): ServerClock {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    observe(response) {
      const date = Date.parse(response.headers.get('date') ?? '');
      if (Number.isFinite(date)) offset = date - Date.now();
    },
  };
}

/** A verifier's rejection of the timestamp alone; reads a clone so the response stays consumable. */
export async function signedRequestExpired(response: Response): Promise<boolean> {
  if (response.status !== 401 && response.status !== 403) return false;
  return (await response.clone().text()).includes(SIGNED_REQUEST_EXPIRED_CODE);
}

/**
 * Sends a request signed at `clock.now()`. An expired rejection changed nothing on
 * the server and carries the verifier's own `Date`, so the clock learns from it and
 * the request is re-signed once; `send` must therefore be replayable. Other responses
 * are not observed: the account forwards machine and service responses with their
 * origin's `Date`.
 */
export async function sendSigned(clock: ServerClock, send: (timestamp: number) => Promise<Response>): Promise<Response> {
  const response = await send(clock.now());
  if (!await signedRequestExpired(response)) return response;
  clock.observe(response);
  await response.body?.cancel();
  return send(clock.now());
}
