// ── Uploaded spreadsheet (CSV or .xlsx) → numbered rows ───────────────────────
//
// Generic first step of a bulk import: turns an uploaded file into the same shape
// whatever its format, so the caller keeps one validation pipeline. The format is
// decided from the file name and the content together:
//   - .xlsx (ZIP content)  → utils/xlsxReader.js (one worksheet, values only)
//   - .csv  (text content) → csv-parse (RFC 4180; UTF-8, optional BOM)
//   - a file without an extension is detected from its content;
//   - anything else (.xls, .xlsm, .ods, binary, mismatched name / content) is refused.
// Row numbers are the numbers a spreadsheet program shows: the header is the first
// non-empty row; empty rows are dropped but keep their numbers; a CSV value with a
// line break stays in one row. All values are strings, trimmed.

import { parse } from 'csv-parse/sync';
import { readXlsx, XlsxReadError } from './xlsxReader.js';

export class TabularFileError extends Error {
  /** status: 400 (unusable file) or 413 (a size / row limit) */
  constructor(message, status = 400) {
    super(message);
    this.name = 'TabularFileError';
    this.status = status;
  }
}

const ACCEPTED = 'Upload an Excel workbook (.xlsx) or a CSV file (.csv)';
const SIG_ZIP = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
const SIG_OLE = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);

const extensionOf = (filename) => (/\.([A-Za-z0-9]{1,12})$/.exec(String(filename || ''))?.[1] || '').toLowerCase();

// Text files have no NUL bytes; UTF-16 and binary files do.
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * @param buffer   file content
 * @param opts     filename: the uploaded name (its extension is checked)
 *                 maxDataRows: non-empty rows allowed after the header row
 *                 maxColumns: columns read per row
 *                 sheetName: preferred worksheet of a workbook
 *                 zip: archive limits for workbooks (see zipStore.readZip)
 * @returns { format: 'csv'|'xlsx', sheetName?, header: { row, values }|null,
 *            rows: [{ row, values: string[], formulas: number[], errors: number[] }] }
 */
export function readTabularFile(buffer, { filename, maxDataRows = 10000, maxColumns = 50, sheetName, zip } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new TabularFileError(`The file is empty. ${ACCEPTED}.`);
  const ext = extensionOf(filename);
  if (ext && ext !== 'csv' && ext !== 'xlsx') {
    throw new TabularFileError(`Files of type .${ext} are not supported. ${ACCEPTED}.`);
  }
  if (buffer.subarray(0, 8).equals(SIG_OLE)) {
    throw new TabularFileError('This is an old Excel (.xls) or password-protected file. Save it as an Excel Workbook (.xlsx) without a password, or as CSV.');
  }
  const isZip = buffer.subarray(0, 4).equals(SIG_ZIP);
  if (ext === 'csv' && isZip) throw new TabularFileError('The file is named .csv but contains a workbook. Upload it as .xlsx, or save it as CSV.');
  if (ext === 'xlsx' && !isZip) throw new TabularFileError('The file is named .xlsx but is not an Excel workbook.');

  let table;
  if (isZip) {
    let sheet;
    try {
      sheet = readXlsx(buffer, { sheetName, maxDataRows, maxColumns, zip });
    } catch (err) {
      if (err instanceof XlsxReadError) throw new TabularFileError(err.message, err.code === 'XLSX_LIMIT' ? 413 : 400);
      throw err;
    }
    table = { format: 'xlsx', sheetName: sheet.sheetName, rows: sheet.rows };
  } else {
    if (looksBinary(buffer)) throw new TabularFileError(`This file type is not supported. ${ACCEPTED}.`);
    table = { format: 'csv', rows: readCsvRows(buffer, { maxDataRows, maxColumns }) };
  }

  const rows = table.rows.map((r) => ({ ...r, values: r.values.map((v) => (v === undefined || v === null ? '' : String(v).trim())) }));
  const [header, ...data] = rows;
  return { format: table.format, sheetName: table.sheetName, header: header ? { row: header.row, values: header.values } : null, rows: data };
}

function readCsvRows(buffer, { maxDataRows, maxColumns }) {
  let records;
  try {
    records = parse(buffer, { bom: true, relax_column_count: true, skip_empty_lines: false, trim: true });
  } catch (err) {
    throw new TabularFileError(`The CSV file could not be read: ${err.message}`);
  }
  const rows = [];
  for (let i = 0; i < records.length; i++) {
    const values = records[i].slice(0, maxColumns);
    if (!values.some((v) => v !== '')) continue;          // empty row: dropped, number kept
    if (rows.length > 0 && rows.length > maxDataRows) throw new TabularFileError(`The file has more than ${maxDataRows} data rows`, 413);
    rows.push({ row: i + 1, values, formulas: [], errors: [], width: records[i].length });
  }
  if (rows.length - 1 > maxDataRows) throw new TabularFileError(`The file has more than ${maxDataRows} data rows`, 413);
  return rows;
}
