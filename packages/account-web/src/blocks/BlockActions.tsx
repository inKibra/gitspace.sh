// What a gitspace-ui block's actions may ask of the surface that shows it. A surface (the chat, the Inspector) wraps
// its Markdown in BlockActionsProvider with the handlers it implements. A handler receives the action's params, parsed
// with the catalog's zod params, and the block's GitSpace-owned state (BlockState). An action with no handler here
// leaves "… is not available here" under the block.
import type { gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import { createContext, useContext, type ReactNode } from 'react';
import type { z } from 'zod';

type CatalogActions = typeof gitspaceUiCatalog.actions;
export type BlockActionName = keyof CatalogActions;
export type BlockActionParams<K extends BlockActionName> = z.output<CatalogActions[K]['params']>;

/**
 * The state of the block an action came from, for the handler to write the roots GitSpace owns. A spec reads them
 * with $state (`/staged/<key>`, `/sent/<key>`, `/answered`) to show progress; the agent never writes them. The object
 * stays valid while the block is shown, so a handler may keep it to write later (a chip sent with the next message).
 */
export interface BlockState {
  /** Sets /staged/<key> to the label of a choice waiting in the composer; null once it leaves the composer. */
  setStaged: (key: string, label: string | null) => void;
  /** Sets /sent/<key> to the label of a staged choice once it went with a message. */
  setSent: (key: string, label: string | null) => void;
  /** Sets /answered to the label of the answer given to the agent's question. */
  setAnswered: (label: string | null) => void;
  /** Appends a line to /gitspaceNotices; GitSpace shows it under the block (e.g. why an action failed). */
  notify: (text: string) => void;
  /** Writes any path of the block's state, e.g. unticks an accept_requirement row (its `checkedPath`) when the accept fails. */
  set: (path: string, value: unknown) => void;
}

export type BlockActionHandler<K extends BlockActionName> = (params: BlockActionParams<K>, block: BlockState) => void | Promise<void>;

/** One optional handler per catalog action. A thrown error is shown under the block. */
export interface BlockActions {
  /** A choice for the agent (decision, answer, review batch): put a chip in the composer, replacing this block's chip with the same `key ?? kind`; set /staged/<key> while it waits and /sent/<key> once it goes. */
  stage?: BlockActionHandler<'stage'>;
  /** Record the person's decision in the workspace journal. */
  record_decision?: BlockActionHandler<'record_decision'>;
  /** Send the agent a message, with optional structured data. */
  send_to_agent?: BlockActionHandler<'send_to_agent'>;
  /** Open the Change Guide at a section. */
  open_guide_section?: BlockActionHandler<'open_guide_section'>;
  /** A sign-off: accept or reopen a goal requirement at once. */
  accept_requirement?: BlockActionHandler<'accept_requirement'>;
  /** The person picked an answer to the agent's question: a choice, staged like `stage` under `questionId`. */
  answer_question?: BlockActionHandler<'answer_question'>;
  /** Open a link in a new tab. */
  open_url?: BlockActionHandler<'open_url'>;
}

const BlockActionsContext = createContext<BlockActions | null>(null);

export function BlockActionsProvider({ actions, children }: { actions: BlockActions; children: ReactNode }) {
  return <BlockActionsContext.Provider value={actions}>{children}</BlockActionsContext.Provider>;
}

/** The surface's handlers, or null where blocks are shown without actions. */
export function useBlockActions(): BlockActions | null {
  return useContext(BlockActionsContext);
}
