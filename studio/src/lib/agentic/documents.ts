// documents.ts — dependency-free text extraction for real document formats.
//
// WHY THIS EXISTS
//   knowledge.ts used to reject every binary document ("pdf/docx/xlsx → not
//   supported"), so the agent could not read the files people actually have.
//   This module extracts the TEXT out of the common office/document formats
//   without adding a single npm dependency (the Studio must stay installable
//   on a small laptop, offline):
//
//     *.pdf          content streams + text-showing operators
//     *.docx         WordprocessingML (word/document.xml)
//     *.xlsx/*.csv   SpreadsheetML (sharedStrings + sheet1..n)
//     *.pptx         PresentationML (ppt/slides/slideN.xml)
//     *.odt/*.ods    OpenDocument content.xml
//     *.rtf          control-word stripped text
//     *.epub         XHTML chapters inside the container
//
// HONEST LIMITS (reported in `warnings`, never hidden)
//   * A PDF whose text is a vector/glyph drawing (a scan, or a CID font
//     without a ToUnicode map) yields little or no text — we say so instead
//     of returning an empty document silently. OCR is a separate problem.
//   * Legacy binary Office formats (.doc/.xls/.ppt) are NOT parsed.
//
// SAFETY
//   Everything here is pure: it takes a Buffer and returns text. Size caps and
//   zip-bomb guards are enforced so a hostile document cannot exhaust memory.

import zlib from 'zlib';

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'rtf' | 'epub' | 'csv' | 'text';

export interface ExtractedDocument {
  /** the detected format */
  kind: DocumentKind;
  /** extracted plain text (LF line endings) */
  text: string;
  /** number of PDF pages / spreadsheet sheets / presentation slides, when known */
  units: number;
  /** human-readable limitations found while extracting */
  warnings: string[];
}

export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}

/** hard caps — a document is reference material, not a database dump */
const MAX_UNCOMPRESSED_ENTRY = 64 * 1024 * 1024; // one zip entry
const MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024; // whole archive
const MAX_PDF_STREAMS = 5_000;
const MAX_OUTPUT_CHARS = 4_000_000;

const EXTRACTABLE = new Set([
  '.pdf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.rtf', '.epub', '.csv', '.tsv',
  // plain text formats — handled by the caller as UTF-8, but listed here so a
  // single helper answers "can this be turned into text?"
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.log', '.yml', '.yaml', '.toml',
  '.ini', '.xml', '.html', '.htm', '.sql',
]);

/** true when `ext` (with dot, any case) can be turned into text here. */
export function isExtractableExtension(ext: string): boolean {
  return EXTRACTABLE.has(ext.toLowerCase());
}

export function detectDocumentKind(ext: string): DocumentKind | null {
  const e = ext.toLowerCase();
  if (e === '.pdf') return 'pdf';
  if (e === '.docx') return 'docx';
  if (e === '.xlsx') return 'xlsx';
  if (e === '.pptx') return 'pptx';
  if (e === '.odt') return 'odt';
  if (e === '.ods') return 'ods';
  if (e === '.rtf') return 'rtf';
  if (e === '.epub') return 'epub';
  if (e === '.csv' || e === '.tsv') return 'csv';
  if (/^\.(txt|md|markdown|json|jsonl|log|yml|yaml|toml|ini|xml|html|htm|sql)$/.test(e)) return 'text';
  return null;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/**
 * `String.fromCodePoint` THROWS for anything outside 0 … 0x10FFFF (and a
 * surrogate half produces invalid UTF-16), so one bogus `&#99999999;` in a
 * document used to abort the whole extraction with a RangeError instead of
 * decoding what it could. Out-of-range references are left as literal text.
 */
function codePointOr(whole: string, code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
  if (code >= 0xd800 && code <= 0xdfff) return whole; // lone surrogate
  return String.fromCodePoint(code);
}

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return codePointOr(whole, Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) {
      return codePointOr(whole, Number.parseInt(body.slice(1), 10));
    }
    return ENTITIES[body] ?? whole;
  });
}

