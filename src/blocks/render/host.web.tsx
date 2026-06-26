import { createContext, useContext, type ReactNode, type ReactElement } from 'react';

/**
 * Interactivity seam. Block renderers stay pure data→DOM; anything that acts on
 * the world goes through a host the surface injects. Read-only surfaces (the
 * Worker share-viewer, the gallery) get a no-op host, so interactive blocks are
 * automatically inert there.
 *
 * Two shapes:
 *  - resolve(blockId, response): answer a pending agent request (permission,
 *    host-ui dialog, review gate). The agent was awaiting it and advances.
 *  - dispatch(action): fire-and-forget intents (open an artifact, toggle a todo,
 *    send a follow-up to the agent).
 *
 * The agent/artifact remains the source of truth; blocks are stateless
 * projections, so "resolved/checked" state arrives via a re-emitted block.
 */
export type BlockAction =
  | { kind: 'open'; target: string }
  | { kind: 'send-to-agent'; text: string; ref?: string }
  | { kind: 'toggle'; blockId: string; index: number }
  | { kind: 'run'; actionId: string; payload?: unknown };

export interface BlockHost {
  resolve(blockId: string, response: unknown): void;
  dispatch(action: BlockAction): void;
  /** When true, renderers should present interactive controls as disabled. */
  readOnly: boolean;
}

const NOOP_HOST: BlockHost = {
  resolve: () => {},
  dispatch: () => {},
  readOnly: true,
};

const BlockHostContext = createContext<BlockHost>(NOOP_HOST);

export function BlockHostProvider({ host, children }: { host: BlockHost; children: ReactNode }): ReactElement {
  return <BlockHostContext.Provider value={host}>{children}</BlockHostContext.Provider>;
}

export function useBlockHost(): BlockHost {
  return useContext(BlockHostContext);
}
