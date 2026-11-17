// Builds a styled one-sheet Excel report: title, subtitle, green header row,
// zebra-striped rows, formatted money and dates, and a totals row.
const ExcelJS = require('exceljs');

const GREEN = 'FF0E8A43';
const GREEN_SOFT = 'FFE5F4EB';
const STRIPE = 'FFF6F8F7';
const GRID = 'FFD9DEE3';
const INK = 'FF15181C';
const MUTED = 'FF6B737B';
const FONT = 'Arial';

const thin = { style: 'thin', color: { argb: GRID } };
const border = { top: thin, left: thin, bottom: thin, right: thin };

// 'YYYY-MM-DD' -> Date at UTC midnight, which Excel shows as that calendar day.
const toDate = (s) => {
  if (!s) return null;
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const columnLetter = (n) => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/**
 * columns: [{ key, header, width, type: 'text' | 'money' | 'date' | 'index' }]
 * rows: plain objects keyed by column key
 * totals: [{ label, key, value }] - a subtotal line for the rows whose `key` equals `value`
 */
async function buildReport({ sheetName, title, subtitle, columns, rows, totals = [], grandTotalLabel, currencySymbol = '֏' }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FC Manager';
  wb.created = new Date();
  // Recalculate on open so every SUM/SUMIF shows its value, including zero subtotals.
  wb.calcProperties.fullCalcOnLoad = true;

  const ws = wb.addWorksheet(sheetName.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 4, topLeftCell: 'A5', activeCell: 'A5', showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      printTitlesRow: '4:4',
    },
    headerFooter: { oddFooter: '&L&8FC Manager&R&8&P / &N' },
  });
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width || 14 }));
  const last = columns.length;
  const moneyFmt = `#,##0 "${currencySymbol}"`;

  // Title and subtitle.
  ws.mergeCells(1, 1, 1, last);
  Object.assign(ws.getCell(1, 1), {
    value: title,
    font: { name: FONT, size: 16, bold: true, color: { argb: INK } },
    alignment: { vertical: 'middle' },
  });
  ws.getRow(1).height = 28;
  ws.mergeCells(2, 1, 2, last);
  Object.assign(ws.getCell(2, 1), {
    value: subtitle,
    font: { name: FONT, size: 10.5, color: { argb: MUTED } },
    alignment: { vertical: 'middle' },
  });
  ws.getRow(2).height = 20;
  ws.getRow(3).height = 8;

  // Header row.
  const header = ws.getRow(4);
  columns.forEach((c, i) => {
    Object.assign(header.getCell(i + 1), {
      value: c.header,
      font: { name: FONT, size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } },
      // Left-aligned so the filter button at the right edge never covers the text.
      alignment: { vertical: 'middle', horizontal: c.type === 'index' ? 'center' : 'left', wrapText: true },
      border,
    });
  });
  header.height = 30;

  // Data rows.
  const first = 5;
  rows.forEach((r, idx) => {
    const row = ws.getRow(first + idx);
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      let value = c.type === 'index' ? idx + 1 : r[c.key];
      if (c.type === 'date') value = toDate(value);
      if (c.type === 'money') value = Number(value || 0);
      cell.value = value ?? '';
      cell.font = { name: FONT, size: 10.5, color: { argb: INK } };
      cell.border = border;
      cell.alignment = {
        vertical: 'middle',
        horizontal: c.type === 'money' ? 'right' : c.type === 'index' || c.type === 'date' ? 'center' : 'left',
      };
      if (c.type === 'money') cell.numFmt = moneyFmt;
      if (c.type === 'date') cell.numFmt = 'dd.mm.yyyy';
      if (idx % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STRIPE } };
    });
    row.height = 20;
  });

  // Totals block below the data (after one empty row, so sorting/filtering never moves it):
  // one line per payment type (SUMIF on the type column), then the grand total (SUM).
  const lastData = first + rows.length - 1;
  const moneyIdx = columns.findIndex((c) => c.type === 'money') + 1;
  const money = columnLetter(moneyIdx);
  const labelEnd = Math.max(1, moneyIdx - 1);
  const amountOf = (r) => Number(r[columns[moneyIdx - 1].key] || 0);

  const writeTotal = (rowNo, label, formula, result, strong) => {
    const row = ws.getRow(rowNo);
    if (labelEnd > 1) ws.mergeCells(rowNo, 1, rowNo, labelEnd);
    for (let i = 1; i <= last; i++) {
      const cell = row.getCell(i);
      if (i === 1) cell.value = label;
      if (i === moneyIdx) {
        cell.value = rows.length ? { formula, result } : 0;
        cell.numFmt = moneyFmt;
      }
      cell.font = { name: FONT, size: strong ? 11.5 : 10.5, bold: true, color: { argb: INK } };
      cell.border = strong ? { ...border, top: { style: 'medium', color: { argb: GREEN } } } : border;
      cell.alignment = { vertical: 'middle', horizontal: i === moneyIdx ? 'right' : 'left', indent: i === 1 && !strong ? 1 : 0 };
      if (strong) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN_SOFT } };
    }
    row.height = strong ? 26 : 21;
  };

  let rowNo = lastData + 2;
  for (const tot of totals) {
    const keyCol = columnLetter(columns.findIndex((c) => c.key === tot.key) + 1);
    const matching = rows.filter((r) => r[tot.key] === tot.value);
    const value = String(tot.value).replace(/"/g, '""');
    writeTotal(
      rowNo++,
      `${tot.label} (${matching.length})`,
      `SUMIF(${keyCol}${first}:${keyCol}${lastData},"${value}",${money}${first}:${money}${lastData})`,
      matching.reduce((s, r) => s + amountOf(r), 0),
      false
    );
  }
  writeTotal(
    rowNo,
    `${grandTotalLabel} (${rows.length})`,
    `SUM(${money}${first}:${money}${lastData})`,
    rows.reduce((s, r) => s + amountOf(r), 0),
    true
  );

  if (rows.length) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: lastData, column: last } };

  return wb.xlsx.writeBuffer();
}

