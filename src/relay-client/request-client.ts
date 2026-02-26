import type { RelaySocketAdapter } from './machine-directory-client.js';

export class RelayRequestError extends Error {
  code: string;
  relayMessage: string;

  constructor(code: string, relayMessage: string) {
    super(`[${code}] ${relayMessage}`);
    this.name = 'RelayRequestError';
    this.code = code;
    this.relayMessage = relayMessage;
  }
}

export interface RelayRequestClientOptions<TSocket> {
  relayUrl: string;
  socketAdapter: RelaySocketAdapter<TSocket>;
  timeoutMs?: number;
}

export class RelayRequestClient<TSocket> {
  private readonly options: RelayRequestClientOptions<TSocket>;

  constructor(options: RelayRequestClientOptions<TSocket>) {
    this.options = options;
  }

  async sendRequest<T>(
    createPayload: () => Record<string, unknown>,
    onMessage: (msg: Record<string, unknown>) => T | null,
  ): Promise<T> {
    const socketUrl = new URL(this.options.relayUrl);
    socketUrl.searchParams.set('role', 'client');

    return await new Promise<T>((resolve, reject) => {
      const socket = this.options.socketAdapter.createSocket(socketUrl.toString());
      const timeout = setTimeout(() => {
        fail(new Error('Timed out waiting for relay response'));
      }, this.options.timeoutMs ?? 20000);

      let finished = false;

      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        this.cleanupSocket(socket);
        reject(error);
      };

      const succeed = (value: T) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        this.cleanupSocket(socket);
        resolve(value);
      };

      this.options.socketAdapter.setHandlers(socket, {
        onOpen: () => {
          try {
            this.options.socketAdapter.send(socket, JSON.stringify(createPayload()));
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        },
        onMessage: (raw) => {
          try {
            const msg = JSON.parse(raw) as Record<string, unknown>;

            if (msg.type === 'error') {
              const code = typeof msg.code === 'string' ? msg.code : 'ERROR';
              const message = typeof msg.message === 'string' ? msg.message : 'Relay request failed';
              fail(new RelayRequestError(code, message));
              return;
            }

            const parsed = onMessage(msg);
            if (parsed !== null) {
              succeed(parsed);
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        },
        onClose: () => {
          if (!finished) {
            fail(new Error('Relay closed connection before request completed'));
          }
        },
        onError: (error) => {
          fail(error instanceof Error ? error : new Error(String(error)));
        },
      });
    });
  }

  private cleanupSocket(socket: TSocket): void {
    if (this.options.socketAdapter.clearHandlers) {
      this.options.socketAdapter.clearHandlers(socket);
    }

    try {
      this.options.socketAdapter.close(socket);
    } catch {
      // ignore close failures
    }
  }
}
