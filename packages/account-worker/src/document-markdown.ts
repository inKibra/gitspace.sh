/** Documents the Workers AI converter reads as Markdown, by extension. Images are read as images, text as text. */
const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  numbers: 'application/vnd.apple.numbers',
};
/** Markup the converter also reads, by media type, as the converter names it. Converted only when a caller names the
 * type (a chat attachment): an HTML, CSV or XML file read from the working copy is source and stays text. */
const MARKUP_TYPES: Record<string, string> = {
  'text/html': 'text/html',
  'text/csv': 'text/csv',
  'text/xml': 'application/xml',
  'application/xml': 'application/xml',
};
const DOCUMENT_MEDIA_TYPES: Record<string, true> = Object.fromEntries(Object.values(DOCUMENT_TYPES).map(type => [type, true]));
/** Rows of converted Markdown kept per part; one SQLite value stays well under its size limit. */
const PART_CHARACTERS = 512 * 1024;

/** Converts a document to Markdown once per content: the result is kept in the workspace object by content hash. A
 * scanned document (pages without a text layer) is an error that says so, not an empty read. A file that is not a
 * document gives null. `mediaType`, when given, decides what the file is instead of its name's extension, and also
 * admits HTML, CSV and XML. */
export type DocumentMarkdown = (name: string, bytes: Uint8Array<ArrayBuffer>, mediaType?: string) => Promise<string | null>;

export function createDocumentMarkdown(storage: DurableObjectStorage, ai: Ai): DocumentMarkdown {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS document_markdown(hash TEXT NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(hash, part))');
  return async (name, bytes, mediaType) => {
    const markup = mediaType === undefined ? undefined : MARKUP_TYPES[mediaType];
    const type = mediaType === undefined ? DOCUMENT_TYPES[name.split('.').at(-1)?.toLowerCase() ?? ''] : markup ?? (DOCUMENT_MEDIA_TYPES[mediaType] ? mediaType : undefined);
    if (!type) return null;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const cached = storage.sql.exec<{ text: string }>('SELECT text FROM document_markdown WHERE hash=? ORDER BY part', hash).toArray();
    if (cached.length) return cached.map(row => row.text).join('');
    const [converted] = await ai.toMarkdown([{ name, blob: new Blob([bytes], { type }) }]);
    if (!converted || converted.format !== 'markdown') throw new Error(`${name} could not be converted to text${converted && 'error' in converted ? `: ${converted.error}` : ''}`);
    const contents = converted.data.split('## Contents').slice(1).join('## Contents');
    if (!markup && !contents.replace(/^#+ .*$/gmu, '').trim()) throw new Error(`${name} has no text layer (a scanned document); its pages are images the converter does not read. Open it on a machine to OCR it.`);
    storage.transactionSync(() => {
      for (let part = 0; part * PART_CHARACTERS < converted.data.length; part++) {
        storage.sql.exec('INSERT OR REPLACE INTO document_markdown(hash,part,text) VALUES(?,?,?)', hash, part, converted.data.slice(part * PART_CHARACTERS, (part + 1) * PART_CHARACTERS));
      }
    });
    return converted.data;
  };
}