/**
 * A printable form to fill in by hand (e.g. attendance for coaches): title, info lines,
 * a green header and tall bordered rows. Columns of type 'blank' are left empty for writing.
 * columns: [{ key, header, width, type: 'text' | 'blank' | 'money' }]
 */
async function buildForm({ sheetName, title, lines = [], columns, rows, currencySymbol = '֏' }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FC Manager';
  wb.created = new Date();
  const headerRow = lines.length + 3;
  const ws = wb.addWorksheet(sheetName.slice(0, 31), {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: columns.length > 7 ? 'landscape' : 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      printTitlesRow: `${headerRow}:${headerRow}`,
    },
    headerFooter: { oddFooter: '&L&8FC Manager&R&8&P / &N' },
  });
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width || 14 }));
  const last = columns.length;

  ws.mergeCells(1, 1, 1, last);
  Object.assign(ws.getCell(1, 1), { value: title, font: { name: FONT, size: 16, bold: true, color: { argb: INK } } });
  ws.getRow(1).height = 28;
  lines.forEach((line, i) => {
    ws.mergeCells(i + 2, 1, i + 2, last);
    Object.assign(ws.getCell(i + 2, 1), { value: line, font: { name: FONT, size: 11, color: { argb: INK } } });
    ws.getRow(i + 2).height = 19;
  });
  ws.getRow(headerRow - 1).height = 8;

  const header = ws.getRow(headerRow);
  columns.forEach((c, i) => {
    Object.assign(header.getCell(i + 1), {
      value: c.header,
      font: { name: FONT, size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } },
      alignment: { vertical: 'middle', horizontal: c.type === 'text' ? 'left' : 'center', wrapText: true },
      border,
    });
  });
  header.height = 28;

  rows.forEach((r, idx) => {
    const row = ws.getRow(headerRow + 1 + idx);
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.type === 'money') {
        cell.value = r[c.key] ? Number(r[c.key]) : '';
        cell.numFmt = `#,##0 "${currencySymbol}"`;
        cell.font = { name: FONT, size: 11, bold: true, color: { argb: 'FFC42B2B' } };
      } else {
        cell.value = c.type === 'blank' ? '' : (r[c.key] ?? '');
        cell.font = { name: FONT, size: 11, color: { argb: INK } };
      }
      cell.border = { top: { style: 'thin', color: { argb: 'FF9AA3AB' } }, left: { style: 'thin', color: { argb: 'FF9AA3AB' } }, bottom: { style: 'thin', color: { argb: 'FF9AA3AB' } }, right: { style: 'thin', color: { argb: 'FF9AA3AB' } } };
      cell.alignment = { vertical: 'middle', horizontal: c.type === 'text' ? 'left' : c.type === 'money' ? 'right' : 'center' };
    });
    row.height = 26;
  });

  return wb.xlsx.writeBuffer();
}

