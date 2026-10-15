import { accountDirectoryMessageSchema, applyAccountDirectoryMessage, workspaceStatusMessageSchema, type AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import { liveNoticeMessageSchema } from '@gitspace/protocol/live-notice';
import { DEVICE_SOCKET_PROTOCOL } from '@gitspace/protocol/socket-auth';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { currentDevice, deviceRejected } from './device-session.js';
import { createDeviceSignedFetch, DeviceRejectedError, signDeviceRequest, type BrowserDevice } from './device.js';
import { liveNotices, type LiveNotices } from './live-notices.js';
import { workspaceStatuses, type WorkspaceStatuses } from './workspace-statuses.js';
import type { SynchronizationSource } from './synchronization.js';

const MAX_FRAME_SIZE = 8 * 1024 * 1024;
/** Cursors for directory states: increasing across sockets, so a newer state always replaces an older one. */
let directoryCursor = 0;

/** WebCrypto and IndexedDB cannot be cancelled, but their late completions must not open a socket. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
  signal.addEventListener('abort', abort, { once: true });
  work.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
  if (signal.aborted) abort();
  return promise;
}

/** The tab's one socket: account directory events, and live notices for the keys `notices` watches. */
export function createAccountDirectorySource(options: {
  currentDevice: () => Promise<BrowserDevice | null>;
  onRejected: (code: string) => void;
  origin: () => string;
  openSocket?: (url: string, protocols: string[]) => WebSocket;
  notices?: LiveNotices;
  statuses?: WorkspaceStatuses;
}): SynchronizationSource<AccountDirectorySnapshot> {
  const notices = options.notices ?? liveNotices;
  const statuses = options.statuses ?? workspaceStatuses;
  const signedFetch = createDeviceSignedFetch(options.currentDevice, options.onRejected);
  return async function* (_after, signal) {
    if (signal.aborted) return;
    const url = new URL('/v1/directory/events', options.origin());
    // The whole directory arrives first on every socket, then the slices that change.
    let directory: AccountDirectorySnapshot | null = null;
    let socket: WebSocket | undefined;
    let detach = () => {};
    try {
      const device = await abortable(options.currentDevice(), signal);
      if (!device) throw new DeviceRejectedError('NOT_ENROLLED');
      const auth = await abortable(signDeviceRequest(device, { method: 'GET', path: `${url.pathname}${url.search}`, body: new Uint8Array() }), signal);
      if (signal.aborted) return;
      const socketUrl = new URL(url);
      socketUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      // The proof rides in `Sec-WebSocket-Protocol`; URLs reach logs and history.
      socket = (options.openSocket ?? ((target, protocols) => new WebSocket(target, protocols)))(socketUrl.href, [`${DEVICE_SOCKET_PROTOCOL}${auth}`]);
      const queue: Array<{ value: StreamEvent<AccountDirectorySnapshot>; size: number }> = [];
      let queuedBytes = 0;
      let opened = false;
      let ended = false;
      let failure: Error | null = null;
      let rejected = false;
      let notify = () => {};
      const finish = (error: Error | null) => {
        if (ended) return;
        ended = true;
        failure = error;
        notify();
      };
      const open = () => {
        opened = true;
        if (socket) notices.attach(socket);
      };
      const message = (event: MessageEvent) => {
        if (ended) return;
        try {
          if (typeof event.data !== 'string') throw new Error('Account directory requires JSON text frames');
          if (event.data.length > MAX_FRAME_SIZE || queuedBytes + event.data.length > MAX_FRAME_SIZE) throw new Error('Account directory delivery exceeded its size limit');
          const decoded: unknown = JSON.parse(event.data);
          const notice = liveNoticeMessageSchema.safeParse(decoded);
          if (notice.success) {
            notices.receive(notice.data);
            return;
          }
          const status = workspaceStatusMessageSchema.safeParse(decoded);
          if (status.success) {
            statuses.receive(status.data);
            return;
          }
          directory = applyAccountDirectoryMessage(directory, accountDirectoryMessageSchema.parse(decoded));
          if (!directory) return;
          const cursor = ++directoryCursor;
          queue.push({ value: { type: 'snapshot', resource: 'account-directory', cursor, revision: cursor, previous: null, value: directory }, size: event.data.length });
          queuedBytes += event.data.length;
          notify();
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      };
      // A socket error is always followed by its close, which carries the code: 1001/1006/1012 are deploys and
      // network drops, 1008/1013 come from the server with a reason.
      const error = () => {};
      const close = (event: CloseEvent) => {
        rejected = event.code === 4401 && event.reason === 'RPC_DEVICE_UNKNOWN';
        if (!rejected) console.info(JSON.stringify({ event: 'account_directory_closed', code: event.code, reason: event.reason, opened }));
        finish(rejected ? new DeviceRejectedError('RPC_DEVICE_UNKNOWN') : new Error(`Account directory disconnected (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`));
      };
      const abort = () => { queue.length = 0; finish(null); detach(); };
      detach = () => {
        signal.removeEventListener('abort', abort);
        socket?.removeEventListener('open', open);
        socket?.removeEventListener('message', message);
        socket?.removeEventListener('error', error);
        socket?.removeEventListener('close', close);
        if (socket) notices.detach(socket);
        if (socket && (socket.readyState === 0 || socket.readyState === 1)) socket.close();
      };
      socket.addEventListener('open', open);
      socket.addEventListener('message', message);
      socket.addEventListener('error', error);
      socket.addEventListener('close', close);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      while (!signal.aborted) {
        const next = queue.shift();
        if (next) { queuedBytes -= next.size; yield { status: 'ok', value: next.value }; continue; }
        if (ended) break;
        const ready = Promise.withResolvers<void>();
        notify = ready.resolve;
        await ready.promise;
      }
      detach();
      if (signal.aborted) return;
      if (rejected) {
        // A late socket rejection must never revoke a replacement enrolled meanwhile.
        if ((await abortable(options.currentDevice(), signal))?.deviceId === device.deviceId) options.onRejected('RPC_DEVICE_UNKNOWN');
      } else if (!opened) {
        // Browsers hide failed Upgrade responses. One signed diagnostic request preserves
        // enrollment rejection handling; generic network/authority failures never clear it.
        try { await abortable(signedFetch(url, { signal }), signal); } catch { /* Report the original transport failure. */ }
      }
      if (failure) yield { status: 'error', error: failure };
    } catch (error) {
      if (!signal.aborted) yield { status: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    } finally { detach(); }
  };
}

export const accountDirectorySource = createAccountDirectorySource({ currentDevice, onRejected: deviceRejected, origin: () => window.location.origin });
