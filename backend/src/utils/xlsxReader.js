// ── Minimal Excel (.xlsx) reader: cell values of one worksheet ────────────────
//
// Counterpart of xlsxWriter.js for uploads; no dependency. An .xlsx file is a ZIP of
// XML parts: zipStore.readZip enforces the archive limits, then only the parts needed
// are inflated (package relationships, workbook, shared strings, one worksheet).
//
// Values only. Nothing is evaluated: a formula cell is reported (`formulas`), never
// computed, and its cached result is not used. Numbers become plain digit strings
// (never scientific notation), booleans "true" / "false". Styles, hidden flags,
// defined names, data validations, comments and document properties are ignored.
//
// The XML is read with a small linear scanner (each element is located once, its end
// tag with indexOf; a missing end tag rejects the file), so a large or hostile part
// costs time and memory proportional to its size. Document type declarations
// (entity expansion) are refused.

import { readZip, ZipReadError } from './zipStore.js';

export class XlsxReadError extends Error {
  /** code: 'XLSX_INVALID' or 'XLSX_LIMIT' */
  constructor(message, code = 'XLSX_INVALID') {
    super(message);
    this.name = 'XlsxReadError';
    this.code = code;
  }
}

const NOT_XLSX = 'The file is not a valid Excel workbook (.xlsx)';
const invalid = (msg = NOT_XLSX) => new XlsxReadError(msg, 'XLSX_INVALID');
const MACRO_TYPE = 'application/vnd.ms-excel.sheet.macroEnabled.main+xml';
const EXCEL_MAX_ROWS = 1048576;

// ── XML scanning ──────────────────────────────────────────────────────────────

/**
 * Elements named `tag` between xml[from] and xml[to] (not nested in each other).
 * Yields { attrs: string, from, to } where from/to delimit the element's content.
 * An optional namespace prefix is accepted (some generators write <x:row>, <x:c>).
 */
function* elements(xml, tag, from = 0, to = xml.length) {
  const re = new RegExp(`<([A-Za-z_][\\w.-]*:)?${tag}(?=[\\s/>])`, 'g');
  re.lastIndex = from;
  for (let m; (m = re.exec(xml)) && m.index < to;) {
    let i = re.lastIndex;
    for (let quote = 0; i < to; i++) {
      const ch = xml.charCodeAt(i);
      if (quote) { if (ch === quote) quote = 0; } else if (ch === 34 || ch === 39) quote = ch; else if (ch === 62) break;
    }
    if (i >= to) throw invalid();
    if (xml.charCodeAt(i - 1) === 47) { // "/>"
      yield { attrs: xml.slice(re.lastIndex, i - 1), from: i + 1, to: i + 1 };
      re.lastIndex = i + 1;
      continue;
    }
    const close = `</${m[1] || ''}${tag}`;
    let ci = xml.indexOf(close, i + 1);
    while (ci >= 0 && ci < to && !/[\s>]/.test(xml[ci + close.length] || '')) ci = xml.indexOf(close, ci + 1);
    const ce = ci < 0 ? -1 : xml.indexOf('>', ci);
    if (ci < 0 || ce < 0 || ce >= to) throw invalid();
    yield { attrs: xml.slice(re.lastIndex, i), from: i + 1, to: ci };
    re.lastIndex = ce + 1;
  }
}
const first = (xml, tag, from, to) => elements(xml, tag, from, to).next().value || null;

function attributes(text) {
  const out = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let m; (m = re.exec(text || ''));) out[m[1]] = decodeXml(m[2] ?? m[3]);
  return out;
}

// Attribute of a (possibly prefixed) local name, e.g. "id" finds r:id.
function attr(attrs, local) {
  if (attrs[local] !== undefined) return attrs[local];
  const key = Object.keys(attrs).find((k) => k.endsWith(`:${local}`));
  return key ? attrs[key] : undefined;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(text) {
  if (!text || text.indexOf('&') < 0) return text || '';
  return text.replace(/&(#\d{1,7}|#x[0-9A-Fa-f]{1,6}|[A-Za-z][\w.-]*);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!cp || cp > 0x10FFFF) throw invalid();
      return String.fromCodePoint(cp);
    }
    if (NAMED[e] === undefined) throw invalid();
    return NAMED[e];
  });
}

// ECMA-376 escapes characters XML cannot carry as _xHHHH_ (e.g. _x000D_ for CR).
const unescapeOoxml = (s) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

