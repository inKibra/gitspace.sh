export interface MarkdownRenderOptions {
  emptyHtml?: string;
  h1ClassName?: string;
  h2ClassName?: string;
  h3ClassName?: string;
  preClassName?: string;
  inlineCodeClassName?: string;
  listClassName?: string;
  paragraphClassName?: string;
}

export function escapeMarkdownHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function renderMarkdownHtml(md: string, options: MarkdownRenderOptions = {}): string {
  const h1 = options.h1ClassName ? ` class="${options.h1ClassName}"` : '';
  const h2 = options.h2ClassName ? ` class="${options.h2ClassName}"` : '';
  const h3 = options.h3ClassName ? ` class="${options.h3ClassName}"` : '';
  const pre = options.preClassName ? ` class="${options.preClassName}"` : '';
  const code = options.inlineCodeClassName ? ` class="${options.inlineCodeClassName}"` : '';
  const ul = options.listClassName ? ` class="${options.listClassName}"` : '';
  const p = options.paragraphClassName ? ` class="${options.paragraphClassName}"` : '';

  let html = escapeMarkdownHtml(md);
  html = html.replace(/^###\s+(.+)$/gm, `<h3${h3}>$1</h3>`);
  html = html.replace(/^##\s+(.+)$/gm, `<h2${h2}>$1</h2>`);
  html = html.replace(/^#\s+(.+)$/gm, `<h1${h1}>$1</h1>`);
  html = html.replace(/```([\s\S]*?)```/g, `<pre${pre}><code>$1</code></pre>`);
  html = html.replace(/`([^`]+)`/g, `<code${code}>$1</code>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/gs, `<ul${ul}>$1</ul>`);
  html = html.split(/\n{2,}/).map((block) => {
    if (block.startsWith('<h') || block.startsWith('<pre') || block.startsWith('<ul')) return block;
    const trimmed = block.trim();
    return trimmed ? `<p${p}>${trimmed.replace(/\n/g, '<br />')}</p>` : '';
  }).join('');

  return html || options.emptyHtml || '<p><em>Empty.</em></p>';
}
