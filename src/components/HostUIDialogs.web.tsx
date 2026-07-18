/** @jsxImportSource react */
/**
 * HostUIDialogs — renders Pi SDK extension dialog requests as native web modals.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  HostUIDialogRequest,
  HostUIDialogResponse,
} from '../lib/tmux-lite/agents/host-ui-bridge.js';

export interface HostUIDialogOverlayProps {
  request: HostUIDialogRequest | null;
  onResponse: (response: HostUIDialogResponse) => void;
}

const BTN_CANCEL = 'gs-button-secondary';
const BTN_PRIMARY = 'gs-button-primary';
const FIELD = 'gs-field';

/**
 * A dialog request can reach the overlay from a live broadcast, an attach
 * catch-up re-emit, or a session that is not the foreground/attached one. Render
 * defensively: a request whose per-type payload is missing/misshapen must never
 * throw during render (which would take down the whole pane / React tree). An
 * unrenderable request is dropped (logged) instead.
 */
function isRenderableDialogRequest(request: HostUIDialogRequest): boolean {
  if (!request || typeof request !== 'object' || typeof (request as { id?: unknown }).id !== 'string') return false;
  switch (request.type) {
    case 'select':
      return Array.isArray(request.options);
    case 'ask-form':
      return Array.isArray(request.questions) && request.questions.every((q) => q && Array.isArray(q.options));
    case 'confirm':
      return typeof request.message === 'string';
    case 'input':
    case 'editor':
      return true;
    default:
      return false;
  }
}

export function HostUIDialogOverlay({ request, onResponse }: HostUIDialogOverlayProps) {
  if (!request) return null;
  if (!isRenderableDialogRequest(request)) {
    console.error('[HostUIDialogs] dropping unrenderable dialog request', request);
    return null;
  }

  const dismiss = () => {
    switch (request.type) {
      case 'select':
        onResponse({ type: 'select', id: request.id, value: undefined });
        return;
      case 'ask-form':
        onResponse({ type: 'ask-form', id: request.id, value: undefined });
        return;
      case 'confirm':
        onResponse({ type: 'confirm', id: request.id, value: false });
        return;
      case 'input':
        onResponse({ type: 'input', id: request.id, value: undefined });
        return;
      case 'editor':
        onResponse({ type: 'editor', id: request.id, value: undefined });
        return;
    }
  };

  const content = (() => {
    switch (request.type) {
      case 'select':
        return <SelectDialog key={request.id} request={request} onResponse={onResponse} />;
      case 'ask-form':
        return <AskFormDialog key={request.id} request={request} onResponse={onResponse} />;
      case 'confirm':
        return <ConfirmDialog key={request.id} request={request} onResponse={onResponse} />;
      case 'input':
        return <InputDialog key={request.id} request={request} onResponse={onResponse} />;
      case 'editor':
        return <EditorDialog key={request.id} request={request} onResponse={onResponse} />;
    }
  })();

  return createPortal(
    <div className="gs-overlay-root" onClick={dismiss}>
      <div className="absolute inset-0 gs-overlay-backdrop" />
      <div className="relative" onClick={(e) => e.stopPropagation()}>{content}</div>
    </div>,
    document.body,
  );
}

interface DialogShellProps {
  title: string;
  onBackdropClick: () => void;
  children: ReactNode;
  width?: 'md' | 'lg';
  kicker?: string;
}

function DialogShell({ title, onBackdropClick, children, width = 'md', kicker = 'Agent UI' }: DialogShellProps) {
  const widthClass = width === 'lg' ? 'gs-shell-card--wide' : 'gs-shell-card--compact';
  return (
    <div className={`gs-shell-card ${widthClass}`}>
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onBackdropClick}
        className="absolute right-3 top-3 z-10 text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]"
      >
        ×
      </button>
      <div className="gs-shell-header">
        <div className="gs-shell-title-stack">
          <div className="gs-shell-kicker">{kicker}</div>
          <h2 className="gs-shell-title">{title}</h2>
        </div>
      </div>
      <div className="gs-shell-body">{children}</div>
    </div>
  );
}