// Character data that may contain CDATA sections.
function textContent(raw) {
  if (!raw) return '';
  if (raw.indexOf('<![CDATA[') < 0) return unescapeOoxml(decodeXml(raw));
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    out += decodeXml(raw.slice(last, m.index)) + m[1];
    last = m.index + m[0].length;
  }
  return unescapeOoxml(out + decodeXml(raw.slice(last)));
}

// Concatenated <t> runs of one string item's content (<si> or <is>), without phonetic <rPh>
// runs. `item` is the item's own text, so every search stays inside it.
function richText(item) {
  const phonetic = item.includes('rPh') ? [...elements(item, 'rPh')] : [];
  let out = '';
  for (const t of elements(item, 't')) {
    if (phonetic.some((p) => t.from >= p.from && t.to <= p.to)) continue;
    out += textContent(item.slice(t.from, t.to));
  }
  return out;
}

// ── Package parts ─────────────────────────────────────────────────────────────

// ZIP errors (corrupt part, checksum mismatch, inflation beyond the declared size or a
// limit) become workbook errors, so the caller gets a clear 400 / 413.
function zipError(err) {
  if (!(err instanceof ZipReadError)) return err;
  return err.code === 'ZIP_LIMIT' ? new XlsxReadError(err.message, 'XLSX_LIMIT') : invalid(`${NOT_XLSX}: ${err.message}`);
}

function xmlOf(zip, name) {
  let data;
  try { data = zip.read(name); } catch (err) { throw zipError(err); }
  if (!data) return null;
  const xml = data.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid('The workbook contains an XML document type declaration, which is not allowed');
  return xml.indexOf('<!--') >= 0 ? xml.replace(/<!--[\s\S]*?-->/g, '') : xml;
}

function relationships(xml) {
  const out = [];
  if (!xml) return out;
  for (const r of elements(xml, 'Relationship')) {
    const a = attributes(r.attrs);
    out.push({ id: a.Id, type: a.Type || '', target: a.Target || '', external: a.TargetMode === 'External' });
  }
  return out;
}

// Resolve a relationship target against the folder of its source part, staying inside the package.
function resolvePart(baseDir, target) {
  const parts = (target.startsWith('/') ? target.slice(1) : `${baseDir}${target}`).split('/');
  const out = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) throw invalid(); out.pop(); } else out.push(seg);
  }
  return out.join('/');
}

const folderOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);

