// A person's choices for the agent wait in the composer as chips (decisions, answers, review batches, messages,
// comments) and go with their next message. ComposerStagingProvider is mounted once per open workspace, around the
// conversation and the Inspector, so a block in either stages into the same composer. Sending puts the message's text
// first, then one line per chip ("Decided: …", "Answered: …", "Review batch: …"), and hands the staged decisions to the
// send, which carries them to the workspace: it journals each as a `decision` entry citing the message once the message
// is in the conversation. Comments and answers to the workspace's questions are staged in the workspace (its staged
// comments and answers, comments/CommentLayer.tsx and `stageAnswer`), not here: their chips show what the workspace
// staged, and the send carries them for the workspace to add to the message; it answers the questions as it takes it.
import { Button } from '@gitspace/ui';
import { answerShown, answersMessage, commentExcerpt, commentsMessage, type SentAnswer, type SentComment, type StagedAnswer } from '@gitspace/protocol-runtime/comments';
import { RuntimeMessageDecisionSchema, type RuntimeMessageDecision } from '@gitspace/protocol-runtime/session-controls';
import { Annotation, CheckCircle, GitPullRequest, MessageChatCircle, MessageQuestionCircle, XClose } from '@untitledui/icons';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { BlockActionsProvider, type BlockActions, type BlockState } from '../blocks/BlockActions.js';
import { CommentLayer } from '../comments/context.js';
import { QuestionCardsContext } from '../QuestionCards.js';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface StagedChip {
  /** One chip per key: staging the same key again replaces the chip in place. */
  key: string;
  /** comment: a staged comment of the workspace; its key is the comment's id. question: the workspace's staged answer
   * to one of its questions; its key is the question's id. */
  kind: 'decision' | 'answer' | 'review' | 'message' | 'comment' | 'question';
  label: string;
  detail?: string;
  /** Sent with the chip's line as JSON when not null. */
  payload: JsonValue;
}

/** The block a chip came from, and the key its `/staged/<key>` and `/sent/<key>` state use. */
export interface StagedBlock {
  state: BlockState;
  key: string;
  /** The chip answers the agent's question: once sent, the block's /answered is set too. */
  answers?: boolean;
}

/** A staged answer as a send carries it: the answer, and its question's prompt for the message's line. */
export interface ShownAnswer { prompt: string; sent: SentAnswer }

export interface ComposerStaging {
  chips: readonly StagedChip[];
  stage(chip: StagedChip, block?: StagedBlock): void;
  /** Removes the chip; its block shows it as no longer staged. A comment's chip takes the comment back, an answer's
   * chip the answer, and its question's card opens again. */
  unstage(key: string): void;
  /** The workspace's staged answers to its open questions. */
  answers: readonly StagedAnswer[];
  /** Stages an answer to the workspace's open question `questionId` for the next message, replacing one staged before. */
  stageAnswer(questionId: string, answer: SentAnswer['answer']): Promise<void>;
  /** The message a send of `text` delivers: the text, the chips' lines, the staged answers' lines and data, then the
   * staged comments' lines and data. */
  message(text: string): string;
  /** Sends `text` with the staged chips as one message through `send`, with the staged decisions, comments and
   * answers; once it went, the chips leave the composer and their blocks show them sent. A failed send keeps the chips. */
  deliver(text: string, send: (message: string, decisions: RuntimeMessageDecision[], comments: readonly SentComment[], answers: readonly ShownAnswer[]) => Promise<void>): Promise<void>;
}