interface SelectDialogProps {
  request: Extract<HostUIDialogRequest, { type: 'select' }>;
  onResponse: (r: HostUIDialogResponse) => void;
}

function SelectDialog({ request, onResponse }: SelectDialogProps) {
  const cancel = () => onResponse({ type: 'select', id: request.id, value: undefined });
  const pick = (value: string) => onResponse({ type: 'select', id: request.id, value });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <DialogShell title={request.title} onBackdropClick={cancel} width="lg" kicker="Agent choice">
      <div className="gs-panel-block">
        {request.options.length === 0 ? (
          <div className="gs-empty-panel">No options available.</div>
        ) : (
          <div className="gs-select-list max-h-72 overflow-y-auto">
            {request.options.map((option, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => pick(option)}
                className="gs-select-item"
              >
                {option}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <button type="button" onClick={cancel} className={BTN_CANCEL}>Cancel</button>
        </div>
      </div>
    </DialogShell>
  );
}

interface AskFormDialogProps {
  request: Extract<HostUIDialogRequest, { type: 'ask-form' }>;
  onResponse: (r: HostUIDialogResponse) => void;
}

interface AskFormAnswerState {
  /** Selected option labels (one for radio, many for checkbox). */
  selected: string[];
  /** Free-text "Other" answer. */
  custom: string;
}

/**
 * AskFormDialog — one native form presenting every question from a single `ask`
 * tool call. Single-choice questions render radios; multi-choice render
 * checkboxes; every question also offers a free-text "Other" field (matching the
 * SDK, which always appends an "Other" option). One submit returns all answers.
 */
function AskFormDialog({ request, onResponse }: AskFormDialogProps) {
  const [answers, setAnswers] = useState<Record<string, AskFormAnswerState>>(() => {
    const initial: Record<string, AskFormAnswerState> = {};
    for (const q of request.questions) {
      const preselect =
        typeof q.recommended === 'number' && q.recommended >= 0 && q.recommended < q.options.length
          ? [q.options[q.recommended]!.label]
          : [];
      initial[q.id] = { selected: preselect, custom: '' };
    }
    return initial;
  });

  const cancel = () => onResponse({ type: 'ask-form', id: request.id, value: undefined });
  const submit = () =>
    onResponse({
      type: 'ask-form',
      id: request.id,
      value: request.questions.map((q) => {
        const state = answers[q.id] ?? { selected: [], custom: '' };
        const custom = state.custom.trim();
        return {
          id: q.id,
          selectedOptions: state.selected,
          ...(custom ? { customInput: custom } : {}),
        };
      }),
    });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const toggleOption = (questionId: string, label: string, multiple: boolean) => {
    setAnswers((prev) => {
      const state = prev[questionId] ?? { selected: [], custom: '' };
      let selected: string[];
      if (multiple) {
        selected = state.selected.includes(label)
          ? state.selected.filter((l) => l !== label)
          : [...state.selected, label];
      } else {
        selected = state.selected[0] === label ? [] : [label];
      }
      return { ...prev, [questionId]: { ...state, selected } };
    });
  };

  const setCustom = (questionId: string, custom: string) => {
    setAnswers((prev) => {
      const state = prev[questionId] ?? { selected: [], custom: '' };
      return { ...prev, [questionId]: { ...state, custom } };
    });
  };

  return (
    <DialogShell title={request.title} onBackdropClick={cancel} width="lg" kicker="Agent questions">
      <div className="gs-panel-block max-h-[70vh] overflow-y-auto">
        {request.questions.map((q) => {
          const state = answers[q.id] ?? { selected: [], custom: '' };
          return (
            <div key={q.id} className="flex flex-col gap-2 border-b border-[var(--gs-border-muted)] pb-3 last:border-b-0">
              <div className="font-medium text-[var(--gs-text)] whitespace-pre-wrap">{q.question}</div>
              <div className="flex flex-col gap-1">
                {q.options.map((option, idx) => {
                  const checked = state.selected.includes(option.label);
                  return (
                    <label
                      key={idx}
                      className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-[var(--gs-bg-elevated)]"
                    >
                      <input
                        type={q.multiple ? 'checkbox' : 'radio'}
                        name={`askform-${request.id}-${q.id}`}
                        checked={checked}
                        onChange={() => toggleOption(q.id, option.label, q.multiple)}
                        className="mt-1"
                      />
                      <span className="flex flex-col">
                        <span className="text-[var(--gs-text)]">{option.label}</span>
                        {option.description ? (
                          <span className="text-xs text-[var(--gs-text-dim)]">{option.description}</span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
              <input
                type="text"
                value={state.custom}
                onChange={(e) => setCustom(q.id, e.target.value)}
                placeholder="Other (type your own)"
                className={FIELD}
              />
            </div>
          );
        })}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={cancel} className={BTN_CANCEL}>Cancel</button>
          <button type="button" onClick={submit} className={BTN_PRIMARY}>Submit</button>
        </div>
      </div>
    </DialogShell>
  );
}

interface ConfirmDialogProps {
  request: Extract<HostUIDialogRequest, { type: 'confirm' }>;
  onResponse: (r: HostUIDialogResponse) => void;
}

function ConfirmDialog({ request, onResponse }: ConfirmDialogProps) {
  const respond = (value: boolean) => onResponse({ type: 'confirm', id: request.id, value });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        respond(false);
      } else if (e.key === 'Enter' || e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        respond(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <DialogShell title={request.title} onBackdropClick={() => respond(false)} kicker="Agent confirmation">
      <div className="gs-panel-block">
        <p className="text-[var(--gs-text)] whitespace-pre-wrap">{request.message}</p>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={() => respond(false)} className={BTN_CANCEL}>No</button>
          <button type="button" onClick={() => respond(true)} className={BTN_PRIMARY}>Yes</button>
        </div>
      </div>
    </DialogShell>
  );
}

interface InputDialogProps {
  request: Extract<HostUIDialogRequest, { type: 'input' }>;
  onResponse: (r: HostUIDialogResponse) => void;
}

function InputDialog({ request, onResponse }: InputDialogProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const cancel = () => onResponse({ type: 'input', id: request.id, value: undefined });
  const submit = () => onResponse({ type: 'input', id: request.id, value });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter') {
        const target = e.target as HTMLElement | null;
        if (target instanceof HTMLInputElement) {
          e.preventDefault();
          submit();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [value]);

  return (
    <DialogShell title={request.title} onBackdropClick={cancel} kicker="Agent input">
      <div className="gs-panel-block">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={request.placeholder}
          className={FIELD}
          autoFocus
        />
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={cancel} className={BTN_CANCEL}>Cancel</button>
          <button type="button" onClick={submit} className={BTN_PRIMARY}>Submit</button>
        </div>
      </div>
    </DialogShell>
  );
}

interface EditorDialogProps {
  request: Extract<HostUIDialogRequest, { type: 'editor' }>;
  onResponse: (r: HostUIDialogResponse) => void;
}

function EditorDialog({ request, onResponse }: EditorDialogProps) {
  const [value, setValue] = useState(request.prefill ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const cancel = () => onResponse({ type: 'editor', id: request.id, value: undefined });
  const submit = () => onResponse({ type: 'editor', id: request.id, value });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [value]);

  return (
    <DialogShell title={request.title} onBackdropClick={cancel} width="lg" kicker="Agent editor">
      <div className="gs-panel-block">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={8}
          className={`${FIELD} min-h-[220px] resize-y font-mono`}
          autoFocus
        />
        <div className="gs-shell-meta-row">
          <span>Ctrl/Cmd + Enter submits</span>
        </div>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={cancel} className={BTN_CANCEL}>Cancel</button>
          <button type="button" onClick={submit} className={BTN_PRIMARY}>Submit</button>
        </div>
      </div>
    </DialogShell>
  );
}
