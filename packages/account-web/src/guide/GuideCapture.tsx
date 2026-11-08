// One intro capture of a Change Guide, shown as what it is: an image, a video, a browser capture's poster with Play, a
// text file's first lines, or a file card. Loading shows while the read is pending; a failed read shows why, with Retry.
import { guideCaptureKind, type EvidenceReference } from '@gitspace/protocol';
import { Button, Card, CardContent, CardDescription, CardGroup, CardHeader, CardMedia, CardTitle, useShape } from '@gitspace/ui';
import { AlertCircle, Camera01, File02, FileCode02, Image01, Play } from '@untitledui/icons';
import { useEffect, type ReactNode } from 'react';
import { glyph } from '../glyph.js';
import { formatBytes } from '../inspector/artifact-upload.js';
import { artifactId, ic, type ArtifactReference, type InspectorArtifactContent, type LoadStatus } from '../inspector/inspector-shared.js';

/** How the Inspector reads a capture and what it knows of it from the drive. */
export interface GuideCaptures {
  content(reference: ArtifactReference): InspectorArtifactContent | null;
  status(reference: ArtifactReference): LoadStatus;
  error(reference: ArtifactReference): string | undefined;
  load(reference: ArtifactReference): void;
  /** The file's size as the drive lists it; null when the drive does not list it. */
  size(reference: ArtifactReference): number | null;
  /** A browser capture's files in the drive: the picture it shows before playing, and what it plays (its video, else
   * its screenshot); each null when the drive does not list it. */
  browserCapture(reference: ArtifactReference): { poster: ArtifactReference | null; recording: ArtifactReference | null };
}

/** How many lines of a text capture its card shows. */
const PREVIEW_LINES = 6;
const TEXT_EXTENSIONS: Readonly<Record<string, true>> = { json: true, md: true, txt: true, csv: true, log: true, yaml: true, yml: true, xml: true, html: true };
const FileGlyph = glyph(File02);
const TextGlyph = glyph(FileCode02);

function fileName(url: string): string {
  const last = url.split('/').filter(Boolean).at(-1) ?? url;
  try { return decodeURIComponent(last); } catch { return last; }
}

/** A text file by its media type, else by its extension. */
function textual(reference: ArtifactReference): boolean {
  const type = reference.mediaType;
  if (type) return type.startsWith('text/') || type === 'application/json' || type.endsWith('+json');
  return TEXT_EXTENSIONS[fileName(reference.url).split('.').at(-1)?.toLowerCase() ?? ''] === true;
}

/** The first lines of a text file; JSON written on one line is indented first so its lines say something. */
function firstLines(source: string): string {
  let text = source;
  if (!source.trimEnd().includes('\n')) {
    try { text = JSON.stringify(JSON.parse(source), null, 2); } catch { text = source; }
  }
  return text.split('\n').slice(0, PREVIEW_LINES).join('\n');
}

function CaptureFrame({ icon, role, children }: { icon: ReactNode; role?: 'status' | 'alert'; children: ReactNode }) {
  const shape = useShape();
  return <div role={role} className={`flex aspect-video w-full flex-col items-center justify-center gap-2 border border-dashed border-border bg-surface-1 p-4 text-center text-caption text-muted-foreground ${shape.container}`}>
    {icon}{children}
  </div>;
}

function FileCard({ reference, size, lines, note, onOpen }: { reference: ArtifactReference; size: number | null; lines: string | null; note: string | null; onOpen: (() => void) | null }) {
  const name = fileName(reference.url);
  const detail = [size === null ? null : formatBytes(size), reference.mediaType ?? 'file'].filter((part) => part !== null).join(' · ');
  return <CardGroup border="outlined"><Card size="compact" {...(onOpen ? { onClick: onOpen, label: `Open ${name}` } : {})}>
    <CardMedia icon={textual(reference) ? TextGlyph : FileGlyph} />
    <CardHeader>
      <CardTitle className="truncate">{name}</CardTitle>
      <CardDescription className="truncate tabular-nums">{detail}</CardDescription>
    </CardHeader>
    {lines !== null || note ? <CardContent>
      {lines !== null ? <pre className="max-h-32 overflow-hidden whitespace-pre-wrap break-all font-mono text-caption text-muted-foreground">{lines}</pre> : null}
      {note ? <p className="text-caption text-muted-foreground">{note}</p> : null}
    </CardContent> : null}
  </Card></CardGroup>;
}

export function GuideCapture({ reference, captures, onOpen }: {
  reference: ArtifactReference;
  captures: GuideCaptures | null;
  onOpen: ((reference: EvidenceReference) => void) | null;
}) {
  const shape = useShape();
  const kind = guideCaptureKind(reference);
  const files = kind === 'browser-capture' && captures ? captures.browserCapture(reference) : null;
  // What is read to show the capture: a browser capture's poster, the file itself when it is shown inline, else nothing.
  const shown = kind === 'browser-capture' ? files?.poster ?? null : kind || textual(reference) ? reference : null;
  const status = shown && captures ? captures.status(shown) : undefined;
  const content = shown && captures ? captures.content(shown) : null;
  useEffect(() => { if (shown && captures && status === undefined) captures.load(shown); }, [shown ? artifactId(shown) : null, status]);
  let body: ReactNode;
  if (!captures) body = <CaptureFrame icon={ic(Image01, 20)}>Captures open in the workspace.</CaptureFrame>;
  else if (shown && status === 'error') {
    body = <CaptureFrame icon={ic(AlertCircle, 20)} role="alert">
      <span>{captures.error(shown) ?? `${fileName(shown.url)} could not be read.`}</span>
      <Button variant="tertiary" size="compact" type="button" onClick={() => captures.load(shown)}>Retry</Button>
    </CaptureFrame>;
  } else if (shown && !content) body = <CaptureFrame icon={ic(Image01, 20)} role="status">Loading the capture…</CaptureFrame>;
  else if (kind === 'image' && content) body = <img src={content.previewUrl} alt={reference.label} className={`w-full border border-border bg-surface-1 object-contain ${shape.container}`} />;
  else if (kind === 'video' && content) body = <video src={content.previewUrl} aria-label={reference.label} controls preload="metadata" playsInline className={`aspect-video w-full border border-border bg-black ${shape.container}`} />;
  else if (kind === 'browser-capture') {
    const recording = files?.recording ?? null;
    const verb = recording && guideCaptureKind(recording) === 'video' ? 'Play' : 'View';
    body = <div className={`relative w-full overflow-hidden border border-border bg-surface-1 ${shape.container}`}>
      {content ? <img src={content.previewUrl} alt={reference.label} className="block aspect-video w-full object-cover object-top" />
        : <div className="flex aspect-video w-full items-center justify-center text-muted-foreground">{ic(Camera01, 22)}</div>}
      {recording && onOpen ? <span className="absolute inset-0 flex items-center justify-center">
        <Button variant="primary" size="compact" type="button" aria-label={`${verb} ${reference.label}`} onClick={() => onOpen(recording)}>{ic(Play, 14)}{verb}</Button>
      </span> : null}
    </div>;
  } else {
    const lines = content?.source ? firstLines(content.source) : null;
    body = <FileCard reference={reference} size={captures.size(reference)} lines={lines} note={content?.oversized ? 'Too large to preview here.' : null} onOpen={onOpen ? () => onOpen(reference) : null} />;
  }
  return <figure className="flex min-w-0 flex-col gap-1.5" data-capture-kind={kind ?? (textual(reference) ? 'text' : 'file')}>
    {body}
    <figcaption className="text-caption text-foreground">{reference.label}</figcaption>
  </figure>;
}
