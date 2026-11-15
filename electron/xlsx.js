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

module.exports = { buildReport, buildForm };