/** "C7" → 2 (zero-based column), or -1 when the reference has no column letters. */
export function columnIndex(ref) {
  const m = /^([A-Za-z]{1,3})\d*$/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A number as written in the file → plain decimal text ("9.665E+11" → "966500000000"). */
export function plainNumber(raw) {
  const s = String(raw).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/.exec(s);
  if (!m || (m[2] === '' && !(m[3] || ''))) return s;
  const sign = m[1] === '-' ? '-' : '';
  const digits = `${m[2]}${m[3] || ''}`;
  const point = m[2].length + Number(m[4] || 0);
  let int;
  let frac;
  if (point <= 0) {
    int = '0'; frac = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    int = digits + '0'.repeat(point - digits.length); frac = '';
  } else {
    int = digits.slice(0, point); frac = digits.slice(point);
  }
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return /^0(\.0*)?$/.test(out) ? '0' : sign + out;
}

/**
 * Read the cell values of one worksheet.
 * @param buffer  the uploaded .xlsx file
 * @param opts    sheetName: preferred worksheet (case-insensitive; otherwise the first one)
 *                maxDataRows: non-empty rows allowed after the first non-empty (header) row
 *                maxColumns: columns read per row (cells further right are ignored)
 *                zip: { maxEntries, maxEntryBytes, maxTotalBytes } (see zipStore.readZip)
 * @returns { sheetName, rows: [{ row, values: string[], formulas: number[], errors: number[] }] }
 *          non-empty rows only, in sheet order; `row` is the spreadsheet row number
 */
export function readXlsx(buffer, { sheetName, maxDataRows = 10000, maxColumns = 50, zip: zipLimits } = {}) {
  let zip;
  try { zip = readZip(buffer, zipLimits); } catch (err) { throw zipError(err); }

  const contentTypes = xmlOf(zip, '[Content_Types].xml');
  if (contentTypes === null) throw invalid();
  if (contentTypes.includes(MACRO_TYPE) || zip.names.some((n) => /vbaProject\.bin$/i.test(n))) {
    throw invalid('Macro-enabled workbooks are not accepted. Save the file as an Excel Workbook (.xlsx)');
  }

  const officeDoc = relationships(xmlOf(zip, '_rels/.rels')).find((r) => /\/officeDocument$/.test(r.type) && !r.external);
  const workbookPath = officeDoc ? resolvePart('', officeDoc.target) : 'xl/workbook.xml';
  const workbook = xmlOf(zip, workbookPath);
  if (workbook === null) throw invalid();
  const wbDir = folderOf(workbookPath);
  const wbRels = relationships(xmlOf(zip, `${wbDir}_rels/${workbookPath.slice(wbDir.length)}.rels`));

  const sheets = [];
  for (const s of elements(workbook, 'sheet')) {
    const a = attributes(s.attrs);
    const rel = wbRels.find((r) => r.id === attr(a, 'id'));
    if (rel && !rel.external && /\/worksheet$/.test(rel.type)) sheets.push({ name: a.name || '', path: resolvePart(wbDir, rel.target) });
  }
  if (!sheets.length) throw invalid('The workbook has no worksheet');
  const wanted = sheetName ? sheets.find((s) => s.name.trim().toLowerCase() === sheetName.trim().toLowerCase()) : null;
  const sheet = wanted || sheets[0];

  // Shared strings, read only when a cell refers to one.
  let shared = null;
  const sharedStrings = () => {
    if (shared) return shared;
    shared = [];
    const rel = wbRels.find((r) => /\/sharedStrings$/.test(r.type) && !r.external);
    const xml = rel ? xmlOf(zip, resolvePart(wbDir, rel.target)) : null;
    if (xml) for (const si of elements(xml, 'si')) shared.push(richText(xml.slice(si.from, si.to)));
    return shared;
  };

  const xml = xmlOf(zip, sheet.path);
  if (xml === null) throw invalid();
  const sheetData = first(xml, 'sheetData');

  const rows = [];
  let dataRows = 0;
  let rowNo = 0;
  let scanned = 0;
  for (const r of sheetData ? elements(xml, 'row', sheetData.from, sheetData.to) : []) {
    if (++scanned > EXCEL_MAX_ROWS) throw invalid();
    const ra = attributes(r.attrs);
    rowNo = ra.r !== undefined ? Number(ra.r) : rowNo + 1;
    if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > EXCEL_MAX_ROWS) throw invalid();
    const values = [];
    const formulas = [];
    const errors = [];
    let col = -1;
    let nonEmpty = false;
    // Searches below run on the row's / cell's own text, so each one is bounded by it.
    const rowXml = xml.slice(r.from, r.to);
    for (const c of elements(rowXml, 'c')) {
      const ca = attributes(c.attrs);
      col = ca.r !== undefined ? columnIndex(ca.r) : col + 1;
      if (col < 0) throw invalid();
      if (col >= maxColumns) continue;
      const type = ca.t || 'n';
      const cellXml = rowXml.slice(c.from, c.to);
      let value = '';
      if (first(cellXml, 'f')) {
        formulas.push(col);
        nonEmpty = true;
      } else if (type === 'inlineStr') {
        const is = first(cellXml, 'is');
        value = is ? richText(cellXml.slice(is.from, is.to)) : '';
      } else {
        const v = first(cellXml, 'v');
        const raw = v ? textContent(cellXml.slice(v.from, v.to)) : '';
        if (raw === '') {
          value = '';
        } else if (type === 's') {
          const list = sharedStrings();
          const idx = Number(raw);
          if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) throw invalid();
          value = list[idx];
        } else if (type === 'b') {
          value = raw.trim() === '1' || raw.trim().toLowerCase() === 'true' ? 'true' : 'false';
        } else if (type === 'e') {
          errors.push(col);
          nonEmpty = true;
        } else if (type === 'n') {
          value = plainNumber(raw);
        } else {
          value = raw; // "str" without a formula, or "d" (ISO date text)
        }
      }
      if (value !== '') nonEmpty = true;
      values[col] = value;
    }
    if (!nonEmpty) continue;
    if (rows.length > 0 && ++dataRows > maxDataRows) {
      throw new XlsxReadError(`The file has more than ${maxDataRows} data rows`, 'XLSX_LIMIT');
    }
    for (let i = 0; i < values.length; i++) if (values[i] === undefined) values[i] = '';
    rows.push({ row: rowNo, values, formulas, errors });
  }
  return { sheetName: sheet.name, rows };
}
