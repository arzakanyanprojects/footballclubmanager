// «Անհատական»: individual-lesson students, their monthly packages and lessons.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeService, ok, seed } = require('./helpers');

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const period = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

function addIndividual(service, extra = {}) {
  return ok(
    service.call('individual.save', {
      first_name: 'Դավիթ', last_name: 'Նահապետյան', parent_first_name: 'Արփինե', birth_year: 2013, parent_phone: '094828820',
      coach: 'Տիգրան Ասլանյան', service: 'Ֆուտբոլ անհ. 4', join_date: `${period}-01`, ...extra,
    })
  ).id;
}

test('an individual student gets this month’s package at the service price and stays out of the students list', () => {
  const { service } = makeService();
  seed(service);
  const id = addIndividual(service);
  const list = ok(service.call('individual.list', { month: period }));
  assert.equal(list.rows.length, 1);
  const row = list.rows[0];
  assert.equal(row.id, id);
  assert.equal(row.birth_year, 2013);
  assert.equal(row.package.amount, 24000);
  assert.equal(row.package.description, 'Ֆուտբոլ անհ. 4');
  assert.equal(row.package.status, 'unpaid');
  // Not in the students list / summary.
  const students = ok(service.call('students.list', {}));
  assert.ok(!students.some((s) => s.id === id));
  assert.equal(ok(service.call('students.summary')).total, 1);
});

test('lessons count toward the month shown, including a date from another month', () => {
  const { service } = makeService();
  const id = addIndividual(service);
  ok(service.call('individual.lesson', { studentId: id, date: `${period}-03`, period }));
  ok(service.call('individual.lesson', { studentId: id, date: '2020-01-29', period }));
  let row = ok(service.call('individual.list', { month: period })).rows[0];
  assert.deepEqual(row.lessons.map((l) => l.date), ['2020-01-29', `${period}-03`]);
  ok(service.call('individual.lesson', { studentId: id, date: `${period}-03`, on: false }));
  row = ok(service.call('individual.list', { month: period })).rows[0];
  assert.equal(row.lessons.length, 1);
});

test('changing the service or the price list reprices the unpaid package', () => {
  const { service } = makeService();
  const id = addIndividual(service);
  const s = ok(service.call('individual.get', { id }));
  ok(service.call('individual.save', { ...s, service: 'Դարպասապահ 8' }));
  assert.equal(ok(service.call('individual.list', { month: period })).rows[0].package.amount, 48000);
  const prices = ok(service.call('individual.list', { month: period })).prices;
  ok(service.call('settings.update', { individual_prices: JSON.stringify({ ...prices, 'Դարպասապահ 8': 50000 }) }));
  assert.equal(ok(service.call('individual.list', { month: period })).rows[0].package.amount, 50000);
});

test('a package is paid like any monthly fee', () => {
  const { service } = makeService();
  addIndividual(service);
  const pkg = ok(service.call('individual.list', { month: period })).rows[0].package;
  ok(service.call('charges.markPaid', { ids: [pkg.id], amounts: { [pkg.id]: pkg.amount }, method: 'card' }));
  assert.equal(ok(service.call('individual.list', { month: period })).rows[0].package.status, 'paid');
});

test('a service without a package price is refused', () => {
  const { service } = makeService();
  const r = service.call('individual.save', { first_name: 'Ա', last_name: 'Բ', service: 'Առաջնություն' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'SERVICE_REQUIRED');
});

test('the statistics and individual reports build their Excel workbooks', async () => {
  const ExcelJS = require('exceljs');
  const { buildWorkbook } = require('../electron/xlsx');
  const { dictionaries } = await import('../electron/locales.mjs');
  const { translator } = await import('../electron/reportSheets.mjs');
  const { statsSheets, individualSheets } = await import('../src/components/ReportBooks.mjs');
  const t = translator(dictionaries, 'hy');
  const { service } = makeService();
  seed(service);
  const id = addIndividual(service);
  ok(service.call('individual.lesson', { studentId: id, date: `${period}-03`, period }));

  const stats = ok(service.call('stats.sheet', { from: `${period}-01`, to: `${period}-28` }));
  assert.equal(stats.months.length, 1);
  assert.equal(stats.months[0].active, 1);
  assert.equal(stats.months[0].ind_active, 1);
  assert.equal(stats.months[0].ind_lessons, 1);
  assert.equal(stats.months[0].ind_bought, 4);
  const read = async (sheets) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildWorkbook({ sheets }));
    return wb;
  };
  const statsBook = await read(statsSheets(stats, t, { title: 'T', subtitle: 'S' }));
  assert.equal(statsBook.worksheets.length, 6);

  const ind = ok(service.call('individual.sheet', { from: period, to: period }));
  const indBook = await read(individualSheets(ind, t, { title: 'T', subtitle: 'S' }));
  assert.equal(indBook.worksheets.length, 4); // the month + by coach + by student + unused
  const grid = indBook.worksheets[0];
  assert.equal(grid.getRow(5).getCell(2).value, 'Դավիթ Նահապետյան');
  const unused = indBook.worksheets[3];
  assert.equal(unused.getRow(5).getCell(7).value, 3); // 4 bought, 1 given
});
