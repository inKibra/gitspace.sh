/** How long a failed send waits before it is sent again (doubling each time), and how many times it is. */
const RETRY_FIRST_MS = 2_000;
const RETRIES = 5;

export interface LatestSender<T> {
  /** Sends `value`; a newer value replaces one still being retried. */
  send(value: T): void;
  /** The newest value has not arrived yet (true until the first send does): every publication sends again. */
  owed(): boolean;
}

/**
 * Keeps the newest value owed to the account until it arrives. A send that fails is sent again after 2 s, doubling, at
 * most five times; past that the value stays owed and the next `send` delivers it. A run of failures is reported once,
 * so a lasting outage cannot fill the log.
 */
export function createLatestSender<T>(deliver: (value: T) => Promise<void>, onFailure: (error: unknown) => void, schedule: (run: () => void, delayMs: number) => void = (run, delayMs) => { setTimeout(run, delayMs); }): LatestSender<T> {
  let newest: { value: T } | null = null;
  let owed = true;
  let attempt = 0;
  let failing = false;
  const send = (value: T, retry = false) => {
    const current = { value };
    if (!retry) attempt = 0;
    newest = current;
    deliver(value).then(() => {
      if (newest !== current) return;
      owed = false;
      failing = false;
    }, (error: unknown) => {
      if (!failing) { failing = true; onFailure(error); }
      if (newest !== current || attempt >= RETRIES) return;
      schedule(() => { if (newest === current) send(value, true); }, RETRY_FIRST_MS * 2 ** attempt++);
    });
    owed = true;
  };
  return { send: value => send(value), owed: () => owed };
}
