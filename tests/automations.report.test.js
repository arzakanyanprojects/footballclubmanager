const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { makeService, ok, seed, saveDue } = require('./helpers');
const { buildReportAttachment } = require('../electron/reportAttachment');

const reportRule = (action) => ({
  name: 'Պարտքերի հաշվետվություն',
  trigger: { type: 'schedule', every: 'monthly', day: 1, time: '09:00' },
  conditions: [],
  actions: [{ type: 'emailReport', report: 'debts', range: 'lastMonth', to: 'boss@club.am', ...action }],
});

test('report: emailReport lastMonth queues the previous month as the report period', () => {
  const { service, db } = makeService({ email: { enabled: true, host: 'smtp.test' } });
  saveDue(service, db, reportRule());
  service.automations.tick(new Date('2026-11-27T10:00:00'));
  const rows = db.prepare(`SELECT recipient, kind, subject, attachment FROM outbox`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient, 'boss@club.am');
  assert.equal(rows[0].kind, 'report');
  assert.match(rows[0].subject, /Պարտքեր/);
  assert.deepEqual(JSON.parse(rows[0].attachment), { report: 'debts', period: '2026-10', from: '2026-10-01', to: '2026-10-31' });
});

test('report: last 7 days and yesterday ranges', () => {
  const { service, db } = makeService({ email: { enabled: true, host: 'smtp.test' } });
  saveDue(service, db, { ...reportRule({ range: 'last7', report: 'joinsLeaves' }), name: 'a' });
  saveDue(service, db, { ...reportRule({ range: 'yesterday', report: 'hdmReceipts' }), name: 'b' });
  service.automations.tick(new Date('2026-12-01T10:00:00'));
  const specs = db.prepare(`SELECT attachment FROM outbox ORDER BY id`).all().map((r) => JSON.parse(r.attachment));
  assert.deepEqual(specs[0], { report: 'joinsLeaves', period: '2026-12', from: '2026-11-25', to: '2026-12-01' });
  assert.deepEqual(specs[1], { report: 'hdmReceipts', period: '2026-11', from: '2026-11-30', to: '2026-11-30' });
});

test('report: email not set up fails the run', () => {
  const { service, db } = makeService();
  saveDue(service, db, reportRule());
  service.automations.tick(new Date('2026-11-27T10:00:00'));
  assert.equal(ok(service.call('automations.runs', {}))[0].status, 'failed');
});

test('report: an unknown report is rejected', () => {
  const { service } = makeService();
  const r = service.call('automations.save', reportRule({ report: 'payments' }));
  assert.equal(r.error, 'AUTOMATION_INVALID');
});

test('report: attachment is an xlsx with the report title and its rows', async () => {
  const { service, db } = makeService();
  const { studentId } = seed(service);
  db.prepare(`INSERT INTO charges (student_id, kind, period, amount, due_date, status) VALUES (?, 'monthly', '2025-06', 30000, '2025-06-15', 'unpaid')`).run(studentId);
  const file = await buildReportAttachment(service, { report: 'debts', period: '2026-10', from: '2026-10-01', to: '2026-10-31' });
  assert.match(file.filename, /^Պարտքեր .*\.xlsx$/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.content);
  const ws = wb.worksheets[0];
  assert.match(String(ws.getCell('A1').value), /Պարտքեր/);
  const values = [];
  ws.eachRow((row) => values.push(row.values.join('|')));
  assert.ok(values.some((v) => v.includes('Արամ Պետրոսյան')), 'the student with a debt is listed');
});
