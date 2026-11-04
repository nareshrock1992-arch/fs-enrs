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

// Key/value worksheet: title, then label | value rows, then the chart's data rows (when the
// sheet has a chart), then notes. Returns the XML and, with a chart, the rows it plots.
function summarySheetXml({ title, items = [], notes = [], chart }) {
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
  let plotted = null;
  if (chart) {
    r += 1;
    rows.push(`<row r="${r}">${textCell(`A${r}`, chart.dataTitle ?? chart.title, XF.label)}</row>`);
    r += 1;
    plotted = { first: r, last: r + chart.rows.length - 1 };
    for (const p of chart.rows) {
      rows.push(`<row r="${r}">${textCell(`A${r}`, p.label, XF.default)}${numberCell(`B${r}`, Number(p.value) || 0, XF.int)}</row>`);
      r += 1;
    }
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
  const ns = plotted ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : '';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${ns}><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><cols><col min="1" max="1" width="38" customWidth="1"/><col min="2" max="2" width="44" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData>${plotted ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
  return { xml, plotted };
}

// ── Pie chart (a native Excel chart; it plots the data rows written on the sheet) ─────
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relsXml = (type, target) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/${type}" Target="${target}"/></Relationships>`;

const drawingXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>21</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;

function pieChartXml(chart, sheetName, { first, last }) {
  const sheetRef = `'${String(sheetName).replace(/'/g, "''")}'`;
  const n = chart.rows.length;
  const colour = (c) => (/^[0-9A-Fa-f]{6}$/.test(String(c ?? '')) ? String(c).toUpperCase() : null);
  const points = chart.rows.map((p, i) => (colour(p.color)
    ? `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${colour(p.color)}"/></a:solidFill></c:spPr></c:dPt>` : '')).join('');
  const strPts = chart.rows.map((p, i) => `<c:pt idx="${i}"><c:v>${escapeXml(p.label)}</c:v></c:pt>`).join('');
  const numPts = chart.rows.map((p, i) => `<c:pt idx="${i}"><c:v>${Number(p.value) || 0}</c:v></c:pt>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}"><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${escapeXml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${escapeXml(chart.title)}</c:v></c:tx>${points}<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls><c:cat><c:strRef><c:f>${escapeXml(`${sheetRef}!$A$${first}:$A$${last}`)}</c:f><c:strCache><c:ptCount val="${n}"/>${strPts}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${escapeXml(`${sheetRef}!$B$${first}:$B$${last}`)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${n}"/>${numPts}</c:numCache></c:numRef></c:val></c:ser><c:firstSliceAng val="0"/></c:pieChart></c:plotArea><c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
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
 * @param sheets [{ name, title, items, notes, chart }]   summary sheet, or
 *               [{ name, columns: [{ header, key, type, width, empty }], rows }]  table sheet
 *               type: 'text' (default) | 'int' | 'percent' (0–1) | 'datetime' | 'duration' (seconds)
 *               chart (optional, summary sheet): { title, dataTitle?, rows: [{ label, value, color? (RRGGBB) }] }
 *               → a pie chart beside the summary, plotting those rows (also written on the sheet)
 * @returns Buffer  an .xlsx file
 */
export function buildWorkbook(sheets) {
  const names = sheetNames(sheets);
  const built = sheets.map((s) => (s.columns ? { xml: tableSheetXml(s), plotted: null } : summarySheetXml(s)));
  // Chart k (1-based) belongs to the k-th sheet that has one.
  const charts = [];
  built.forEach((b, i) => { if (b.plotted) charts.push({ sheet: i, k: charts.length + 1 }); });
  const chartParts = charts.flatMap(({ sheet, k }) => [
    { name: `xl/worksheets/_rels/sheet${sheet + 1}.xml.rels`, text: relsXml('drawing', `../drawings/drawing${k}.xml`) },
    { name: `xl/drawings/drawing${k}.xml`, text: drawingXml() },
    { name: `xl/drawings/_rels/drawing${k}.xml.rels`, text: relsXml('chart', `../charts/chart${k}.xml`) },
    { name: `xl/charts/chart${k}.xml`, text: pieChartXml(sheets[sheet].chart, names[sheet], built[sheet].plotted) },
  ]);
  const entries = [
    { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${
      charts.map(({ k }) => `<Override PartName="/xl/drawings/drawing${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart${k}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('')}</Types>` },
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
    ...built.map((b, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: b.xml })),
    ...chartParts,
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
