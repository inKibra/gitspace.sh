/** @jsxImportSource react */
/**
 * HostUIDialogs — renders Pi SDK extension dialog requests as native web modals.
 *
 * Receives a HostUIDialogRequest from the server-side host UI bridge and renders
 * the appropriate dialog type. Only one dialog is shown at a time; the latest
 * request wins.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  HostUIDialogRequest,
  HostUIDialogResponse,
} from '../lib/tmux-lite/agents/host-ui-bridge.js';

// ============================================================================
// Public overlay component
// ============================================================================

export interface HostUIDialogOverlayProps {
  request: HostUIDialogRequest | null;
  onResponse: (response: HostUIDialogResponse) => void;
}

export function HostUIDialogOverlay({ request, onResponse }: HostUIDialogOverlayProps) {
  if (!request) return null;

  const content = (() => {
    switch (request.type) {
      case 'select':
        return (
          <SelectDialog
            request={request}
            onResponse={onResponse}
          />
        );
      case 'confirm':
        return (
          <ConfirmDialog
            request={request}
            onResponse={onResponse}
          />
        );
      case 'input':
        return (
          <InputDialog
            request={request}
            onResponse={onResponse}
          />
        );
      case 'editor':
        return (
          <EditorDialog
            request={request}
            onResponse={onResponse}
          />
        );
    }
  })();

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 9999, position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}
    >
      {content}
    </div>,
    document.body,
  );
}

// ============================================================================
// Shared backdrop + card shell
// ============================================================================

interface DialogShellProps {
  title: string;
  onBackdropClick: () => void;
  children: React.ReactNode;
  width?: 'md' | 'lg';
}

function DialogShell({ title, onBackdropClick, children, width = 'md' }: DialogShellProps) {
  const maxW = width === 'lg' ? 'sm:max-w-lg' : 'sm:max-w-md';
  return (
    <>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[#0d1117]/80 backdrop-blur-sm"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        onClick={onBackdropClick}
      />
      {/* Card */}
      <div
        className={`relative bg-[#161b22] shadow-xl w-full mx-0 sm:mx-4 p-5 sm:p-6 border-0 sm:border border-[#30363d]
          fixed sm:relative inset-0 sm:inset-auto sm:rounded-lg
          flex flex-col sm:block max-h-screen sm:max-h-[90vh] overflow-y-auto
          ${maxW}`}
        style={{ zIndex: 10000, position: 'relative' }}
      >
        <h2 className="text-xl font-semibold text-[#22c55e] mb-4 flex-shrink-0">{title}</h2>
        <div className="flex-1 min-h-0 text-[#e6edf3]">{children}</div>
      </div>
    </>
  );
}

// ============================================================================
// Button helpers
// ============================================================================

const BTN_CANCEL =
  'px-5 py-3 bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] text-[#e6edf3] border border-[#30363d] rounded-lg min-h-[48px]';
const BTN_PRIMARY =
  'px-5 py-3 bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium rounded-lg min-h-[48px] shadow-glow';

// ============================================================================
// SelectDialog
// ============================================================================

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
    <DialogShell title={request.title} onBackdropClick={cancel} width="lg">
      {/* Scrollable option list */}
      <div className="space-y-2 max-h-64 sm:max-h-80 overflow-y-auto -mx-2 px-2 mb-4">
        {request.options.length === 0 && (
          <div className="p-4 rounded-lg border border-[#30363d] bg-[#0d1117] text-sm text-[#8b949e]">
            No options available.
          </div>
        )}
        {request.options.map((option, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => pick(option)}
            className="w-full text-left p-4 bg-[#161b22] border border-[#30363d] rounded-lg hover:bg-[#21262d] active:bg-[#0d1117] cursor-pointer min-h-[48px] text-[#e6edf3] transition-colors"
          >
            {option}
          </button>
        ))}
      </div>
      <div className="flex justify-end">
        <button type="button" onClick={cancel} className={BTN_CANCEL}>
          Cancel
        </button>
      </div>
    </DialogShell>
  );
}

// ============================================================================
// ConfirmDialog
// ============================================================================

interface ConfirmDialogProps {
  request: Extract<HostUIDialogRequest, { type: 'confirm' }>;
  onResponse: (r: HostUIDialogResponse) => void;
}

function ConfirmDialog({ request, onResponse }: ConfirmDialogProps) {
  const respond = (value: boolean) => onResponse({ type: 'confirm', id: request.id, value });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        respond(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        respond(true);
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        respond(true);
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        respond(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <DialogShell title={request.title} onBackdropClick={() => respond(false)}>
      <p className="mb-6 text-[#e6edf3] whitespace-pre-wrap">{request.message}</p>
      <div className="flex flex-col-reverse sm:flex-row justify-end gap-3">
        <button type="button" onClick={() => respond(false)} className={BTN_CANCEL}>
          No
        </button>
        <button type="button" onClick={() => respond(true)} className={BTN_PRIMARY}>
          Yes
        </button>
      </div>
    </DialogShell>
  );
}

// ============================================================================
// InputDialog
// ============================================================================

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
        // Enter submits only from the input itself, not from other elements
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
    <DialogShell title={request.title} onBackdropClick={cancel}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={request.placeholder}
        className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all mb-6"
        autoFocus
      />
      <div className="flex flex-col-reverse sm:flex-row justify-end gap-3">
        <button type="button" onClick={cancel} className={BTN_CANCEL}>
          Cancel
        </button>
        <button type="button" onClick={submit} className={BTN_PRIMARY}>
          Submit
        </button>
      </div>
    </DialogShell>
  );
}

// ============================================================================
// EditorDialog
// ============================================================================

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
    // Place cursor at end of prefill
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
      // Ctrl+Enter or Cmd+Enter submits from the textarea
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [value]);

  return (
    <DialogShell title={request.title} onBackdropClick={cancel} width="lg">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={8}
        className="w-full p-3 text-base bg-[#0d1117] border border-[#30363d] rounded-lg text-[#e6edf3] focus:border-[#22c55e] focus:outline-none focus:shadow-glow transition-all resize-y mb-2 font-mono"
        autoFocus
      />
      <p className="text-xs text-[#6e7681] mb-4">Ctrl+Enter to submit</p>
      <div className="flex flex-col-reverse sm:flex-row justify-end gap-3">
        <button type="button" onClick={cancel} className={BTN_CANCEL}>
          Cancel
        </button>
        <button type="button" onClick={submit} className={BTN_PRIMARY}>
          Submit
        </button>
      </div>
    </DialogShell>
  );
}
