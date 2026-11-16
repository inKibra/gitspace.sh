// The document a block is drawn in (one chat message, one Change Guide, one goal) and what its blocks share through it:
// the elements its ids name, drawn again by a BlockRef or a Sequence frame { ref }, and the stored message whose
// required asks are workspace questions. A block drawn outside a document finds no ids and no message.
import { SEQUENCE_FRAME_CONTENT_PATH, extractBlocks, validateUiSpec, type UiBlockIssue } from '@gitspace/protocol/gitspace-ui';
import { useShape } from '@gitspace/ui';
import type { Spec } from '@json-render/core';
import type { ComponentRegistry } from '@json-render/react';
import { Link03 } from '@untitledui/icons';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { BlockCorrection } from '@gitspace/blocks';
import { BlockCorrections } from './BlockCorrections.js';

/** The validator checked the shape `Renderer` reads: { root, elements, state? } with catalog components only. */
export function conforms(spec: unknown, issues: readonly UiBlockIssue[]): spec is Spec {
  return issues.length === 0;
}

/** The issues that stop a spec from drawing: a Sequence frame that fails draws its own error card in its place. */
export function blockingIssues(issues: readonly UiBlockIssue[]): UiBlockIssue[] {
  return issues.filter((issue) => !SEQUENCE_FRAME_CONTENT_PATH.test(issue.path));
}

/** An element an id names: the spec it is in and its key there. */
export interface BlockTarget { spec: Spec; key: string }

export interface BlockDocumentValue {
  /** Element id → the element it names, across the document. */
  targets: ReadonlyMap<string, BlockTarget>;
  /** The stored chat message the blocks are in (its transcript item id); null elsewhere and while it streams. */
  messageId: string | null;
}

export const BlockDocument = createContext<BlockDocumentValue>({ targets: new Map(), messageId: null });

/** The ids of the gitspace-ui fences in `markdown`, read as one document. A fence that does not draw names nothing. */
export function blockDocument(markdown: string): ReadonlyMap<string, BlockTarget> {
  const targets = new Map<string, BlockTarget>();
  for (const block of extractBlocks(markdown)) {
    if (block.kind !== 'gitspace-ui' || !block.closed) continue;
    let spec: unknown;
    try {
      spec = JSON.parse(block.body);
    } catch {
      continue;
    }
    if (!conforms(spec, blockingIssues(validateUiSpec(spec)))) continue;
    for (const [key, element] of Object.entries(spec.elements)) {
      if ('id' in element && typeof element.id === 'string') targets.set(element.id, { spec, key });
    }
  }
  return targets;
}

/** A chat message as the document its blocks are drawn in: a stored message names its required asks' questions, and its
 * blocks the agent corrected after it was sent draw with a "corrected" mark (`CorrectedMark`). */
export function MessageBlockDocument({ messageId, text, pending, corrected, children }: { messageId: string; text: string; pending: boolean; corrected?: readonly BlockCorrection[]; children: ReactNode }) {
  const value = useMemo((): BlockDocumentValue => ({ targets: blockDocument(text), messageId: pending ? null : messageId }), [text, messageId, pending]);
  const marks = useMemo(() => {
    const blocks = corrected?.length ? extractBlocks(text) : [];
    return new Map((corrected ?? []).flatMap((correction): [string, BlockCorrection][] => {
      const block = blocks[correction.block];
      return block ? [[block.body.trim(), correction]] : [];
    }));
  }, [text, corrected]);
  return <BlockDocument.Provider value={value}><BlockCorrections.Provider value={marks}>{children}</BlockCorrections.Provider></BlockDocument.Provider>;
}

/** What a component inside a drawn block needs to draw more of its document: the block's spec and registry (a Sequence
 * frame's element), and an element of the document by ref (a BlockRef, a frame's { ref }). */
export interface BlockRenderingValue {
  spec: Spec;
  registry: ComponentRegistry;
  drawRef: (ref: string) => ReactNode;
}

export const BlockRendering = createContext<BlockRenderingValue | null>(null);

/** The block element this ref names, drawn again with its own state. */
export function BlockRefView({ id }: { id: string }) {
  return useContext(BlockRendering)?.drawRef(id) ?? null;
}

/** A ref to an element of another document: a card naming it until documents resolve each other. */
export function OtherDocumentRef({ document, id }: { document: string; id: string }) {
  const shape = useShape();
  return <div role="group" aria-label={`Block ${id} in ${document}`} className={`my-1 flex items-center gap-2 border border-border bg-surface-2 px-3 py-2 text-caption ${shape.container}`}>
    <Link03 width={14} height={14} className="shrink-0 text-muted-foreground" />
    <span className="min-w-0 [overflow-wrap:anywhere]">Block <code className="font-mono text-foreground">{id}</code> in <code className="font-mono text-foreground">{document}</code></span>
  </div>;
}

/** Set around the frame a Sequence shows: whether the Sequence is playing, so a clip in the frame plays with it. */
export const SequenceFrame = createContext<{ playing: boolean } | null>(null);

/** True inside a block whose choice answers its open workspace question at once; false where a choice stages in the
 * person's message bar. */
export const BlockAnswersQuestion = createContext(false);
