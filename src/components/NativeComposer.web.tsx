/** @jsxImportSource react */
/**
 * NativeComposer — mobile-first chat composer for agent sessions.
 *
 * Handles text input (auto-growing), image/file attachments, clipboard paste,
 * send-on-Enter (desktop only), and an abort button when the agent is busy.
 */

import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
} from 'react';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NativeComposerWebProps {
  onSubmit: (text: string, images: Array<{ dataUrl: string; name: string }>, files: Array<{ name: string; dataUrl: string }>) => void;
  onAbort?: () => void;
  isBusy?: boolean;
  isSubmitting?: boolean;
  disabled?: boolean;
  placeholder?: string;
  onRequestCommands?: () => Promise<Array<{ name: string; description: string; kind: string }>>;
  onRequestFileSuggestions?: (prefix: string) => Promise<Array<{ path: string; isDirectory: boolean }>>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AttachedImage {
  /** Populated once FileReader finishes; empty string while loading */
  dataUrl: string;
  name: string;
  loading: boolean;
}

interface AttachedFile {
  name: string;
  /** Base64 data URL of the file content */
  dataUrl: string;
  loading: boolean;
}

interface AutocompleteState {
  mode: 'slash' | 'at' | null;
  items: Array<{ label: string; description?: string; kind?: string }>;
  selectedIndex: number;
  loading: boolean;
  /** The trigger position in the text (index of / or @) */
  triggerPos: number;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reads a File as a base64 data URL. Rejects with the FileReader error. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

const MAX_TEXTAREA_HEIGHT = 200; // px

// ---------------------------------------------------------------------------
// Icon components — inline SVG, no external deps
// ---------------------------------------------------------------------------

function IconPaperPlane(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 1.5L14.5 8L1.5 14.5V9L11 8L1.5 7V1.5Z" fill="currentColor" />
    </svg>
  );
}

function IconImage(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5.5" cy="6" r="1.5" fill="currentColor" />
      <path
        d="M1.5 11L5 8L8 11L11 7.5L14.5 11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconAttach(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M12.5 7.5L7 13a4 4 0 01-5.657-5.657L8.5 1.085a2.5 2.5 0 013.536 3.536L5.879 10.778a1 1 0 01-1.414-1.414L10 3.828"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconStop(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function IconX(): React.ReactElement {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path
        d="M1 1L7 7M7 1L1 7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Spinner(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      className="animate-spin"
      aria-label="Loading"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="25 13"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// ToolButton — small icon button for attach actions
// ---------------------------------------------------------------------------

interface ToolButtonProps {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}

function ToolButton({ onClick, title, disabled = false, children }: ToolButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 38,
        height: 38,
        borderRadius: 8,
        background: 'none',
        border: '1px solid var(--gs-border)',
        color: disabled ? 'var(--gs-border)' : 'var(--gs-text-dim)',
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        padding: 0,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Shared style constant — action button (send / abort)
// ---------------------------------------------------------------------------

const ACTION_BUTTON_BASE: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 10,
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  padding: 0,
  WebkitTapHighlightColor: 'transparent',
};

// ---------------------------------------------------------------------------
// NativeComposer
// ---------------------------------------------------------------------------

export function NativeComposer({
  onSubmit,
  onAbort,
  isBusy = false,
  isSubmitting = false,
  disabled = false,
  placeholder = 'Message...',
  onRequestCommands,
  onRequestFileSuggestions,
}: NativeComposerWebProps): React.ReactElement {
  const [text, setText] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [autocomplete, setAutocomplete] = useState<AutocompleteState>({
    mode: null, items: [], selectedIndex: 0, loading: false, triggerPos: 0,
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const commandsCacheRef = useRef<Array<{ label: string; description?: string; kind?: string }> | null>(null);
  const fileSuggestionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Controls are disabled while submitting or externally disabled.
  // isBusy does not disable input — it shows the abort button instead of send.
  const isDisabled = disabled || isSubmitting;
  const hasContent = text.trim().length > 0 || images.some(i => !i.loading) || files.some(f => !f.loading);
  const canSend = !isDisabled && !isBusy && hasContent;

  // Auto-focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-grow: reset to auto then clamp to MAX_TEXTAREA_HEIGHT
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const natural = ta.scrollHeight;
    ta.style.height = `${Math.min(natural, MAX_TEXTAREA_HEIGHT)}px`;
    ta.style.overflowY = natural > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  // ── Submit helper — clears state after sending ───────────────────────────
  const submitAndClear = useCallback(
    (currentText: string, currentImages: AttachedImage[], currentFiles: AttachedFile[]) => {
      const readyImages = currentImages
        .filter(img => !img.loading)
        .map(({ dataUrl, name }) => ({ dataUrl, name }));
      const readyFiles = currentFiles
        .filter(f => !f.loading && f.dataUrl)
        .map(({ name, dataUrl }) => ({ name, dataUrl }));
      onSubmit(currentText.trim(), readyImages, readyFiles);
      setText('');
      setImages([]);
      setFiles([]);
      setAutocomplete({ mode: null, items: [], selectedIndex: 0, loading: false, triggerPos: 0 });
    },
    [onSubmit]
  );

  // ── Autocomplete helpers ──────────────────────────────────────────────────────────

  const closeAutocomplete = useCallback(() => {
    setAutocomplete({ mode: null, items: [], selectedIndex: 0, loading: false, triggerPos: 0 });
    if (fileSuggestionsTimerRef.current) {
      clearTimeout(fileSuggestionsTimerRef.current);
      fileSuggestionsTimerRef.current = null;
    }
  }, []);

  const acceptAutocomplete = useCallback((index: number) => {
    const item = autocomplete.items[index];
    if (!item) return;
    const before = text.slice(0, autocomplete.triggerPos);
    const after = text.slice(textareaRef.current?.selectionStart ?? text.length);
    if (autocomplete.mode === 'slash') {
      setText(`${before}/${item.label} ${after}`);
    } else if (autocomplete.mode === 'at') {
      const suffix = item.kind === 'directory' ? '/' : ' ';
      setText(`${before}@${item.label}${suffix}${after}`);
    }
    closeAutocomplete();
    // Re-focus textarea after accepting
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [autocomplete, text, closeAutocomplete]);

  const fetchCommands = useCallback(async (filter: string) => {
    if (!onRequestCommands) return;
    if (!commandsCacheRef.current) {
      try {
        const cmds = await onRequestCommands();
        commandsCacheRef.current = cmds.map(c => ({ label: c.name, description: c.description, kind: c.kind }));
      } catch {
        commandsCacheRef.current = [];
      }
    }
    const items = commandsCacheRef.current.filter(c => c.label.toLowerCase().startsWith(filter.toLowerCase()));
    setAutocomplete(prev => ({ ...prev, items, selectedIndex: 0, loading: false }));
  }, [onRequestCommands]);

  const fetchFileSuggestions = useCallback((prefix: string) => {
    if (!onRequestFileSuggestions) return;
    // Debounce
    if (fileSuggestionsTimerRef.current) clearTimeout(fileSuggestionsTimerRef.current);
    fileSuggestionsTimerRef.current = setTimeout(async () => {
      try {
        const suggestions = await onRequestFileSuggestions(prefix);
        setAutocomplete(prev => {
          if (prev.mode !== 'at') return prev; // stale
          return {
            ...prev,
            items: suggestions.map(s => ({ label: s.path, kind: s.isDirectory ? 'directory' : 'file' })),
            selectedIndex: 0,
            loading: false,
          };
        });
      } catch {
        setAutocomplete(prev => prev.mode === 'at' ? { ...prev, items: [], loading: false } : prev);
      }
    }, 200);
  }, [onRequestFileSuggestions]);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleTextChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    const cursorPos = e.target.selectionStart ?? newText.length;
    setText(newText);

    // Detect autocomplete triggers
    // Slash command: text starts with / and cursor is in the first token
    const hasSpace = newText.includes(' ');
    const isSlashTrigger = newText.startsWith('/') && (!hasSpace || cursorPos <= newText.indexOf(' ', 1));
    if (isSlashTrigger) {
      const token = newText.slice(1, cursorPos);
      setAutocomplete({ mode: 'slash', items: [], selectedIndex: 0, loading: true, triggerPos: 0 });
      fetchCommands(token);
      return;
    }

    // @ mention: find the last @ before cursor that is at start-of-word
    let atPos = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      if (newText[i] === ' ' || newText[i] === '\n') break;
      if (newText[i] === '@') {
        // Valid if at start of text or preceded by whitespace
        if (i === 0 || newText[i - 1] === ' ' || newText[i - 1] === '\n') {
          atPos = i;
        }
        break;
      }
    }
    if (atPos >= 0) {
      const token = newText.slice(atPos + 1, cursorPos);
      setAutocomplete({ mode: 'at', items: [], selectedIndex: 0, loading: true, triggerPos: atPos });
      fetchFileSuggestions(token);
      return;
    }

    // No trigger — close autocomplete
    closeAutocomplete();
  }, [fetchCommands, fetchFileSuggestions, closeAutocomplete]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // Autocomplete navigation when dropdown is open
      if (autocomplete.mode && autocomplete.items.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setAutocomplete(prev => ({
            ...prev,
            selectedIndex: (prev.selectedIndex + 1) % prev.items.length,
          }));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setAutocomplete(prev => ({
            ...prev,
            selectedIndex: (prev.selectedIndex - 1 + prev.items.length) % prev.items.length,
          }));
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          acceptAutocomplete(autocomplete.selectedIndex);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeAutocomplete();
          return;
        }
      }

      // Normal Enter-to-submit (without Shift)
      if (e.key === 'Enter' && !e.shiftKey) {
        if (!isDisabled && !isBusy && text.trim().length > 0) {
          e.preventDefault();
          submitAndClear(text, images, files);
        }
      }
    },
    [text, images, files, isDisabled, isBusy, submitAndClear, autocomplete, acceptAutocomplete, closeAutocomplete]
  );

  const handleSend = useCallback(() => {
    if (!canSend) return;
    submitAndClear(text, images, files);
  }, [canSend, text, images, files, submitAndClear]);

  // ── Clipboard paste — intercept image data ───────────────────────────────
  const handlePaste = useCallback(
    async (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter(item => item.type.startsWith('image/'));
      if (imageItems.length === 0) return;

      // Only intercept when there are images; text paste falls through normally.
      e.preventDefault();

      const placeholders: AttachedImage[] = imageItems.map((_, i) => ({
        dataUrl: '',
        name: `pasted-${Date.now()}-${i}.png`,
        loading: true,
      }));
      setImages(prev => [...prev, ...placeholders]);

      await Promise.all(
        imageItems.map(async (item, i) => {
          const placeholder = placeholders[i];
          const file = item.getAsFile();
          if (!file) {
            setImages(prev => prev.filter(img => img !== placeholder));
            return;
          }
          try {
            const dataUrl = await readFileAsDataUrl(file);
            setImages(prev =>
              prev.map(img =>
                img === placeholder ? { dataUrl, name: placeholder.name, loading: false } : img
              )
            );
          } catch {
            setImages(prev => prev.filter(img => img !== placeholder));
          }
        })
      );
    },
    []
  );

  // ── Image file picker ────────────────────────────────────────────────────
  const handleImagePickerChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files ?? []);
      if (picked.length === 0) return;

      const placeholders: AttachedImage[] = picked.map(file => ({
        dataUrl: '',
        name: file.name,
        loading: true,
      }));
      setImages(prev => [...prev, ...placeholders]);

      await Promise.all(
        picked.map(async (file, i) => {
          const placeholder = placeholders[i];
          try {
            const dataUrl = await readFileAsDataUrl(file);
            setImages(prev =>
              prev.map(img =>
                img === placeholder ? { dataUrl, name: file.name, loading: false } : img
              )
            );
          } catch {
            setImages(prev => prev.filter(img => img !== placeholder));
          }
        })
      );

      // Reset so the same file can be re-selected
      e.target.value = '';
    },
    []
  );

  // ── Generic file picker ──────────────────────────────────────────────────
  const handleFilePickerChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList) return;
    const newFiles: AttachedFile[] = Array.from(fileList).map(file => ({
      name: file.name,
      dataUrl: '',
      loading: true,
    }));
    setFiles(prev => [...prev, ...newFiles]);

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      try {
        const dataUrl = await readFileAsDataUrl(file);
        setFiles(prev => prev.map((f, j) =>
          j === prev.length - newFiles.length + i
            ? { ...f, dataUrl, loading: false }
            : f
        ));
      } catch {
        setFiles(prev => prev.filter((_, j) => j !== prev.length - newFiles.length + i));
      }
    }
    // Reset input so same file can be re-selected
    e.target.value = '';
  }, []);

  const removeImage = useCallback((idx: number) => {
    setImages(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const removeFile = useCallback((idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const hasAttachments = images.length > 0 || files.length > 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      style={{
        width: '100%',
        background: 'var(--gs-bg)',
        borderTop: '1px solid var(--gs-border)',
        padding: '8px 12px',
        // Respect iOS safe area
        paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        boxSizing: 'border-box',
      }}
    >
      {/* ── Attachment previews ─────────────────────────────────────────── */}
      {hasAttachments && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            paddingBottom: 2,
          }}
        >
          {images.map((img, idx) => (
            <div
              key={idx}
              style={{
                position: 'relative',
                width: 48,
                height: 48,
                borderRadius: 6,
                overflow: 'hidden',
                border: '1px solid var(--gs-border)',
                flexShrink: 0,
                background: 'var(--gs-bg-elevated)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {img.loading ? (
                <span style={{ color: 'var(--gs-text-dim)' }}>
                  <Spinner />
                </span>
              ) : (
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              )}
              <button
                type="button"
                onClick={() => removeImage(idx)}
                aria-label={`Remove ${img.name}`}
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  background: 'rgba(0,0,0,0.75)',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--gs-text)',
                  padding: 0,
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <IconX />
              </button>
            </div>
          ))}

          {files.map((file, idx) => (
            <div
              key={`file-${idx}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                background: 'var(--gs-bg-elevated)',
                border: '1px solid var(--gs-border)',
                borderRadius: 6,
                padding: '4px 8px',
                maxWidth: 160,
                height: 28,
                boxSizing: 'border-box',
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--gs-text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flex: 1,
                }}
              >
                {file.loading ? <Spinner /> : file.name}
              </span>
              <button
                type="button"
                onClick={() => removeFile(idx)}
                aria-label={`Remove ${file.name}`}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--gs-text-dim)',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  flexShrink: 0,
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <IconX />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Input row ────────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
        {/* Attach buttons */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <ToolButton
            onClick={() => imageInputRef.current?.click()}
            title="Attach image"
            disabled={isDisabled}
          >
            <IconImage />
          </ToolButton>
          <ToolButton
            onClick={() => fileInputRef.current?.click()}
            title="Attach file"
            disabled={isDisabled}
          >
            <IconAttach />
          </ToolButton>
        </div>

        {/* Textarea wrapper with autocomplete dropdown */}
        <div style={{ flex: 1, position: 'relative' }}>
          {/* Autocomplete dropdown */}
          {autocomplete.mode && autocomplete.items.length > 0 && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                maxHeight: 200,
                overflowY: 'auto',
                background: 'var(--gs-bg-elevated)',
                border: '1px solid var(--gs-border)',
                borderRadius: 8,
                marginBottom: 4,
                zIndex: 100,
              }}
            >
              {autocomplete.items.map((item, i) => (
                <div
                  key={item.label}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent textarea blur
                    acceptAutocomplete(i);
                  }}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    background: i === autocomplete.selectedIndex ? 'var(--gs-bg-active)' : 'transparent',
                    color: 'var(--gs-text)',
                    fontSize: 13,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontFamily: 'monospace' }}>
                    {autocomplete.mode === 'slash' ? '/' : '@'}{item.label}
                  </span>
                  {item.description && (
                    <span style={{ color: 'var(--gs-text-dim)', fontSize: 12, marginLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Auto-growing textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={isDisabled}
            rows={1}
            style={{
              width: '100%',
              background: 'var(--gs-bg-elevated)',
              border: '1px solid var(--gs-border)',
              borderRadius: 10,
              color: isDisabled ? 'var(--gs-text-dim)' : 'var(--gs-text)',
              fontSize: 15,
              lineHeight: 1.5,
              padding: '8px 12px',
              resize: 'none',
              outline: 'none',
              overflowY: 'hidden',
              minHeight: 38,
              maxHeight: MAX_TEXTAREA_HEIGHT,
              boxSizing: 'border-box',
              fontFamily: 'inherit',
              WebkitAppearance: 'none',
              caretColor: 'var(--gs-accent)',
            }}
          />
        </div>

        {/* Send button (normal) or Abort button (when busy) */}
        {isBusy ? (
          <button
            type="button"
            onClick={onAbort}
            disabled={!onAbort}
            title="Abort"
            style={{
              ...ACTION_BUTTON_BASE,
              background: 'var(--gs-danger)',
              color: 'white',
              opacity: onAbort ? 1 : 0.4,
              cursor: onAbort ? 'pointer' : 'default',
            }}
          >
            <IconStop />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            title="Send"
            style={{
              ...ACTION_BUTTON_BASE,
              background: canSend ? 'var(--gs-accent)' : 'var(--gs-btn-secondary-bg)',
              color: canSend ? 'var(--gs-text-on-accent)' : 'var(--gs-text-dim)',
              cursor: canSend ? 'pointer' : 'default',
            }}
          >
            {isSubmitting ? <Spinner /> : <IconPaperPlane />}
          </button>
        )}
      </div>

      {/* Hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleImagePickerChange}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFilePickerChange}
      />
    </div>
  );
}
