import { describe, it, expect } from 'vitest';
import { buildWorkbook, buildWorkbookAsync, columnLetter } from '../../utils/xlsxWriter.js';

// Reads back the store-only ZIP parts.
function parts(buf) {
  const eocd = buf.length - 22;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    out[name] = buf.subarray(start, start + size).toString('utf8');
    p += 46 + nlen;
  }
  return out;
}

const COLUMNS = [
  { header: 'Name', key: 'name', width: 20 },
  { header: 'Count', key: 'n', type: 'int' },
  { header: 'Rate', key: 'rate', type: 'percent' },
  { header: 'When (UTC)', key: 'at', type: 'datetime' },
  { header: 'Length', key: 'secs', type: 'duration' },
];

describe('xlsxWriter', () => {
  it('column letters', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });
  it('writes every required part, one per worksheet', () => {
    const p = parts(buildWorkbook([{ name: 'Summary', title: 'T', items: [] }, { name: 'Data', columns: COLUMNS, rows: [] }]));
    expect(Object.keys(p).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
      'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].sort());
    expect(p['xl/workbook.xml']).toMatch(/name="Summary".*name="Data"/);
  });
  it('table sheets have a frozen header and an auto-filter over all rows', () => {
    const x = parts(buildWorkbook([{ name: 'D', columns: COLUMNS, rows: [{ name: 'a' }, { name: 'b' }] }]))['xl/worksheets/sheet1.xml'];
    expect(x).toContain('<pane ySplit="1"');
    expect(x).toContain('state="frozen"');
    expect(x).toContain('<autoFilter ref="A1:E3"/>');
    expect(x).toContain('<col min="1" max="1" width="20"');
  });
  it('real numbers, percentages, dates and durations; a real 0 stays 0', () => {
    const x = parts(buildWorkbook([{ name: 'D', columns: COLUMNS, rows: [{ name: 'a', n: 0, rate: 0.5, at: '2026-01-01T12:00:00Z', secs: 3600 }] }]))['xl/worksheets/sheet1.xml'];
    expect(x).toContain('<c r="B2" s="3"><v>0</v></c>');
    expect(x).toContain('<c r="C2" s="4"><v>0.5</v></c>');
    expect(x).toContain('<c r="D2" s="2"><v>46023.5</v></c>');      // 2026-01-01 12:00
    expect(x).toMatch(/<c r="E2" s="8"><v>0\.0416/);
  });
  it('missing data is labelled, never a zero', () => {
    const x = parts(buildWorkbook([{ name: 'D', columns: [...COLUMNS, { header: 'Ended', key: 'end', type: 'datetime', empty: 'In progress' }],
      rows: [{ name: 'a', n: null, rate: undefined, at: 'not a date', secs: null, end: null }] }]))['xl/worksheets/sheet1.xml'];
    expect(x.match(/Not recorded/g)).toHaveLength(4);
    expect(x).toContain('In progress');
    expect(x).not.toMatch(/<v>0<\/v>/);
  });
  it('text can never run as a formula or break the XML', () => {
    const x = parts(buildWorkbook([{ name: 'D', columns: COLUMNS, rows: [{ name: '=CMD()<script>&"\u0007' }] }]))['xl/worksheets/sheet1.xml'];
    expect(x).toContain('t="inlineStr"');
    expect(x).not.toContain('<f>');
    expect(x).toContain('=CMD()&lt;script&gt;&amp;&quot;');
    expect(x).not.toContain('\u0007');
  });
  it('sheet names follow the Excel rules and stay unique', () => {
    const p = parts(buildWorkbook([{ name: 'a/b:c*d?[e]\\', items: [] }, { name: 'x'.repeat(40), items: [] }, { name: 'x'.repeat(40), items: [] }]));
    const names = [...p['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map(m => m[1]);
    expect(names[0]).toBe('a b c d  e');
    expect(names[1]).toHaveLength(31);
    expect(names[2]).toMatch(/\(2\)$/);
    expect(names[2].length).toBeLessThanOrEqual(31);
  });
});

describe('large workbooks', () => {
  const cols = [{ header: 'A', key: 'a' }, { header: 'When', key: 'at', type: 'datetime' }, { header: 'N', key: 'n', type: 'int' }];
  it('the worker builds the same file content as the main thread', async () => {
    const at = new Date('2026-01-01T12:00:00Z');
    const rows = Array.from({ length: 2500 }, (_, i) => ({ a: `r${i}`, at, n: i }));
    const sheets = [{ name: 'S', title: 'T', items: [] }, { name: 'D', columns: cols, rows }];
    const viaWorker = parts(await buildWorkbookAsync(sheets));
    const direct = parts(buildWorkbook(sheets));
    expect(viaWorker).toEqual(direct);
    expect(viaWorker['xl/worksheets/sheet2.xml']).toContain('<autoFilter ref="A1:C2501"/>');
  });
  it('small workbooks stay on the fast path', async () => {
    const file = await buildWorkbookAsync([{ name: 'D', columns: cols, rows: [{ a: 'x' }] }]);
    expect(parts(file)['xl/worksheets/sheet1.xml']).toContain('x');
  });
});