/** collapse the whitespace XML/HTML leaves behind, but keep line structure */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** all matches of `re` flattened through `map`, joined with `join` */
function collect(xml: string, re: RegExp, map: (m: RegExpExecArray) => string, join = ' '): string {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const piece = map(m);
    if (piece) out.push(piece);
  }
  return out.join(join);
}

/** trim the result to the global output cap and remember that we did */
function capOutput(text: string, warnings: string[]): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  warnings.push(`Document text was truncated to ${MAX_OUTPUT_CHARS} characters.`);
  return text.slice(0, MAX_OUTPUT_CHARS);
}

// ---------------------------------------------------------------------------
// ZIP (docx / xlsx / pptx / odt / epub are all zip containers)
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Read the CENTRAL DIRECTORY of a zip archive. Only the directory is parsed
 * here; entries are inflated on demand by `readZipEntry`.
 */
export function readZipDirectory(buffer: Buffer): ZipEntry[] {
  // EOCD signature 0x06054b50, scanned backwards over the max comment length
  const maxBack = Math.min(buffer.length, 0xffff + 22);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= buffer.length - maxBack; i--) {
    if (i < 0) break;
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new DocumentError('Not a valid zip/office document (no central directory)');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate one entry (method 0 = stored, 8 = deflate). */
export function readZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize > MAX_UNCOMPRESSED_ENTRY) {
    throw new DocumentError(`Archive entry "${entry.name}" is too large (possible zip bomb)`);
  }
  const lh = entry.localHeaderOffset;
  if (lh + 30 > buffer.length || buffer.readUInt32LE(lh) !== 0x04034b50) {
    throw new DocumentError(`Corrupt zip entry: ${entry.name}`);
  }
  const nameLen = buffer.readUInt16LE(lh + 26);
  const extraLen = buffer.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  // H22: a local header that lies about its name/extra lengths used to slice
  // PAST the end of the file. `subarray` clamps silently, so a STORED entry
  // returned an empty or truncated buffer and the caller cheerfully indexed
  // garbage text as if the document had been read properly. Refuse instead.
  if (
    start < 0 ||
    start > buffer.length ||
    entry.compressedSize > buffer.length - start
  ) {
    throw new DocumentError(`Corrupt zip entry (bad data offset): ${entry.name}`);
  }
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method !== 8) {
    throw new DocumentError(`Unsupported zip compression method ${entry.method} in "${entry.name}"`);
  }
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED_ENTRY });
  } catch (err) {
    throw new DocumentError(`Could not decompress "${entry.name}": ${(err as Error).message}`);
  }
}

