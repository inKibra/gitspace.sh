import type { SessionBackend, BackendKey } from './backend.js';
import type { BackendEvent } from './events.js';
import { SpacesError } from '../types/errors.js';

export interface BackendManagerEvent {
  backendKey: BackendKey;
  event: BackendEvent;
}

/**
 * Registry/lifecycle helper for multiple concurrent backends.
 */
export class BackendManager {
  private readonly backends = new Map<BackendKey, SessionBackend>();
  private readonly unsubs = new Map<BackendKey, () => void>();
  private readonly onEvent: (event: BackendManagerEvent) => void;

  constructor(onEvent: (event: BackendManagerEvent) => void) {
    this.onEvent = onEvent;
  }

  register(backend: SessionBackend): void {
    const key = backend.descriptor.key;
    if (this.backends.has(key)) {
      return;
    }

    this.backends.set(key, backend);
    const unsub = backend.onEvent((event) => {
      this.onEvent({ backendKey: key, event });
    });
    this.unsubs.set(key, unsub);
  }

  async unregister(backendKey: BackendKey): Promise<void> {
    const backend = this.backends.get(backendKey);
    if (!backend) {
      return;
    }

    const unsub = this.unsubs.get(backendKey);
    if (unsub) {
      unsub();
      this.unsubs.delete(backendKey);
    }

    await backend.disconnect();
    this.backends.delete(backendKey);
  }

  async connect(backendKey: BackendKey): Promise<void> {
    const backend = this.backends.get(backendKey);
    if (!backend) {
      throw new SpacesError(`Backend not found: ${backendKey}`, 'SYSTEM_ERROR', 2);
    }

    await backend.connect();
  }

  async disconnect(backendKey: BackendKey): Promise<void> {
    const backend = this.backends.get(backendKey);
    if (!backend) {
      return;
    }
    await backend.disconnect();
  }

  get(backendKey: BackendKey): SessionBackend | null {
    return this.backends.get(backendKey) || null;
  }

  keys(): BackendKey[] {
    return [...this.backends.keys()];
  }

  async disconnectAll(): Promise<void> {
    const keys = this.keys();
    await Promise.all(keys.map((key) => this.disconnect(key)));
  }
}
