export interface MarkdownRenderOptions {
  emptyHtml?: string;
  h1ClassName?: string;
  h2ClassName?: string;
  h3ClassName?: string;
  preClassName?: string;
  inlineCodeClassName?: string;
  listClassName?: string;
  orderedListClassName?: string;
  paragraphClassName?: string;
  blockquoteClassName?: string;
  hrClassName?: string;
  linkClassName?: string;
  tableClassName?: string;
  tableHeadCellClassName?: string;
  tableCellClassName?: string;
}

export function escapeMarkdownHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const FENCE_MARKER = '\u0000FENCE';

export function renderMarkdownHtml(md: string, options: MarkdownRenderOptions = {}): string {
  const h1 = options.h1ClassName ? ` class="${options.h1ClassName}"` : '';
  const h2 = options.h2ClassName ? ` class="${options.h2ClassName}"` : '';
  const h3 = options.h3ClassName ? ` class="${options.h3ClassName}"` : '';
  const pre = options.preClassName ? ` class="${options.preClassName}"` : '';
  const code = options.inlineCodeClassName ? ` class="${options.inlineCodeClassName}"` : '';
  const ul = options.listClassName ? ` class="${options.listClassName}"` : '';
  const ol = (options.orderedListClassName ?? options.listClassName) ? ` class="${options.orderedListClassName ?? options.listClassName}"` : '';
  const p = options.paragraphClassName ? ` class="${options.paragraphClassName}"` : '';
  const quote = options.blockquoteClassName ? ` class="${options.blockquoteClassName}"` : '';
  const hr = options.hrClassName ? ` class="${options.hrClassName}"` : '';
  const a = options.linkClassName ? ` class="${options.linkClassName}"` : '';
  const tableCls = options.tableClassName ? ` class="${options.tableClassName}"` : '';
  const thCls = options.tableHeadCellClassName ? ` class="${options.tableHeadCellClassName}"` : '';
  const tdCls = options.tableCellClassName ? ` class="${options.tableCellClassName}"` : '';

  // 1. Lift fenced code out first so its contents aren't transformed as markdown.
  const fences: string[] = [];
  const lifted = md.replace(/```([\s\S]*?)```/g, (_match, body: string) => {
    const index = fences.length;
    fences.push(`<pre${pre}><code>${escapeMarkdownHtml(body.replace(/^\n/, '').replace(/\n$/, ''))}</code></pre>`);
    return `${FENCE_MARKER}${index}\u0000`;
  });

  const escaped = escapeMarkdownHtml(lifted);

  // Inline pass: code spans, emphasis, links. Runs on already-escaped text.
  const inline = (text: string): string =>
    text
      .replace(/`([^`]+)`/g, `<code${code}>$1</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_full, label: string, rawHref: string) => {
        const trimmed = rawHref.trim().replaceAll('"', '&quot;');
        const allowed = /^(https?:\/\/|mailto:|\/|#|\.\/|\.\.\/)/i.test(trimmed);
        const looksLikeScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
        const href = allowed ? trimmed : looksLikeScheme ? '#' : trimmed;
        const external = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a${a} href="${href}"${external}>${label}</a>`;
      });

  // ── GFM tables ────────────────────────────────────────────────────────────
  const splitTableRow = (row: string): string[] => {
    let s = row.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };
  const isTableSeparator = (row: string): boolean => {
    const cells = splitTableRow(row);
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
  };
  // A table starts when a pipe-bearing line is immediately followed by a
  // separator row (|---|:--:|---:| with optional alignment colons).
  const startsTable = (idx: number): boolean =>
    (lines[idx]?.includes('|') ?? false) && idx + 1 < lines.length && isTableSeparator(lines[idx + 1]!);
  const cellAlign = (spec: string): string => {
    const l = spec.startsWith(':');
    const r = spec.endsWith(':');
    if (l && r) return ' style="text-align:center"';
    if (r) return ' style="text-align:right"';
    if (l) return ' style="text-align:left"';
    return '';
  };

  const lines = escaped.split('\n');
  const blocks: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (new RegExp(`^${FENCE_MARKER}\\d+\\u0000$`).test(trimmed)) {
      blocks.push(trimmed);
      i += 1;
      continue;
    }
    if (/^###\s+/.test(line)) { blocks.push(`<h3${h3}>${inline(line.replace(/^###\s+/, ''))}</h3>`); i += 1; continue; }
    if (/^##\s+/.test(line)) { blocks.push(`<h2${h2}>${inline(line.replace(/^##\s+/, ''))}</h2>`); i += 1; continue; }
    if (/^#\s+/.test(line)) { blocks.push(`<h1${h1}>${inline(line.replace(/^#\s+/, ''))}</h1>`); i += 1; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { blocks.push(`<hr${hr}/>`); i += 1; continue; }

    if (startsTable(i)) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]!).map(cellAlign);
      i += 2;
      const bodyRows: string[][] = [];
      while (
        i < lines.length
        && lines[i]!.trim() !== ''
        && lines[i]!.includes('|')
        && !new RegExp(`^${FENCE_MARKER}\\d+\\u0000$`).test(lines[i]!.trim())
      ) {
        bodyRows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      const thead = `<thead><tr>${header.map((c, j) => `<th${thCls}${aligns[j] ?? ''}>${inline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${bodyRows.map((r) => `<tr>${header.map((_c, j) => `<td${tdCls}${aligns[j] ?? ''}>${inline(r[j] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
      blocks.push(`<table${tableCls}>${thead}${tbody}</table>`);
      continue;
    }

    if (/^&gt;\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i]!)) { quoted.push(inline(lines[i]!.replace(/^&gt;\s?/, ''))); i += 1; }
      blocks.push(`<blockquote${quote}>${quoted.join('<br />')}</blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) { items.push(`<li>${inline(lines[i]!.replace(/^[-*]\s+/, ''))}</li>`); i += 1; }
      blocks.push(`<ul${ul}>${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) { items.push(`<li>${inline(lines[i]!.replace(/^\d+\.\s+/, ''))}</li>`); i += 1; }
      blocks.push(`<ol${ol}>${items.join('')}</ol>`);
      continue;
    }
    if (trimmed === '') { i += 1; continue; }

    const para: string[] = [];
    while (
      i < lines.length
      && lines[i]!.trim() !== ''
      && !/^(#{1,3}\s+|&gt;\s?|[-*]\s+|\d+\.\s+|-{3,}$|\*{3,}$|_{3,}$)/.test(lines[i]!)
      && !new RegExp(`^${FENCE_MARKER}\\d+\\u0000$`).test(lines[i]!.trim())
      && !startsTable(i)
    ) {
      para.push(inline(lines[i]!));
      i += 1;
    }
    blocks.push(`<p${p}>${para.join('<br />')}</p>`);
  }

  let html = blocks.join('');
  html = html.replace(new RegExp(`${FENCE_MARKER}(\\d+)\\u0000`, 'g'), (_full, index: string) => fences[Number(index)] ?? '');

  return html || options.emptyHtml || '<p><em>Empty.</em></p>';
}
