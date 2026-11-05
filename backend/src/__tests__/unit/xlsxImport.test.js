/**
 * Spreadsheet import building blocks (no database):
 *   zipStore.readZip · xlsxReader.readXlsx / plainNumber / columnIndex · tabularFile.readTabularFile
 *   · xlsxWriter template options (and unchanged output without them).
 */
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'zlib';
import { readZip, ZipReadError, crc32, buildStoredZip } from '../../utils/zipStore.js';
import { readXlsx, XlsxReadError, plainNumber, columnIndex } from '../../utils/xlsxReader.js';
import { readTabularFile, TabularFileError } from '../../utils/tabularFile.js';
import { buildWorkbook } from '../../utils/xlsxWriter.js';

// ZIP builder with per-part overrides (deflated by default).
function zipOf(parts, { sizes = {}, crcs = {}, flags = {}, methods = {}, entryCount } = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const method = methods[name] ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const nb = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800 | (flags[name] ?? 0), 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crcs[name] ?? crc32(data), 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(sizes[name] ?? data.length, 22); lh.writeUInt16LE(nb.length, 26);
    local.push(lh, nb, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800 | (flags[name] ?? 0), 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crcs[name] ?? crc32(data), 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(sizes[name] ?? data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  const n = entryCount ?? parts.length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// Minimal workbook with given sheet XML(s) and optional shared strings.
function xlsx(sheets, { sst = null, extraRels = '' } = {}) {
  const list = Array.isArray(sheets) ? sheets : [{ name: 'Sheet1', xml: sheets }];
  return zipOf([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'],
    ['_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0"?><workbook ${NS} xmlns:r="${REL}"><sheets>${list.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      list.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="${s.target ?? `worksheets/sheet${i + 1}.xml`}"${s.external ? ' TargetMode="External"' : ''}/>`).join('')
    }${sst !== null ? `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` : ''}${extraRels}</Relationships>`],
    ...list.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml]),
    ...(sst !== null ? [['xl/sharedStrings.xml', `<?xml version="1.0"?><sst ${NS}>${sst}</sst>`]] : []),
  ]);
}
const sheet = (rowsXml) => `<?xml version="1.0"?><worksheet ${NS}><sheetData>${rowsXml}</sheetData></worksheet>`;
const values = (file, opts) => readXlsx(file, opts).rows.map((r) => r.values);

describe('zipStore.readZip', () => {
  const parts = [['a.txt', 'hello'], ['dir/b.txt', 'x'.repeat(1000)]];

  it('reads stored and deflated entries', () => {
    const z = readZip(zipOf(parts));
    expect(z.names).toEqual(['a.txt', 'dir/b.txt']);
    expect(z.read('dir/b.txt').toString()).toBe('x'.repeat(1000));
    expect(readZip(buildStoredZip([{ name: 'c.txt', data: Buffer.from('stored') }])).read('c.txt').toString()).toBe('stored');
    expect(z.read('missing')).toBeNull();
  });

  it('enforces the entry count, per-entry and total size limits before inflating', () => {
    const limit = (fn, re) => { let e; try { fn(); } catch (x) { e = x; } expect(e).toBeInstanceOf(ZipReadError); expect(e.code).toBe('ZIP_LIMIT'); expect(e.message).toMatch(re); };
    limit(() => readZip(zipOf(parts), { maxEntries: 1 }), /more than 1 parts/);
    limit(() => readZip(zipOf(parts, { sizes: { 'a.txt': 70 * 1024 * 1024 } })), /larger than 64 MB/);
    limit(() => readZip(zipOf([['a', 'a'], ['b', 'b'], ['c', 'c']], { sizes: { a: 60e6, b: 60e6, c: 60e6 } })), /larger than 128 MB/);
  });

  it('refuses a part that inflates beyond its declared size (zip bomb), corrupt data and checksum mismatches', () => {
    const bomb = readZip(zipOf([['z', Buffer.alloc(5 * 1024 * 1024)]], { sizes: { z: 100 } }));
    expect(() => bomb.read('z')).toThrow(/larger than declared/);
    expect(() => readZip(zipOf([['a', 'abc']], { crcs: { a: 1 } })).read('a')).toThrow(/corrupt/);
  });

  it('refuses encryption, unknown methods, unsafe or duplicate names, ZIP64 and non-ZIP data', () => {
    const bad = (buf, re) => { expect(() => readZip(buf)).toThrow(re); };
    bad(zipOf([['a', 'a']], { flags: { a: 1 } }), /Encrypted/);
    bad(zipOf([['a', 'a']], { methods: { a: 14 } }), /unsupported compression method/);
    for (const name of ['../x', '/abs', 'a\\b', 'C:/x', 'a//b', 'a/./b', 'a/../b']) bad(zipOf([[name, 'x']]), /unsafe file path/);
    bad(zipOf([['a', '1'], ['a', '2']]), /same part twice/);
    bad(zipOf([['a', 'a']], { entryCount: 0xFFFF }), /ZIP64|Multi-part|not a valid/);
    bad(Buffer.from('plain text'), /not a valid ZIP archive/);
    bad(Buffer.alloc(0), /not a valid ZIP archive/);
  });
});

describe('xlsxReader helpers', () => {
  it('plainNumber writes plain decimal text, never scientific notation', () => {
    expect(plainNumber('966501234567')).toBe('966501234567');
    expect(plainNumber('9.66501234567E+11')).toBe('966501234567');
    expect(plainNumber('1.2345678901234567E+19')).toBe('12345678901234567000');
    expect(plainNumber('1E-3')).toBe('0.001');
    expect(plainNumber('1.50')).toBe('1.5');
    expect(plainNumber('-0')).toBe('0');
    expect(plainNumber('-2.5')).toBe('-2.5');
    expect(plainNumber('.5')).toBe('0.5');
    expect(plainNumber('abc')).toBe('abc');
  });
  it('columnIndex converts cell references', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('J7')).toBe(9);
    expect(columnIndex('AA10')).toBe(26);
    expect(columnIndex('1')).toBe(-1);
  });
});

describe('xlsxReader.readXlsx', () => {
  it('reads shared strings (rich text, without phonetic runs), inline strings, numbers and booleans', () => {
    const sst = '<si><t>head</t></si><si><r><t>Ab</t></r><r><rPr><b/></rPr><t xml:space="preserve">c </t></r><rPh sb="0" eb="1"><t>XYZ</t></rPh></si>';
    const file = xlsx(sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>in</t></is></c><c r="C2"><v>966501234567</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="b"><v>0</v></c></row>'), { sst });
    expect(values(file)).toEqual([['head'], ['Abc ', 'in', '966501234567', 'true', 'false']]);
  });

  it('decodes entities, numeric references, _xHHHH_ escapes and CDATA', () => {
    const file = xlsx(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>&amp;&lt;&#65;&#x42;a_x000D_b</t></is></c><c r="B1" t="inlineStr"><is><t><![CDATA[<raw>&amp;]]></t></is></c></row>'));
    expect(values(file)).toEqual([['&<ABa\rb', '<raw>&amp;']]);
    expect(() => readXlsx(xlsx(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>&nbsp;</t></is></c></row>')))).toThrow(XlsxReadError);
  });

  it('accepts namespace prefixes and cells / rows without references', () => {
    const file = xlsx(`<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>
      <x:row><x:c t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>b</x:t></x:is></x:c></x:row>
      <x:row><x:c r="B2" t="inlineStr"><x:is><x:t>c</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`);
    expect(readXlsx(file).rows.map((r) => [r.row, r.values])).toEqual([[1, ['a', 'b']], [2, ['', 'c']]]);
  });

  it('reports formula and error cells without evaluating them; skips empty rows and far-right columns', () => {
    const file = xlsx(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row><row r="2"></row><row r="3"><c r="A3" s="1"/></row>'
      + '<row r="4"><c r="A4"><f>1+1</f><v>2</v></c><c r="B4" t="e"><v>#REF!</v></c><c r="BA4" t="inlineStr"><is><t>far</t></is></c></row>'));
    const rows = readXlsx(file).rows;
    expect(rows.map((r) => r.row)).toEqual([1, 4]);
    expect(rows[1]).toMatchObject({ values: ['', ''], formulas: [0], errors: [1] });
  });

  it('prefers the named worksheet, otherwise the first; ignores external relationships', () => {
    const one = sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>');
    const two = sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>second</t></is></c></row>');
    const file = xlsx([{ name: 'Notes', xml: one }, { name: 'Emergency Contacts', xml: two }]);
    expect(values(file, { sheetName: 'emergency contacts' })).toEqual([['second']]);
    expect(values(file, { sheetName: 'Other' })).toEqual([['first']]);
    expect(() => readXlsx(xlsx([{ name: 'X', xml: one, external: true }]))).toThrow(/no worksheet/);
  });

  it('enforces the data-row limit and rejects malformed or hostile XML', () => {
    const rows = Array.from({ length: 6 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    expect(() => readXlsx(xlsx(sheet(rows)), { maxDataRows: 4 })).toThrow(/more than 4 data rows/);
    expect(readXlsx(xlsx(sheet(rows)), { maxDataRows: 5 }).rows).toHaveLength(6);
    expect(() => readXlsx(xlsx(sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>')))).toThrow(XlsxReadError);       // no shared strings
    expect(() => readXlsx(xlsx(`<!DOCTYPE w [<!ENTITY e "x">]>${sheet('')}`))).toThrow(/document type declaration/);
    expect(() => readXlsx(xlsx([{ name: 'S', xml: sheet(''), target: '../../../etc/passwd' }]))).toThrow(XlsxReadError);
    expect(() => readXlsx(xlsx(sheet('<row r="1"><c r="A1"><v>1</v></c>')))).toThrow(XlsxReadError);                     // no </row>
    expect(() => readXlsx(zipOf([['a.txt', 'x']]))).toThrow(XlsxReadError);
  });
});

describe('tabularFile.readTabularFile', () => {
  const csv = (text, opts) => readTabularFile(Buffer.from(text, 'utf8'), { filename: 'f.csv', ...opts });

  it('numbers CSV rows as a spreadsheet does (blank lines kept, multi-line values in one row), trims values', () => {
    const t = csv('\uFEFFa,b\r\n 1 , 2 \r\n\r\n"x\ny",5\r\n,\r\n7,8,9\r\n');
    expect(t.format).toBe('csv');
    expect(t.header).toEqual({ row: 1, values: ['a', 'b'] });
    expect(t.rows.map((r) => [r.row, r.values])).toEqual([[2, ['1', '2']], [4, ['x\ny', '5']], [6, ['7', '8', '9']]]);
  });

  it('enforces the row limit (413) and refuses empty, binary, legacy and mismatched files (400)', () => {
    const err = (fn) => { try { fn(); } catch (e) { return e; } return null; };
    const over = err(() => csv('h\n1\n2\n3\n', { maxDataRows: 2 }));
    expect(over).toBeInstanceOf(TabularFileError);
    expect(over.status).toBe(413);
    expect(csv('h\n1\n2\n', { maxDataRows: 2 }).rows).toHaveLength(2);
    expect(err(() => readTabularFile(Buffer.alloc(0), { filename: 'f.csv' })).message).toMatch(/empty/);
    expect(err(() => readTabularFile(Buffer.from([0x61, 0, 0x62]), { filename: 'f.csv' })).message).toMatch(/not supported/);
    expect(err(() => readTabularFile(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), {})).message).toMatch(/old Excel/);
    expect(err(() => readTabularFile(Buffer.from('a,b'), { filename: 'f.xls' })).message).toMatch(/\.xls are not supported/);
    expect(err(() => readTabularFile(Buffer.from('a,b'), { filename: 'f.xlsx' })).message).toMatch(/named \.xlsx/);
    expect(err(() => readTabularFile(zipOf([['a', 'a']]), { filename: 'f.csv' })).message).toMatch(/named \.csv/);
  });

  it('reads a workbook the same way (format detected from content when there is no extension)', () => {
    const file = xlsx(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t> h </t></is></c></row><row r="3"><c r="A3"><v>12</v></c></row>'));
    const t = readTabularFile(file, { filename: 'noext' });
    expect(t).toMatchObject({ format: 'xlsx', header: { row: 1, values: ['h'] } });
    expect(t.rows.map((r) => [r.row, r.values])).toEqual([[3, ['12']]]);
  });
});

describe('xlsxWriter template options', () => {
  const read = (file, name) => readZip(file).read(name).toString();

  it('without the new options the output is the same as before (no text style, validations or ignored errors)', () => {
    const file = buildWorkbook([{ name: 'R', columns: [{ header: 'h', key: 'k' }], rows: [{ k: null }, { k: 'v' }] }]);
    expect(read(file, 'xl/styles.xml')).toContain('<cellXfs count="10">');
    expect(read(file, 'xl/styles.xml')).not.toContain('numFmtId="49"');
    const s = read(file, 'xl/worksheets/sheet1.xml');
    expect(s).toContain('Not recorded');
    expect(s).not.toMatch(/style="|dataValidation|ignoredError/);
  });

  it('text columns, blank cells, drop-down lists and ignored errors', () => {
    const file = buildWorkbook([{
      name: 'T',
      columns: [{ header: 'a', key: 'a', empty: null }, { header: 'm', key: 'm', format: 'text', width: 18, empty: null }],
      rows: [{ a: '', m: '007' }],
      validations: [{ sqref: 'A2:A9', list: ['true', 'false'], errorStyle: 'information', prompt: 'p & q' }],
      ignoredErrors: [{ sqref: 'B2:B9', numberStoredAsText: true }],
    }]);
    expect(read(file, 'xl/styles.xml')).toContain('<cellXfs count="11">');
    const s = read(file, 'xl/worksheets/sheet1.xml');
    expect(s).toContain('<col min="2" max="2" width="18" style="10" customWidth="1"/>');
    expect(s).toContain('<row r="2"><c r="B2" s="10" t="inlineStr"><is><t xml:space="preserve">007</t></is></c></row>');
    expect(s).toContain('errorStyle="information"');
    expect(s).toContain('prompt="p &amp; q"');
    expect(s).toContain('<formula1>&quot;true,false&quot;</formula1>');
    expect(s).toContain('<ignoredErrors><ignoredError sqref="B2:B9" numberStoredAsText="1"/></ignoredErrors>');
    expect(s.indexOf('<autoFilter')).toBeLessThan(s.indexOf('<dataValidations'));
    expect(s.indexOf('<dataValidations')).toBeLessThan(s.indexOf('<ignoredErrors'));
  });
});
