import type { RuntimeBrowserArguments, RuntimeBrowserAuthorization, RuntimeBrowserSignedGrant } from '@gitspace/protocol-runtime';

/** Privileged in-process transport; never expose this interface as a public CDP socket. */
export interface RuntimeBrowserRelay {
  status(): Promise<{ connected: boolean }>;
  authorize(authorization: RuntimeBrowserAuthorization, signal: AbortSignal): Promise<void>;
  tabs(groupId: string, signal: AbortSignal): Promise<Array<{ targetId: string; title: string; url: string }>>;
  prepare(args: RuntimeBrowserArguments, groupId: string, signal: AbortSignal): Promise<void>;
  open(grant: RuntimeBrowserSignedGrant, args: RuntimeBrowserArguments, signal: AbortSignal): Promise<RuntimeBrowserRelayChannel & { targetId: string }>;
  revoke(groupId: string): Promise<void>;
}
export interface RuntimeBrowserRelayChannel {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  subscribe(listener: (message: unknown) => void): () => void;
  close(): Promise<void>;
}