/**
 * The training timetable in the club's layout: birth-year blocks, each with its own fill and a
 * header row (coach | group | dates); two rows per group (coach / assistant, time / pitch).
 * blocks: [{ label, fill: '#rrggbb', groups: [{ coach, assistant, name, cells: [{ time, place }] }] }]
 */
async function buildSchedule({ title, dates, blocks, headers }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FC Manager';
  wb.created = new Date();
  const ws = wb.addWorksheet('Դասացուցակ', {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9,
      orientation: dates.length > 3 ? 'landscape' : 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    },
  });
  ws.columns = [{ width: 27 }, { width: 12 }, ...dates.map(() => ({ width: 22 }))];
  const last = 2 + dates.length;
  const line = { style: 'thin', color: { argb: 'FF555555' } };
  const box = { top: line, left: line, bottom: line, right: line };
  const argb = (hex) => `FF${String(hex || '#ffffff').replace('#', '').toUpperCase()}`;
  const style = (cell, fill, opts = {}) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(fill) } };
    cell.border = box;
    cell.font = { name: FONT, size: 10, bold: !!opts.bold, color: { argb: INK } };
    cell.alignment = { vertical: 'middle', horizontal: opts.left ? 'left' : 'center', wrapText: true };
  };

  ws.mergeCells(1, 1, 1, last);
  Object.assign(ws.getCell(1, 1), { value: title, font: { name: FONT, size: 14, bold: true, color: { argb: INK } } });
  ws.getRow(1).height = 24;
  let r = 3;
  for (const b of blocks) {
    // Header of the block (two rows, merged), like the original file.
    const labels = [headers.coach, headers.group, ...dates];
    labels.forEach((v, i) => {
      ws.mergeCells(r, i + 1, r + 1, i + 1);
      const cell = ws.getCell(r, i + 1);
      cell.value = v;
      style(cell, b.fill, { bold: true });
    });
    r += 2;
    for (const g of b.groups) {
      const a = ws.getCell(r, 1);
      a.value = g.coach;
      style(a, b.fill, { left: true });
      const a2 = ws.getCell(r + 1, 1);
      a2.value = g.assistant;
      style(a2, b.fill, { left: true });
      ws.mergeCells(r, 2, r + 1, 2);
      const gc = ws.getCell(r, 2);
      gc.value = g.name;
      style(gc, b.fill, { bold: true });
      g.cells.forEach((c, i) => {
        const tc = ws.getCell(r, 3 + i);
        tc.value = c.time;
        style(tc, b.fill, { bold: true });
        const pc = ws.getCell(r + 1, 3 + i);
        pc.value = c.place;
        style(pc, b.fill);
      });
      ws.getRow(r).height = 17;
      ws.getRow(r + 1).height = 17;
      r += 2;
    }
  }
  return wb.xlsx.writeBuffer();
}

/**
 * Students for moving to another FC Manager (students only). A hidden sheet "_fcmanager" lists the
 * field of every column, so the other computer's import matches them exactly, in any language.
 * columns: [{ key, header, width }], rows: [{ [key]: value }]
 */
async function buildStudentsTransfer({ columns, rows, charges }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FC Manager';
  wb.created = new Date();
  const ws = wb.addWorksheet('Սաներ', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width || 16 }));
  const header = ws.getRow(1);
  columns.forEach((c, i) => {
    Object.assign(header.getCell(i + 1), {
      value: c.header,
      font: { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } },
      alignment: { vertical: 'middle', wrapText: true },
    });
  });
  header.height = 30;
  rows.forEach((r) => ws.addRow(columns.map((c) => r[c.key] ?? '')));
  const marker = wb.addWorksheet('_fcmanager', { state: 'hidden' });
  marker.addRow(columns.map((c) => c.key));
  // The students' payments, read back by the import of the other computer.
  if (charges?.rows?.length) {
    const ps = wb.addWorksheet('Վճարումներ', { views: [{ state: 'frozen', ySplit: 1 }] });
    ps.columns = charges.columns.map((k) => ({ width: ['student_key', 'description', 'note'].includes(k) ? 24 : 13 }));
    const h = ps.addRow(charges.headers);
    h.eachCell((c) => Object.assign(c, { font: { name: FONT, size: 10, bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } } }));
    charges.rows.forEach((r) => ps.addRow(r));
    wb.addWorksheet('_fcmanager_charges', { state: 'hidden' }).addRow(charges.columns);
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { buildReport, buildForm, buildSchedule, buildStudentsTransfer };
