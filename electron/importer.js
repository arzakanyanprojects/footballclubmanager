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
    if (v.text != null) return typeof v.text === 'object' ? cellText(v.text) : String(v.text); // hyperlink (its text may be formatted)
    if (v.result !== undefined) return cellText(v.result); // formula
    if (v.error) return '';
  }
  return String(v).replace(/\s+/g, ' ').trim();
}

// The workbook's theme colours, in the order cells refer to them (0 = background/white, 1 = text/black, …).
function themeColours(wb) {
  const xml = Object.values(wb._themes || {})[0] || '';
  const scheme = (xml.match(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/) || [''])[0];
  const get = (name) => {
    const m = scheme.match(new RegExp(`<a:${name}>[^]*?(?:lastClr|val)="([0-9A-Fa-f]{6})"`));
    return m ? m[1].toUpperCase() : null;
  };
  const c = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(get);
  const office = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
  return c.map((v, i) => v || office[i]);
}

// A theme colour lightened (tint > 0) or darkened (tint < 0), as Excel shows it.
function tinted(hex, tint) {
  if (!tint) return hex;
  return [0, 2, 4]
    .map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16);
      const out = tint < 0 ? v * (1 + tint) : v + (255 - v) * tint;
      return Math.round(Math.min(255, Math.max(0, out))).toString(16).padStart(2, '0');
    })
    .join('')
    .toUpperCase();
}

// A cell's fill colour as "RRGGBB" — plain colours and theme colours (e.g. «black, lighter 50%» = grey); no fill gives "".
function fillOf(cell, theme) {
  const f = cell.fill;
  if (!f || f.type !== 'pattern' || f.pattern === 'none' || !f.fgColor) return '';
  if (f.fgColor.argb) return f.fgColor.argb.slice(-6).toUpperCase();
  if (f.fgColor.theme != null && theme[f.fgColor.theme]) return tinted(theme[f.fgColor.theme], f.fgColor.tint || 0);
  return '';
}

async function readXlsx(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const theme = themeColours(wb);
  return wb.worksheets.map((ws) => {
    const rows = [];
    const fills = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS) return;
      const vals = [];
      const cols = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const cell = row.getCell(c);
        vals.push(cellText(cell.value));
        cols.push(fillOf(cell, theme));
      }
      rows.push(vals);
      fills.push(cols);
    });
    const t = trim(rows, fills);
    return { name: ws.name, hidden: ws.state !== 'visible', rows: t.rows, fills: t.fills };
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
  return [{ name: path.basename(file), rows: trim(rows).rows, fills: null }];
}

// Drops empty rows and trailing empty columns (colours stay aligned with their cells).
function trim(rows, fills) {
  const keep = rows.map((r) => r.some((v) => v !== ''));
  const kept = rows.filter((_, i) => keep[i]);
  const width = kept.reduce((w, r) => Math.max(w, r.reduce((last, v, i) => (v !== '' ? i + 1 : last), 0)), 0);
  const cut = (r) => Array.from({ length: width }, (_, i) => r[i] ?? '');
  return { rows: kept.map(cut), fills: fills ? fills.filter((_, i) => keep[i]).map(cut) : null };
}

async function readTable(file) {
  const ext = path.extname(file).toLowerCase();
  const sheets = ext === '.csv' || ext === '.txt' ? readCsv(file) : await readXlsx(file);
  return { fileName: path.basename(file), sheets: sheets.filter((s) => s.rows.length) };
}

module.exports = { readTable };
