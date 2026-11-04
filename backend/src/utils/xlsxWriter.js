// ── Minimal Excel (.xlsx) writer ──────────────────────────────────────────────
//
// An .xlsx file is a ZIP of XML parts, so this reuses utils/zipStore.js and needs no
// dependency. It writes what business reports use: several worksheets, frozen header,
// auto-filter, column widths, and real date / number / percent / duration cells.
//
// Missing data is never written as 0: a null value becomes the column's `empty` text
// (default "Not recorded") in a muted style. Text uses inline strings, which Excel
// never evaluates as formulas. Times are written in UTC; say so in the column heading.

import { URL } from 'url';
import { Worker } from 'worker_threads';
import { buildStoredZip } from './zipStore.js';

const XF = { default: 0, header: 1, datetime: 2, int: 3, percent: 4, title: 5, label: 6, muted: 7, duration: 8, note: 9 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/><numFmt numFmtId="165" formatCode="0.0%"/><numFmt numFmtId="166" formatCode="[h]:mm:ss"/></numFmts>
<fonts count="5"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF7F7F7F"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
</styleSheet>`;

const escapeXml = (v) => String(v)
  // eslint-disable-next-line no-control-regex -- characters XML 1.0 cannot carry
  .replace(/[^\u0009\u000A\u000D -퟿-�]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function columnLetter(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const textCell = (ref, value, style) =>
  `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
const numberCell = (ref, value, style) => `<c r="${ref}" s="${style}"><v>${value}</v></c>`;

// Excel serial date: days since 1899-12-30.
const excelDate = (d) => d.getTime() / 86_400_000 + 25569;

function cell(ref, value, type, empty) {
  if (value === null || value === undefined || value === '') return textCell(ref, empty, XF.muted);
  switch (type) {
    case 'datetime': {
      const d = value instanceof Date ? value : new Date(value);
      return Number.isNaN(d.getTime()) ? textCell(ref, empty, XF.muted) : numberCell(ref, excelDate(d), XF.datetime);
    }
    case 'int':      return Number.isFinite(Number(value)) ? numberCell(ref, Number(value), XF.int) : textCell(ref, empty, XF.muted);
    case 'percent':  return Number.isFinite(Number(value)) ? numberCell(ref, Number(value), XF.percent) : textCell(ref, empty, XF.muted);
    case 'duration': return Number.isFinite(Number(value)) ? numberCell(ref, Number(value) / 86_400, XF.duration) : textCell(ref, empty, XF.muted);
    default:         return textCell(ref, value, XF.default);
  }
}

// Key/value worksheet: title, then label | value rows, then notes.
function summarySheetXml({ title, items = [], notes = [] }) {
  const rows = [];
  let r = 1;
  if (title) { rows.push(`<row r="${r}">${textCell(`A${r}`, title, XF.title)}</row>`); r += 2; }
  for (const it of items) {
    if (it.section) {
      r += 1;
      rows.push(`<row r="${r}">${textCell(`A${r}`, it.section, XF.label)}</row>`);
    } else {
      rows.push(`<row r="${r}">${textCell(`A${r}`, it.label, XF.default)}${cell(`B${r}`, it.value, it.type, it.empty ?? 'Not recorded')}</row>`);
    }
    r += 1;
  }
  if (notes.length) {
    r += 1;
    rows.push(`<row r="${r}">${textCell(`A${r}`, 'Notes', XF.label)}</row>`);
    r += 1;
    for (const n of notes) {
      rows.push(`<row r="${r}">${textCell(`A${r}`, n, XF.muted)}</row>`);
      r += 1;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><cols><col min="1" max="1" width="38" customWidth="1"/><col min="2" max="2" width="44" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

// Table worksheet: frozen header row + auto-filter.
function tableSheetXml({ columns, rows }) {
  const last = columnLetter(columns.length - 1);
  const header = columns.map((c, i) => textCell(`${columnLetter(i)}1`, c.header, XF.header)).join('');
  const body = rows.map((row, idx) => {
    const r = idx + 2;
    const cells = columns.map((c, i) => cell(`${columnLetter(i)}${r}`, row[c.key], c.type, c.empty ?? 'Not recorded')).join('');
    return `<row r="${r}">${cells}</row>`;
  }).join('');
  const widths = columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 16}" customWidth="1"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews><cols>${widths}</cols><sheetData><row r="1" ht="30" customHeight="1">${header}</row>${body}</sheetData><autoFilter ref="A1:${last}${rows.length + 1}"/></worksheet>`;
}

// Excel forbids these characters and more than 31 characters; names must be unique.
function sheetNames(sheets) {
  const used = new Set();
  return sheets.map((s) => {
    const base = (String(s.name).replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 27)} (${n})`;
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * @param sheets [{ name, title, items, notes }]   summary sheet, or
 *               [{ name, columns: [{ header, key, type, width, empty }], rows }]  table sheet
 *               type: 'text' (default) | 'int' | 'percent' (0–1) | 'datetime' | 'duration' (seconds)
 * @returns Buffer  an .xlsx file
 */
export function buildWorkbook(sheets) {
  const names = sheetNames(sheets);
  const entries = [
    { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
    { name: '_rels/.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>${
      sheets.some((s) => s.columns) ? `<definedNames>${sheets.map((s, i) => (s.columns
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${escapeXml(names[i].replace(/'/g, "''"))}'!$A$1:$${columnLetter(s.columns.length - 1)}$${s.rows.length + 1}</definedName>` : '')).join('')}</definedNames>` : ''}</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    }<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', text: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: s.columns ? tableSheetXml(s) : summarySheetXml(s) })),
  ];
  return buildStoredZip(entries.map((e) => ({ name: e.name, data: Buffer.from(e.text, 'utf8') })));
}

const WORKER_ROW_THRESHOLD = 2000;

/** Same result as buildWorkbook; large workbooks are built in a worker thread. */
export function buildWorkbookAsync(sheets) {
  const rows = sheets.reduce((n, s) => n + (s.rows?.length ?? 0), 0);
  if (rows < WORKER_ROW_THRESHOLD) return Promise.resolve(buildWorkbook(sheets));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./xlsxWorker.js', import.meta.url), { workerData: sheets });
    worker.once('message', (file) => resolve(Buffer.from(file)));
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Export worker exited with code ${code}`)); });
  });
}
