// documents.test.ts — the dependency-free document extractor.
//
// Every fixture is built in memory (a tiny zip writer + hand-written PDF
// content streams), so the suite proves the real parsing paths without
// committing binary blobs to the repository.

import { describe, expect, test } from 'bun:test';
import zlib from 'zlib';
import {
  decodePdfLiteral,
  decodeXmlEntities,
  detectDocumentKind,
  DocumentError,
  extractDocxXml,
  extractDocumentText,
  isExtractableExtension,
  parseSheetXml,
  pdfContentToText,
  readZipDirectory,
  rtfToText,
  sniffKind,
} from '../src/lib/agentic/documents';

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------

interface Entry {
  name: string;
  data: Buffer | string;
  deflate?: boolean;
}

/** Build a valid zip archive (local headers + central directory + EOCD). */
function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const payload = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const crc = (() => {
      let c = ~0;
      for (const byte of raw) {
        c ^= byte;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      return ~c >>> 0;
    })();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function makePdf(objects: string[]): Buffer {
  // a minimal but structurally valid PDF; `objects` are the raw object bodies
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const flushDeflate = (text: string) => zlib.deflateSync(Buffer.from(text, 'latin1'));

// ---------------------------------------------------------------------------
// helpers and text formats
// ---------------------------------------------------------------------------

describe('document helpers', () => {
  test('extensions are classified', () => {
    expect(isExtractableExtension('.PDF')).toBe(true);
    expect(isExtractableExtension('.docx')).toBe(true);
    expect(isExtractableExtension('.exe')).toBe(false);
    expect(detectDocumentKind('.XLSX')).toBe('xlsx');
    expect(detectDocumentKind('.png')).toBeNull();
  });

  test('XML entities are decoded, including numeric ones', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &#65; &#x42; &unknown;')).toBe('a & b <c> A B &unknown;');
  });

  test('RTF control words are stripped and escapes decoded', () => {
    const rtf = '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello\\par World\\tab done\\u8364?}';
    expect(rtfToText(rtf)).toBe('Hello\nWorld\tdone€');
  });

  test('a plain text document round-trips', () => {
    const out = extractDocumentText(Buffer.from('hello\n\n\nworld  '), '.txt');
    expect(out.text).toBe('hello\n\nworld');
    expect(out.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

describe('PDF extraction', () => {
  test('literal strings with escapes are decoded', () => {
    expect(decodePdfLiteral('a\\(b\\)c\\\\d\\n\\101')).toBe('a(b)c\\d\nA');
  });

  test('Tj / TJ / hex strings produce text and line breaks', () => {
    const content = [
      'BT /F1 12 Tf 72 720 Td (Hello) Tj',
      '0 -14 Td (World) Tj',
      '[(Kerned) -300 (Text)] TJ',
      '<486578> Tj',
      'ET',
    ].join('\n');
    const text = pdfContentToText(content);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
    expect(text).toContain('Kerned');
    expect(text).toContain('Text');
    expect(text).toContain('Hex');
    expect(text).toContain('\n');
  });

  test('an uncompressed PDF stream is read end to end', () => {
    const content = 'BT /F1 12 Tf 72 720 Td (Invoice 42) Tj ET';
    const pdf = makePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]);
    const out = extractDocumentText(pdf, '.pdf');
    expect(out.kind).toBe('pdf');
    expect(out.text).toContain('Invoice 42');
    expect(out.units).toBe(1);
    expect(out.warnings).toEqual([]);
  });

  test('a FlateDecode stream is inflated before parsing', () => {
    const content = 'BT /F1 12 Tf 72 720 Td (Compressed body) Tj ET';
    const packed = flushDeflate(content);
    const pdf = makePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [] >>',
      `<< /Length ${packed.length} /Filter /FlateDecode >>\nstream\n${packed.toString('latin1')}\nendstream`,
    ]);
    const out = extractDocumentText(pdf, '.pdf');
    expect(out.text).toContain('Compressed body');
  });

  test('an image-only PDF is honest about needing OCR', () => {
    const pdf = makePdf(['<< /Type /Catalog >>', '<< /Length 4 >>\nstream\nxxxx\nendstream']);
    const out = extractDocumentText(pdf, '.pdf');
    expect(out.text).toBe('');
    expect(out.warnings.join(' ')).toMatch(/OCR/);
  });

  test('a non-PDF byte stream is rejected', () => {
    expect(() => extractDocumentText(Buffer.from('not a pdf at all'), '.pdf')).toThrow(DocumentError);
  });
});

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

describe('DOCX extraction', () => {
  const documentXml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Meeting notes</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Budget &amp; scope</w:t></w:r><w:r><w:tab/><w:t>Q3</w:t></w:r></w:p>
    <w:p><w:r><w:t>Next steps</w:t></w:r></w:p>
  </w:body>
</w:document>`;

  test('paragraphs become lines and entities are decoded', () => {
    const text = extractDocxXml(documentXml);
    expect(text.split('\n')).toEqual(['Meeting notes', 'Budget & scope\tQ3', 'Next steps']);
  });

  test('a docx zip is detected by content and extracted', () => {
    const docx = makeZip([
      { name: 'word/document.xml', data: documentXml, deflate: true },
      { name: '[Content_Types].xml', data: '<Types/>' },
    ]);
    expect(sniffKind(docx)).toBe('docx');
    const out = extractDocumentText(docx, '.docx');
    expect(out.text).toContain('Meeting notes');
    expect(out.text).toContain('Next steps');
  });

  test('a docx without document.xml is rejected clearly', () => {
    const broken = makeZip([{ name: 'word/other.xml', data: '<x/>' }]);
    expect(() => extractDocumentText(broken, '.docx')).toThrow(/word\/document\.xml/);
  });
});

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

describe('XLSX extraction', () => {
  const sharedStrings = `<sst><si><t>Name</t></si><si><t>Amount</t></si><si><t>Rent &amp; bills</t></si></sst>`;
  const sheet = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>
    <row r="3"><c r="C3" t="inlineStr"><is><t>note</t></is></c></row>
  </sheetData></worksheet>`;

  test('shared strings and numbers are resolved into rows', () => {
    const rows = parseSheetXml(sheet, ['Name', 'Amount', 'Rent & bills']);
    expect(rows[0]).toEqual(['Name', 'Amount']);
    expect(rows[1]).toEqual(['Rent & bills', '1200']);
    expect(rows[2][2]).toBe('note');
  });

  test('a workbook zip is detected and every sheet is labelled', () => {
    const xlsx = makeZip([
      { name: 'xl/sharedStrings.xml', data: sharedStrings, deflate: true },
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Budget" sheetId="1"/></sheets></workbook>' },
      { name: 'xl/worksheets/sheet1.xml', data: sheet, deflate: true },
    ]);
    expect(sniffKind(xlsx)).toBe('xlsx');
    const out = extractDocumentText(xlsx, '.xlsx');
    expect(out.units).toBe(1);
    expect(out.text).toContain('### Sheet: Budget');
    expect(out.text).toContain('Rent & bills\t1200');
  });
});

// ---------------------------------------------------------------------------
// PPTX / ODT / EPUB
// ---------------------------------------------------------------------------

describe('PPTX extraction', () => {
  test('slides are extracted in numeric order', () => {
    const pptx = makeZip([
      { name: 'ppt/slides/slide1.xml', data: '<p:sld><a:t>Intro slide</a:t></p:sld>', deflate: true },
      { name: 'ppt/slides/slide2.xml', data: '<p:sld><a:t>Roadmap</a:t><a:t>Q4 goals</a:t></p:sld>', deflate: true },
    ]);
    expect(sniffKind(pptx)).toBe('pptx');
    const out = extractDocumentText(pptx, '.pptx');
    expect(out.units).toBe(2);
    expect(out.text.indexOf('Intro slide')).toBeLessThan(out.text.indexOf('Roadmap'));
    expect(out.text).toContain('Q4 goals');
  });
});

describe('ODT / EPUB extraction', () => {
  test('OpenDocument paragraphs and tables are flattened', () => {
    const odt = makeZip([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text' },
      {
        name: 'content.xml',
        data: '<office:body><text:h>Title</text:h><text:p>Body text</text:p><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell></table:table-row></office:body>',
        deflate: true,
      },
    ]);
    const out = extractDocumentText(odt, '.odt');
    expect(out.text).toContain('Title');
    expect(out.text).toContain('Body text');
    expect(out.text).toContain('A');
  });

  test('EPUB chapters are extracted and scripts dropped', () => {
    const epub = makeZip([
      { name: 'META-INF/container.xml', data: '<container/>' },
      { name: 'mimetype', data: 'application/epub+zip' },
      {
        name: 'OEBPS/ch1.xhtml',
        data: '<html><body><h1>Chapter one</h1><script>alert(1)</script><p>Real text</p></body></html>',
        deflate: true,
      },
    ]);
    const out = extractDocumentText(epub, '.epub');
    expect(out.text).toContain('Chapter one');
    expect(out.text).toContain('Real text');
    expect(out.text).not.toContain('alert(1)');
  });
});

// ---------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------

describe('document robustness', () => {
  test('a non-zip buffer is rejected by the zip reader', () => {
    expect(() => readZipDirectory(Buffer.from('definitely not a zip'))).toThrow(DocumentError);
  });

  test('an unknown extension is rejected', () => {
    expect(() => extractDocumentText(Buffer.from('x'), '.exe')).toThrow(DocumentError);
  });

  test('a huge zip entry is refused (zip-bomb guard)', () => {
    const dir = readZipDirectory(makeZip([{ name: 'a.xml', data: 'small' }]));
    expect(dir).toHaveLength(1);
    dir[0].uncompressedSize = 512 * 1024 * 1024;
    const zip = makeZip([{ name: 'a.xml', data: 'small' }]);
    expect(() => extractDocumentText(zip, '.docx')).toThrow(DocumentError);
  });
});

// ---------------------------------------------------------------------------
// knowledge base integration (real workspace + real database rows)
// ---------------------------------------------------------------------------

describe('knowledge import of office documents', () => {
  const TASK = 'test-doc-import';

  const docxZip = () =>
    makeZip([
      {
        name: 'word/document.xml',
        data:
          '<w:document><w:body><w:p><w:r><w:t>Invoice for October</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Total 4,500 rupees</w:t></w:r></w:p></w:body></w:document>',
        deflate: true,
      },
    ]);

  test('a .docx in the workspace is indexed and searchable', async () => {
    const { createWorkspace } = await import('../src/lib/agentic/workspace');
    const { importDocument, searchKnowledge, deleteDocument } = await import('../src/lib/agentic/knowledge');
    await createWorkspace(TASK);
    const { writeFile } = await import('fs/promises');
    const { taskWorkspace } = await import('../src/lib/agentic/workspace');
    await writeFile(`${taskWorkspace(TASK)}/invoice.docx`, docxZip());

    const doc = await importDocument({ path: 'invoice.docx', taskId: TASK });
    expect(doc.status).toBe('indexed');
    expect(doc.chunkCount).toBeGreaterThan(0);
    expect(doc.mime).toContain('wordprocessingml');

    const hits = await searchKnowledge('invoice total', { taskId: TASK });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain('Invoice for October');
    await deleteDocument(doc.id);
  });

  test('an unreadable document is stored as unsupported with the reason', async () => {
    const { taskWorkspace } = await import('../src/lib/agentic/workspace');
    const { importDocument, deleteDocument } = await import('../src/lib/agentic/knowledge');
    const { writeFile } = await import('fs/promises');
    // a declared .docx that is not a zip at all
    await writeFile(`${taskWorkspace(TASK)}/broken.docx`, Buffer.from('this is not a zip'));

    const doc = await importDocument({ path: 'broken.docx', taskId: TASK });
    expect(doc.status).toBe('unsupported');
    expect(doc.error.length).toBeGreaterThan(0);
    await deleteDocument(doc.id);
  });

  test('an image is still refused', async () => {
    const { taskWorkspace } = await import('../src/lib/agentic/workspace');
    const { importDocument, deleteDocument } = await import('../src/lib/agentic/knowledge');
    const { writeFile } = await import('fs/promises');
    await writeFile(`${taskWorkspace(TASK)}/photo.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));

    const doc = await importDocument({ path: 'photo.png', taskId: TASK });
    expect(doc.status).toBe('unsupported');
    expect(doc.error).toContain('Unsupported file type');
    await deleteDocument(doc.id);
  });
});
