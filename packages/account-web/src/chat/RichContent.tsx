import type { MessageImage, RichContentBlock } from '@gitspace/blocks';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@gitspace/ui';
import { Link03 } from '@untitledui/icons';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { ResourceLink } from '../ResourceNavigation.js';
import { TranscriptImage } from '../resource-media.js';

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

export function ToolArguments({ args }: { args: unknown }) {
  const serialized = JSON.stringify(args, null, 2);
  return <GitSpaceMarkdown>{`~~~json\n${serialized}\n~~~`}</GitSpaceMarkdown>;
}

/** A user message as Markdown: an uploaded attachment becomes a link to its drive file, an inline text attachment a
 * titled block of its text. */
export function userMessageMarkdown(text: string): string {
  return text
    .replace(/<attachment name="([^"]*)" url="([^"]*)"[^>]*\/>/gu, (_match, name: string, url: string) => `📎 [${name.replace(/[[\]]/gu, '\\$&')}](${url})`)
    .replace(/<attachment name="([^"]*)">\n([\s\S]*?)\n<\/attachment>/gu, (_match, name: string, content: string) => {
      const fence = '~'.repeat(Math.max(3, ...[...content.matchAll(/~{3,}/gu)].map(run => run[0].length + 1)));
      return `📎 **${name}**\n\n${fence}\n${content}\n${fence}`;
    });
}
