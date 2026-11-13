import type { MessageImage, RichContentBlock } from '@gitspace/blocks';
import type { ChatAttachment } from '@gitspace/protocol-runtime/chat-attachments';
import { STAGED_CHOICE_DATA } from '@gitspace/protocol-runtime/session-controls';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useShape } from '@gitspace/ui';
import { File06, Link03 } from '@untitledui/icons';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { formatBytes } from '../inspector/artifact-upload.js';
import { ResourceLink } from '../ResourceNavigation.js';
import { ResourceMedia, TranscriptImage } from '../resource-media.js';

export function RichContent({ block }: { block: RichContentBlock }) {
  switch (block.type) {
    case 'markdown': return <GitSpaceMarkdown>{block.text}</GitSpaceMarkdown>;
    case 'code': return <GitSpaceMarkdown>{`~~~${block.language ?? ''}\n${block.text}\n~~~`}</GitSpaceMarkdown>;
    case 'diff': return <GitSpaceMarkdown>{`~~~diff\n${block.patch}\n~~~`}</GitSpaceMarkdown>;
    case 'diagram': return <GitSpaceMarkdown>{`~~~mermaid\n${block.source}\n~~~`}</GitSpaceMarkdown>;
    case 'file-tree': return <div className="flex min-w-0 flex-col gap-0.5 font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">{block.paths.map((path) => <code key={path}>{path}</code>)}</div>;
    case 'image': return <TranscriptImage alt={block.alt ?? 'Tool output image'} label="Open tool output image" src={block.url} />;
    case 'artifact-ref': return <ResourceLink className="inline-flex min-w-0 max-w-full items-center gap-1 text-body text-foreground underline-offset-4 hover:underline" href={block.url}><Link03 className="shrink-0" width={14} height={14} strokeWidth={1.5} /><span className="min-w-0 [overflow-wrap:anywhere]">{block.label}</span></ResourceLink>;
    case 'table': return <div className="min-w-0 max-w-full overflow-x-auto [overflow-wrap:normal]" role="region" aria-label="Tool output table" tabIndex={0}><Table>
      <TableHeader><TableRow>{block.columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{block.rows.map((row, index) => <TableRow key={index}>{row.map((cell, cellIndex) => <TableCell key={cellIndex}>{cell}</TableCell>)}</TableRow>)}</TableBody>
    </Table></div>;
  }
}

export function MessageAttachments({ images }: { images: MessageImage[] }) {
  return <>{images.map((image, index) => <TranscriptImage
    alt={`Attached image ${index + 1}`}
    key={`${image.mimeType}:${index}`}
    label={`Open attached image ${index + 1}`}
    src={'url' in image ? image.url : `data:${image.mimeType};base64,${image.data}`}
  />)}</>;
}

/** A message's attached files: an image as its thumbnail from the drive, any other file as a chip with its name, type
 * and size that opens the drive file. */
export function MessageFiles({ attachments }: { attachments: readonly ChatAttachment[] }) {
  const shape = useShape();
  return <span role="group" aria-label="Attachments" className="flex min-w-0 flex-wrap justify-end gap-1.5">{attachments.map((attachment, index) => attachment.type.startsWith('image/')
    ? <ResourceMedia key={`${attachment.url}:${index}`} uri={attachment.url} alt={attachment.name} />
    : <ResourceLink key={`${attachment.url}:${index}`} href={attachment.url} className={`${shape.container} inline-flex min-w-0 max-w-full items-center gap-2 bg-surface-2 px-3 py-2 text-foreground shadow-surface-1 hover:bg-surface-3`}>
      <File06 width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 text-body [overflow-wrap:anywhere]">{attachment.name}</span>
      <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{attachment.type} · {formatBytes(attachment.size)}</span>
    </ResourceLink>)}</span>;
}

/** A user message as Markdown: a staged choice shows as its line only (its data is for the agent). Messages sent before
 * attachments carried their hash name an uploaded file by a tag without one, shown as a link to its drive file, and a
 * small text file as a tag around its text, shown as a titled block. */
export function userMessageMarkdown(text: string): string {
  return text
    .replace(STAGED_CHOICE_DATA, '$1')
    .replace(/<attachment name="([^"]*)" url="([^"]*)"[^>]*\/>/gu, (_match, name: string, url: string) => `📎 [${name.replace(/[[\]]/gu, '\\$&')}](${url})`)
    .replace(/<attachment name="([^"]*)">\n([\s\S]*?)\n<\/attachment>/gu, (_match, name: string, content: string) => {
      const fence = '~'.repeat(Math.max(3, ...[...content.matchAll(/~{3,}/gu)].map(run => run[0].length + 1)));
      return `📎 **${name}**\n\n${fence}\n${content}\n${fence}`;
    });
}
