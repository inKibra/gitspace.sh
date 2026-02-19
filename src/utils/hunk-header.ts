export function normalizeHunkHeader(header: string): string {
  const trimmed = header.trim();
  if (!trimmed) {
    return '@@ @@';
  }

  const match = trimmed.match(/^@@\s*(.*?)\s*@@(?:\s*(.*))?$/);
  if (!match) {
    return trimmed.replace(/\s+/g, ' ');
  }

  const specs = (match[1] ?? '').trim().replace(/\s+/g, ' ');
  const context = (match[2] ?? '').trim().replace(/\s+/g, ' ');

  const headerCore = specs ? `@@ ${specs} @@` : '@@ @@';
  return context ? `${headerCore} ${context}` : headerCore;
}
