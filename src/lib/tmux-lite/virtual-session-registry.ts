/**
 * Shared registry for VirtualTerminal instances created by the tmux-lite server.
 *
 * VirtualTerminal objects can't be serialized over IPC, but the coordinator
 * and server run in the same process. This registry provides the bridge:
 * the server stores VirtualTerminals here when creating virtual sessions,
 * and the coordinator retrieves them to wire up InteractiveMode.
 */

import type { VirtualTerminal } from './agents/virtual-terminal.js';

const registry = new Map<string, VirtualTerminal>();

export function registerVirtualTerminal(sessionId: string, terminal: VirtualTerminal): void {
  registry.set(sessionId, terminal);
}

export function getVirtualTerminal(sessionId: string): VirtualTerminal | undefined {
  return registry.get(sessionId);
}

export function removeVirtualTerminal(sessionId: string): boolean {
  return registry.delete(sessionId);
}
