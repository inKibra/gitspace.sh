export interface PendingAskQuestion {
  id: string;
  question: string;
  header: string | null;
  options: Array<{ label: string; description: string | null; preview: string | null }>;
  multi: boolean;
  recommended: number | null;
}

export interface PendingAsk {
  id: string;
  questions: PendingAskQuestion[];
}

export interface PendingAskAnswer {
  id: string;
  selectedOptions: readonly string[];
  customInput: string | null;
}

interface OmpAskQuestion {
  id: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multi?: boolean;
  recommended?: number;
}

interface OmpDialogOptions { signal?: AbortSignal }
interface OmpAskResult {
  kind: 'submit';
  results: Array<{
    id: string;
    question: string;
    options: string[];
    multi: boolean;
    selectedOptions: string[];
    customInput?: string;
  }>;
}

interface PendingResolver {
  ask: PendingAsk;
  resolve(value: OmpAskResult | undefined): void;
  cleanup(): void;
}

/** Bridges OMP's interactive ask dialog into the canonical session control plane. */
export class OmpAskBridge {
  private pending: PendingResolver | null = null;

  constructor(private readonly onChange: (pending: PendingAsk | null) => void) {}

  current(): PendingAsk | null {
    return this.pending?.ask ?? null;
  }

  context(): Record<string, unknown> {
    return {
      askDialog: (questions: OmpAskQuestion[], options?: OmpDialogOptions) => this.open(questions, options),
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => undefined,
      setStatus: () => undefined,
      setWorkingMessage: () => undefined,
      setWidget: () => undefined,
      setEditorText: () => undefined,
      pasteToEditor: () => undefined,
      getEditorText: () => '',
      setTitle: () => undefined,
      onTerminalInput: () => () => undefined,
    };
  }

  answer(id: string, answers: readonly PendingAskAnswer[]): boolean {
    const pending = this.pending;
    if (!pending || pending.ask.id !== id) return false;
    const byId = new Map(answers.map((answer) => [answer.id, answer]));
    this.settle({
      kind: 'submit',
      results: pending.ask.questions.map((question) => {
        const answer = byId.get(question.id);
        return {
          id: question.id,
          question: question.question,
          options: question.options.map((option) => option.label),
          multi: question.multi,
          selectedOptions: [...(answer?.selectedOptions ?? [])],
          ...(answer?.customInput ? { customInput: answer.customInput } : {}),
        };
      }),
    });
    return true;
  }

  cancel(): void {
    if (this.pending) this.settle(undefined);
  }

  private open(questions: OmpAskQuestion[], options?: OmpDialogOptions): Promise<OmpAskResult | undefined> {
    if (this.pending) throw new Error('Another ask dialog is already pending');
    const ask: PendingAsk = {
      id: crypto.randomUUID(),
      questions: questions.map((question) => ({
        id: question.id,
        question: question.question,
        header: question.header ?? null,
        options: question.options.map((option) => ({
          label: option.label,
          description: option.description ?? null,
          preview: option.preview ?? null,
        })),
        multi: question.multi ?? false,
        recommended: question.recommended ?? null,
      })),
    };
    return new Promise<OmpAskResult | undefined>((resolve) => {
      const abort = (): void => this.settle(undefined);
      options?.signal?.addEventListener('abort', abort, { once: true });
      this.pending = {
        ask,
        resolve,
        cleanup: () => options?.signal?.removeEventListener('abort', abort),
      };
      this.onChange(ask);
      if (options?.signal?.aborted) abort();
    });
  }

  private settle(result: OmpAskResult | undefined): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.cleanup();
    this.onChange(null);
    pending.resolve(result);
  }
}
