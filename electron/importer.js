// Reads a spreadsheet exported from another program (Excel .xlsx or .csv) into plain rows of text,
// so the import window can let the user match its columns to FC Manager fields.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const MAX_ROWS = 10000;
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return isoDate(v);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text != null) return String(v.text); // hyperlink
    if (v.result !== undefined) return cellText(v.result); // formula
    if (v.error) return '';
  }
  return String(v).trim();
}

async function readXlsx(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS) return;
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(row.getCell(c).value));
      rows.push(vals);
    });
    return { name: ws.name, rows: trim(rows) };
  });
}

// CSV with , ; or tab separators, quoted fields and a UTF-8 BOM (Excel's "CSV UTF-8").
function readCsv(file) {
  let text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= MAX_ROWS) break;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return [{ name: path.basename(file), rows: trim(rows) }];
}

// Drops empty rows and trailing empty columns.
function trim(rows) {
  const kept = rows.filter((r) => r.some((v) => v !== ''));
  const width = kept.reduce((w, r) => Math.max(w, r.reduce((last, v, i) => (v !== '' ? i + 1 : last), 0)), 0);
  return kept.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
}

async function readTable(file) {
  const ext = path.extname(file).toLowerCase();
  const sheets = ext === '.csv' || ext === '.txt' ? readCsv(file) : await readXlsx(file);
  return { fileName: path.basename(file), sheets: sheets.filter((s) => s.rows.length) };
}

module.exports = { readTable };