const SENT: Record<StagedChip['kind'], string> = { decision: 'Decided', answer: 'Answered', review: 'Review batch', message: 'Message', comment: 'Comment', question: 'Answer' };
const CHIP: Record<StagedChip['kind'], { label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = {
  decision: { label: 'Decision', icon: CheckCircle },
  answer: { label: 'Answer', icon: MessageQuestionCircle },
  review: { label: 'Review batch', icon: GitPullRequest },
  message: { label: 'Message', icon: MessageChatCircle },
  comment: { label: 'Comment', icon: Annotation },
  question: { label: 'Answer', icon: MessageQuestionCircle },
};
const NO_ANSWERS: readonly StagedAnswer[] = [];
const ID = /^[A-Za-z0-9._:-]{1,128}$/u;

function chipHead(chip: StagedChip): string {
  return `${SENT[chip.kind]}: ${chip.label}${chip.detail ? ` (${chip.detail})` : ''}`;
}

/** The message a send delivers: the person's text, then each chip's line, with its payload as JSON when it has one.
 * Comment chips have no line here: the workspace adds the comments. */
export function stagedMessage(text: string, chips: readonly StagedChip[]): string {
  const lines = chips.flatMap((chip) => chip.kind === 'comment' ? [] : [chip.payload === null ? chipHead(chip) : `${chipHead(chip)}\n~~~json\n${JSON.stringify(chip.payload, null, 2)}\n~~~`]);
  return [text.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

/** A staged decision as the send carries it: what was decided (the chip's detail, else its label), the choice, and the
 * guide section its payload names. */
function messageDecision(chip: StagedChip): RuntimeMessageDecision {
  const payload = chip.payload;
  const sectionId = typeof payload === 'object' && payload !== null && !Array.isArray(payload) && 'sectionId' in payload && typeof payload.sectionId === 'string' && ID.test(payload.sectionId) ? payload.sectionId : undefined;
  const detail = chip.detail?.trim().slice(0, 512);
  return RuntimeMessageDecisionSchema.parse({
    title: (detail || chip.label).slice(0, 512),
    ...(detail ? { choice: chip.label.slice(0, 512) } : {}),
    ...(sectionId ? { sectionId } : {}),
    ...(payload === null ? {} : { payload }),
  });
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') return Object.values(value).every(isJsonValue);
  return false;
}

interface Staged { chip: StagedChip; block?: StagedBlock }

const ComposerStagingContext = createContext<ComposerStaging | null>(null);

/** `answers`: the workspace's staged answers (the snapshot's `gitspace.comments`). */
export function ComposerStagingProvider({ children, answers = NO_ANSWERS }: { children: ReactNode; answers?: readonly StagedAnswer[] }) {
  const [staged, setStaged] = useState<readonly Staged[]>([]);
  const current = useRef(staged);
  current.current = staged;
  // The workspace's staged comments, as the send names them.
  const layer = useContext(CommentLayer);
  const comments = useMemo(() => (layer?.notes ?? []).flatMap((note): SentComment[] => note.state === 'staged' && note.note !== null ? [{ id: note.id, anchor: note.anchor, note: note.note }] : []), [layer?.notes]);
  const latestComments = useRef(comments);
  latestComments.current = comments;
  const remove = layer?.remove;
  // The workspace's staged answers to the questions it has, as the send carries them.
  const cards = useContext(QuestionCardsContext);
  const request = cards?.request;
  const shown = useMemo(() => answers.flatMap((answer): ShownAnswer[] => {
    const question = cards?.questions.find((item) => item.id === answer.questionId);
    return question ? [{ prompt: question.prompt, sent: { questionId: answer.questionId, answer: answer.answer } }] : [];
  }), [answers, cards?.questions]);
  const latestAnswers = useRef(shown);
  latestAnswers.current = shown;

  const stage = useCallback((chip: StagedChip, block?: StagedBlock) => {
    const previous = current.current.find((item) => item.chip.key === chip.key);
    if (previous?.block && previous.block.state !== block?.state) previous.block.state.setStaged(previous.block.key, null);
    block?.state.setStaged(block.key, chip.label);
    block?.state.setSent(block.key, null);
    const next = { chip, block };
    current.current = previous ? current.current.map((item) => item === previous ? next : item) : [...current.current, next];
    setStaged(current.current);
  }, []);

  const stageAnswer = useCallback(async (questionId: string, answer: SentAnswer['answer']) => {
    if (!request) throw new Error('Answering is not available here.');
    await request({ type: 'stageAnswer', questionId, answer });
  }, [request]);

  const unstage = useCallback((key: string) => {
    if (remove && latestComments.current.some((comment) => comment.id === key)) { void remove(key); return; }
    if (request && latestAnswers.current.some((answer) => answer.sent.questionId === key)) { void request({ type: 'unstageAnswer', questionId: key }); return; }
    const item = current.current.find((candidate) => candidate.chip.key === key);
    if (!item) return;
    item.block?.state.setStaged(item.block.key, null);
    current.current = current.current.filter((candidate) => candidate !== item);
    setStaged(current.current);
  }, [remove, request]);

  const message = useCallback((text: string) => commentsMessage(answersMessage(stagedMessage(text, current.current.map((item) => item.chip)), latestAnswers.current), latestComments.current), []);

  const deliver = useCallback(async (text: string, send: (message: string, decisions: RuntimeMessageDecision[], comments: readonly SentComment[], answers: readonly ShownAnswer[]) => Promise<void>) => {
    const going = current.current;
    const decisions = going.flatMap((item) => item.chip.kind === 'decision' ? [messageDecision(item.chip)] : []);
    await send(stagedMessage(text, going.map((item) => item.chip)), decisions, latestComments.current, latestAnswers.current);
    for (const { chip, block } of going) {
      block?.state.setStaged(block.key, null);
      block?.state.setSent(block.key, chip.label);
      if (block?.answers) block.state.setAnswered(chip.label);
    }
    current.current = current.current.filter((item) => !going.includes(item));
    setStaged(current.current);
  }, []);

  const chips = useMemo(() => [
    ...staged.map((item) => item.chip),
    ...shown.map(({ prompt, sent }): StagedChip => ({ key: sent.questionId, kind: 'question', label: commentExcerpt(answerShown(sent.answer), 60), detail: `to “${commentExcerpt(prompt, 40)}”`, payload: null })),
    ...comments.map((comment): StagedChip => ({ key: comment.id, kind: 'comment', label: commentExcerpt(comment.note, 60), detail: `on “${commentExcerpt(comment.anchor.quote, 40)}”`, payload: null })),
  ], [staged, shown, comments]);
  const value = useMemo<ComposerStaging>(() => ({ chips, stage, unstage, answers, stageAnswer, message, deliver }), [chips, stage, unstage, answers, stageAnswer, message, deliver]);
  return <ComposerStagingContext.Provider value={value}>{children}</ComposerStagingContext.Provider>;
}

/** The open workspace's staging; null where no workspace composer is (a shared guide page). */
export function useComposerStaging(): ComposerStaging | null {
  return useContext(ComposerStagingContext);
}

/** The chips above the composer's input, each removable. */
export function StagedChips({ staging, disabled }: { staging: ComposerStaging; disabled?: boolean }) {
  if (!staging.chips.length) return null;
  return <ul aria-label="Staged in your message" className="flex flex-wrap gap-1.5">{staging.chips.map((chip) => {
    const { label, icon: Icon } = CHIP[chip.kind];
    return <li key={chip.key} aria-label={`${label} ${chip.label}`} className="flex min-w-0 max-w-full items-center gap-1">
      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2 py-1 text-caption">
        <Icon className="shrink-0" width={13} height={13} aria-hidden />
        <strong className="shrink-0 font-medium">{label}</strong>
        <span className="min-w-0 truncate">· {chip.label}</span>
        {chip.detail ? <span className="min-w-0 truncate text-muted-foreground">· {chip.detail}</span> : null}
      </span>
      <Button variant="ghost" size="icon-compact" aria-label={`Remove ${label.toLowerCase()} ${chip.label}`} disabled={disabled} onClick={() => staging.unstage(chip.key)}><XClose width={14} height={14} /></Button>
    </li>;
  })}</ul>;
}

/** What a workspace surface (the chat, the Goal, the Change Guide) does with its blocks' actions. */
export interface WorkspaceBlockActionDeps {
  staging: ComposerStaging | null;
  /** Accepts or reopens a goal requirement at once (`inspector.requirement.setAcceptance`). */
  setAcceptance?: (requirementId: string, accepted: boolean) => Promise<void>;
  openGuideSection?: (sectionId: string) => void;
}

/** Opens the Inspector's Change Guide at a section; null where there is no Inspector. */
export const GuideSectionNavigation = createContext<((sectionId: string) => void) | null>(null);
/** Accepts or reopens a goal requirement of the open workspace; null where a person cannot. */
export const RequirementAcceptance = createContext<((requirementId: string, accepted: boolean) => Promise<void>) | null>(null);

/** Blocks in the agent's chat messages act on the open workspace. */
export function AgentMessageActions({ children }: { children: ReactNode }) {
  const staging = useComposerStaging();
  const openGuideSection = useContext(GuideSectionNavigation);
  const setAcceptance = useContext(RequirementAcceptance);
  const actions = useMemo(() => workspaceBlockActions({ staging, ...(setAcceptance ? { setAcceptance } : {}), ...(openGuideSection ? { openGuideSection } : {}) }), [staging, setAcceptance, openGuideSection]);
  return <BlockActionsProvider actions={actions}>{children}</BlockActionsProvider>;
}

const blockIds = new WeakMap<BlockState, number>();
let blockCount = 0;

/** A block's chip keys are its own: the same key from two blocks makes two chips. */
function chipKey(block: BlockState, key: string): string {
  let id = blockIds.get(block);
  if (id === undefined) {
    blockCount += 1;
    id = blockCount;
    blockIds.set(block, id);
  }
  return `block-${id}:${key}`;
}

/** Choices stage into the composer; sign-offs act at once; links and guide sections open. */
export function workspaceBlockActions({ staging, setAcceptance, openGuideSection }: WorkspaceBlockActionDeps): BlockActions {
  const accept = setAcceptance ? async (id: string, accepted: boolean, block: BlockState, checkedPath?: string | null): Promise<void> => {
    try {
      await setAcceptance(id, accepted);
    } catch (failure) {
      if (checkedPath) block.set(checkedPath, !accepted);
      throw failure;
    }
  } : undefined;
  const put = (block: BlockState, key: string, chip: Omit<StagedChip, 'key'>, answers?: boolean): void => {
    staging?.stage({ ...chip, key: chipKey(block, key) }, { state: block, key, ...(answers ? { answers } : {}) });
  };
  return {
    ...(staging ? {
      stage: async (params, block) => {
        const key = params.key ?? params.kind;
        if (params.kind !== 'requirement') {
          put(block, key, { kind: params.kind, label: params.label, ...(params.detail ? { detail: params.detail } : {}), payload: isJsonValue(params.payload) ? params.payload : null });
          return;
        }
        // Accepting a requirement is a sign-off, not a choice: it is recorded at once.
        const id = typeof params.payload === 'object' && params.payload !== null && 'id' in params.payload && typeof params.payload.id === 'string' ? params.payload.id : null;
        if (!accept || id === null) throw new Error('accepting a requirement needs accept_requirement with the requirement id');
        await accept(id, true, block);
        block.setSent(key, params.label);
      },
      record_decision: (params, block) => put(block, `decision:${params.question}`, { kind: 'decision', label: params.choice, detail: params.question, payload: params.rationale ? { rationale: params.rationale } : null }),
      send_to_agent: (params, block) => put(block, 'message', { kind: 'message', label: params.message, payload: isJsonValue(params.data) ? params.data : null }),
      answer_question: (params, block) => put(block, params.questionId, { kind: 'answer', label: params.label, detail: params.question, payload: { questionId: params.questionId, answer: params.answer } }, true),
    } : {}),
    ...(accept ? { accept_requirement: (params, block) => accept(params.id, params.accepted, block, params.checkedPath) } : {}),
    ...(openGuideSection ? { open_guide_section: (params) => openGuideSection(params.section) } : {}),
    open_url: (params) => {
      const url = URL.canParse(params.url) ? new URL(params.url) : null;
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error(`${params.url} is not a web link`);
      window.open(url.href, '_blank', 'noopener,noreferrer');
    },
  };
}