/** Read + inflate every entry whose name matches `pick`, with a total-size guard. */
function readPicked(buffer: Buffer, pick: (name: string) => boolean): Map<string, Buffer> {
  const dir = readZipDirectory(buffer);
  const out = new Map<string, Buffer>();
  let total = 0;
  for (const entry of dir) {
    if (!pick(entry.name)) continue;
    const data = readZipEntry(buffer, entry);
    total += data.length;
    if (total > MAX_TOTAL_UNCOMPRESSED) {
      throw new DocumentError('Archive expands to too much data (possible zip bomb)');
    }
    out.set(entry.name, data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/** WordprocessingML → text (paragraphs on their own lines, tables flattened). */
export function extractDocxXml(xml: string): string {
  // <w:p> … </w:p> is a paragraph; inside it <w:t> holds the text runs,
  // <w:tab/> a tab and <w:br/> a line break.
  const paragraphs = xml.split(/<w:p[ >]/).slice(1);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const body = para.split('</w:p>')[0] ?? para;
    const text = collect(
      body,
      /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g,
      (m) => (m[1] !== undefined ? decodeXmlEntities(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n'),
      ''
    );
    if (text.trim()) lines.push(text);
  }
  if (lines.length) return tidy(lines.join('\n'));
  // fall back to every w:t run (a document without w:p wrappers is invalid
  // but we can still salvage the text)
  return tidy(
    collect(xml, /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (m) => decodeXmlEntities(m[1]), ' ')
  );
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

interface Sheet {
  name: string;
  rows: string[][];
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  // <si> is one shared string; it may contain several <t> runs (rich text)
  for (const si of xml.split(/<si[ >]/).slice(1)) {
    const body = si.split(/<\/si>/)[0] ?? si;
    const text = collect(body, /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (m) => decodeXmlEntities(m[1]), '');
    out.push(text);
  }
  return out;
}

/**
 * `A1` → 0, `B7` → 1 … XLSX has at most 16 384 columns (A … XFD).
 * H24: an out-of-range column letter run used to be returned as-is, and the
 * caller pads the row with `while (cells.length < at) cells.push('')` — a cell
 * ref of "AAAAAAAA" (8 billion) or "ZZZZZZ" (≈300 million) in a handcrafted
 * workbook made the parser allocate until the process died. Anything past the
 * real grid is skipped by the caller (negative).
 */
const MAX_SHEET_COLUMNS = 16_384;

function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  if (letters.length > 4) return -1; // cannot be a real column
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  const index = n - 1;
  return index >= MAX_SHEET_COLUMNS ? -1 : index;
}

/** One sheet's XML → rows of cell strings (shared strings resolved). */
export function parseSheetXml(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let value = '';
      if (type === 's') {
        const idx = Number.parseInt(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '', 10);
        value = Number.isFinite(idx) ? shared[idx] ?? '' : '';
      } else if (type === 'inlineStr') {
        value = collect(body, /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (m) => decodeXmlEntities(m[1]), '');
      } else if (type === 'b') {
        value = /<v>1<\/v>/.test(body) ? 'TRUE' : 'FALSE';
      } else {
        value = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }
      const at = ref ? columnIndex(ref) : cells.length;
      if (at < 0) continue; // beyond the sheet grid — not addressable anyway
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    if (cells.some((c) => c !== '')) rows.push(cells);
  }
  return rows;
}

function sheetNames(workbookXml: string): string[] {
  return Array.from(workbookXml.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)).map((m) => decodeXmlEntities(m[1]));
}

function sheetsToText(sheets: Sheet[]): string {
  return sheets
    .map((s) => {
      const body = s.rows.map((r) => r.join('\t').replace(/\t+$/g, '')).join('\n');
      return `### Sheet: ${s.name}\n${body}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

function extractPptx(buffer: Buffer): ExtractedDocument {
  const entries = readPicked(buffer, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\//.test(n));
  const slideNames = Array.from(entries.keys())
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml$/.exec(a)?.[1] ?? 0);
      const nb = Number(/slide(\d+)\.xml$/.exec(b)?.[1] ?? 0);
      return na - nb;
    });
  const warnings: string[] = [];
  const parts: string[] = [];
  slideNames.forEach((name, i) => {
    const xml = (entries.get(name) ?? Buffer.alloc(0)).toString('utf8');
    const text = collect(xml, /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, (m) => decodeXmlEntities(m[1]), '\n');
    parts.push(`--- Slide ${i + 1} ---\n${text.trim()}`);
  });
  if (!slideNames.length) warnings.push('No slides were found in the presentation.');
  return { kind: 'pptx', text: capOutput(tidy(parts.join('\n\n')), warnings), units: slideNames.length, warnings };
}

// ---------------------------------------------------------------------------
// ODT / ODS (OpenDocument)
// ---------------------------------------------------------------------------

function extractOdf(buffer: Buffer, kind: 'odt' | 'ods'): ExtractedDocument {
  const entries = readPicked(buffer, (n) => n === 'content.xml');
  const xml = entries.get('content.xml')?.toString('utf8');
  if (!xml) throw new DocumentError('content.xml is missing — not a valid OpenDocument file');
  const warnings: string[] = [];
  // headings and paragraphs each become a line; table cells are tab separated
  const blocks = collect(xml, /<text:(h|p)\b[^>]*>([\s\S]*?)<\/text:\1>|<table:table-cell\b[\s\S]*?<\/table:table-cell>/g, (m) => {
    const raw = m[2] !== undefined ? m[2] : m[0];
    return decodeXmlEntities(raw.replace(/<text:tab\/>/g, '\t').replace(/<text:(line-break|s)\/>/g, ' ').replace(/<[^>]+>/g, ''));
  }, '\n');
  const units = kind === 'ods' ? (xml.match(/<table:table\b/g) ?? []).length : 0;
  const text = tidy(blocks);
  if (!text) warnings.push('The document contains no extractable text.');
  return { kind, text: capOutput(text, warnings), units, warnings };
}

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

/** remove `{...}` groups whose first control word is in `destinations` */
function stripRtfDestinations(rtf: string, destinations: string[]): string {
  const isTarget = (group: string) => {
    // the first token of the group decides: `{\fonttbl ...}` or `{\*\pict ...}`
    const m = /^\{(?:\*)?\\?([a-zA-Z]+)/.exec(group);
    return m ? destinations.includes(m[1]) : false;
  };
  let out = '';
  for (let i = 0; i < rtf.length; i++) {
    if (rtf[i] !== '{') {
      out += rtf[i];
      continue;
    }
    // find the matching closing brace, honouring nesting and escaped braces
    const start = i;
    let depth = 0;
    let j = i;
    for (; j < rtf.length; j++) {
      const ch = rtf[j];
      if (ch === '\\') {
        j++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const group = rtf.slice(start, j + 1);
    if (isTarget(group)) {
      i = j; // drop the whole group
      continue;
    }
    // keep the braces, but strip the destinations nested inside as well
    out += '{' + stripRtfDestinations(group.slice(1, -1), destinations) + '}';
    i = j;
  }
  return out;
}

export function rtfToText(rtf: string): string {
  let out = stripRtfDestinations(rtf, ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'object']);
  out = out.replace(/\\\*/g, '').replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  out = out.replace(/\\u(-?\d+)\??/g, (_m, n: string) => {
    const code = Number(n);
    return String.fromCharCode(code < 0 ? code + 65536 : code);
  });
  // a space after a control word is only a delimiter — it must not reach the text
  out = out
    .replace(/\\par[d]?\s?/g, '\n')
    .replace(/\\line\s?/g, '\n')
    .replace(/\\tab\s?/g, '\t');
  out = out.replace(/\\[a-zA-Z]+-?\d*\s?/g, '');
  out = out.replace(/[{}]/g, '');
  return tidy(out);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** Decode a PDF literal string `(…)`, handling the standard escapes. */
export function decodePdfLiteral(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[++i];
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case '(':
      case ')':
      case '\\':
        out += next;
        break;
      case '\n':
        break; // line continuation
      default:
        if (next !== undefined && /[0-7]/.test(next)) {
          let oct = next;
          while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) oct += raw[++i];
          out += String.fromCharCode(Number.parseInt(oct, 8) & 0xff);
        } else if (next !== undefined) {
          out += next;
        }
    }
  }
  return out;
}

/**
 * A PDF hex string is a byte string, NOT UTF-16: `<486578>` is "Hex". Text
 * from a Unicode-aware producer starts with the FE FF byte-order mark, in
 * which case the rest is UTF-16BE.
 */
function decodePdfHex(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const byte = Number.parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16);
    if (Number.isFinite(byte)) bytes.push(byte);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      if (code) out += String.fromCharCode(code);
    }
    return out;
  }
  return Buffer.from(bytes).toString('latin1');
}

/**
 * Extract the text-showing operators from ONE decoded content stream.
 * Supported: `Tj`, `TJ`, `'` and `"` (which also start a new line), with
 * line breaks derived from `T*`, `Td`/`TD` (negative vertical move) and `ET`.
 */
export function pdfContentToText(content: string): string {
  let out = '';
  // H25: the TJ-array group used to be `((?:[^\[\]]|\\.)*)`. Both branches can
  // match a backslash, so a stream full of backslashes with no closing `]`
  // sent the engine into exponential backtracking (a "regex bomb" inside a
  // PDF froze the request thread). The branches are now DISJOINT — a
  // non-backslash character, or a backslash plus one — which makes the scan
  // linear, and the whole thing is capped below.
  const re = /\((?:\\.|[^\\()])*\)\s*(Tj|')|<([0-9a-fA-F\s]+)>\s*Tj|\[((?:[^\\\]]|\\.)*)\]\s*TJ|(T\*)|(Td|TD)|(ET)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] === 'Tj' || m[1] === "'") {
      const lit = /^\(([\s\S]*)\)\s*Tj?/.exec(m[0]);
      const raw = lit ? lit[1] : m[0].slice(1, m[0].lastIndexOf(')'));
      out += decodePdfLiteral(raw);
      if (m[1] === "'") out += '\n';
    } else if (m[2] !== undefined) {
      out += decodePdfHex(m[2]);
    } else if (m[3] !== undefined) {
      // an array: strings are shown, numbers adjust spacing; a big negative
      // adjustment means a visual word gap
      const parts = m[3].match(/\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>|-?\d+(?:\.\d+)?/g) ?? [];
      for (const part of parts) {
        if (part.startsWith('(')) out += decodePdfLiteral(part.slice(1, -1));
        else if (part.startsWith('<')) out += decodePdfHex(part.slice(1, -1));
        else if (Number(part) < -100) out += ' ';
      }
    } else if (m[4] || m[6]) {
      out += '\n';
    } else if (m[5]) {
      // Td/TD with a meaningful downward move starts a new line
      const nums = m[0].match(/-?\d+(?:\.\d+)?/g) ?? [];
      const ty = Number(nums[1] ?? '0');
      if (Math.abs(ty) > 0.5) out += '\n';
    }
  }
  return out;
}

function inflateMaybe(data: Buffer): Buffer | null {
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      return fn(data, { maxOutputLength: MAX_UNCOMPRESSED_ENTRY });
    } catch {
      /* try the next variant */
    }
  }
  return null;
}

function extractPdf(buffer: Buffer): ExtractedDocument {
  const latin = buffer.toString('latin1');
  const warnings: string[] = [];
  const pages = (latin.match(/\/Type\s*\/Page[^s]/g) ?? []).length;

  let text = '';
  let streams = 0;
  let decodedStreams = 0;
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(latin)) !== null && streams < MAX_PDF_STREAMS) {
    streams++;
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    // the dictionary sits right before `stream`
    const dictStart = Math.max(0, latin.lastIndexOf('<<', m.index));
    const dict = latin.slice(dictStart, m.index);
    const raw = buffer.subarray(start, end);
    let content: string | null = null;
    if (/FlateDecode/.test(dict)) {
      const inflated = inflateMaybe(raw);
      if (inflated) {
        decodedStreams++;
        content = inflated.toString('latin1');
      }
    } else if (!/\/Filter/.test(dict)) {
      decodedStreams++;
      content = raw.toString('latin1');
    }
    if (!content) continue;
    // only keep streams that actually draw text
    if (!/\bTj\b|\bTJ\b|\bTd\b|\bT\*\b/.test(content)) continue;
    const piece = pdfContentToText(content);
    if (piece.trim()) text += piece + '\n';
  }

  text = tidy(text);
  if (!text) {
    warnings.push(
      'No selectable text was found in this PDF. It is most likely a scan or an image-only export — ' +
        'OCR is needed, and Studio cannot read it yet.'
    );
  } else if (decodedStreams < Math.max(1, Math.floor(streams / 4))) {
    warnings.push('Only part of the PDF content could be decoded (unsupported compression or fonts).');
  }
  return { kind: 'pdf', text: capOutput(text, warnings), units: pages, warnings };
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

function extractEpub(buffer: Buffer): ExtractedDocument {
  const entries = readPicked(buffer, (n) => /\.x?html?$/i.test(n));
  const warnings: string[] = [];
  const parts: string[] = [];
  for (const [name, data] of entries) {
    const html = data.toString('utf8');
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    const clean = tidy(decodeXmlEntities(text));
    if (clean) parts.push(`--- ${name} ---\n${clean}`);
  }
  if (!parts.length) warnings.push('No readable chapters were found in this EPUB.');
  return { kind: 'epub', text: capOutput(tidy(parts.join('\n\n')), warnings), units: parts.length, warnings };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Extract the text of a document.
 *
 * @param buffer the file content
 * @param ext    the file extension (with dot). When omitted the format is
 *               sniffed from the magic bytes.
 */
export function extractDocumentText(buffer: Buffer, ext?: string): ExtractedDocument {
  const kind = ext ? detectDocumentKind(ext) : sniffKind(buffer);
  if (!kind) {
    throw new DocumentError(`Unsupported document type${ext ? ` "${ext}"` : ''}`);
  }
  if (kind === 'text' || kind === 'csv') {
    const warnings: string[] = [];
    return { kind, text: capOutput(tidy(buffer.toString('utf8')), warnings), units: 0, warnings };
  }
  if (kind === 'pdf') {
    if (!buffer.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      throw new DocumentError('This file does not look like a PDF (missing %PDF header)');
    }
    return extractPdf(buffer);
  }
  if (kind === 'rtf') return { kind, text: capOutput(rtfToText(buffer.toString('latin1')), []), units: 0, warnings: [] };

  if (kind === 'docx') {
    const entries = readPicked(buffer, (n) => n === 'word/document.xml');
    const xml = entries.get('word/document.xml')?.toString('utf8');
    if (!xml) throw new DocumentError('word/document.xml is missing — not a valid .docx file');
    const warnings: string[] = [];
    const text = extractDocxXml(xml);
    if (!text) warnings.push('The document contains no extractable text (it may be image-only).');
    return { kind, text: capOutput(text, warnings), units: 0, warnings };
  }

  if (kind === 'xlsx') {
    const entries = readPicked(
      buffer,
      (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
    );
    const warnings: string[] = [];
    const shared = entries.get('xl/sharedStrings.xml')?.toString('utf8');
    const sharedStrings = shared ? parseSharedStrings(shared) : [];
    const names = sheetNames(entries.get('xl/workbook.xml')?.toString('utf8') ?? '');
    const sheetFiles = Array.from(entries.keys())
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(/sheet(\d+)\.xml$/.exec(a)?.[1] ?? 0);
        const nb = Number(/sheet(\d+)\.xml$/.exec(b)?.[1] ?? 0);
        return na - nb;
      });
    if (!sheetFiles.length) throw new DocumentError('No worksheets were found in this .xlsx file');
    const sheets: Sheet[] = sheetFiles.map((file, i) => ({
      name: names[i] ?? `Sheet${i + 1}`,
      rows: parseSheetXml(entries.get(file)!.toString('utf8'), sharedStrings),
    }));
    const text = tidy(sheetsToText(sheets));
    if (!text) warnings.push('The workbook contains no extractable cell values.');
    return { kind, text: capOutput(text, warnings), units: sheets.length, warnings };
  }

  if (kind === 'pptx') return extractPptx(buffer);
  if (kind === 'odt' || kind === 'ods') return extractOdf(buffer, kind);
  if (kind === 'epub') return extractEpub(buffer);

  throw new DocumentError(`Unsupported document type "${kind}"`);
}

/** Magic-byte sniffing for files whose extension lies. */
export function sniffKind(buffer: Buffer): DocumentKind | null {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer.subarray(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  if (buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    // a zip: look at the entry names to tell the office flavours apart
    try {
      const names = readZipDirectory(buffer).map((e) => e.name);
      if (names.some((n) => n === 'word/document.xml')) return 'docx';
      if (names.some((n) => n.startsWith('xl/worksheets/'))) return 'xlsx';
      if (names.some((n) => n.startsWith('ppt/slides/'))) return 'pptx';
      if (names.some((n) => n === 'mimetype') && names.some((n) => n === 'content.xml')) return 'odt';
      if (names.some((n) => n === 'META-INF/container.xml')) return 'epub';
    } catch {
      return null;
    }
  }
  return null;
}
