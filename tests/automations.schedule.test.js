const test = require('node:test');
const assert = require('node:assert');
const { slotKey } = require('../electron/automations');
const { makeService, ok, saveDue } = require('./helpers');

const at = (iso) => new Date(iso); // local time
const daily = { type: 'schedule', every: 'daily', time: '20:00' };

test('slotKey: daily at 20:00', () => {
  assert.equal(slotKey(daily, at('2026-11-27T19:59:00')), null);
  assert.equal(slotKey(daily, at('2026-11-27T20:05:00')), '2026-11-27');
  assert.equal(slotKey(daily, at('2026-11-27T23:00:00')), '2026-11-27');
});

test('slotKey: weekly on Monday 09:00 only on Mondays after 09:00', () => {
  const weekly = { type: 'schedule', every: 'weekly', weekday: 1, time: '09:00' };
  assert.equal(slotKey(weekly, at('2026-11-29T10:00:00')), null); // Sunday
  assert.equal(slotKey(weekly, at('2026-11-30T08:59:00')), null);
  assert.equal(slotKey(weekly, at('2026-11-30T09:00:00')), '2026-W49');
});

test('slotKey: monthly on day 20 from 09:00, and later days of the month', () => {
  const monthly = { type: 'schedule', every: 'monthly', day: 20, time: '09:00' };
  assert.equal(slotKey(monthly, at('2026-11-19T12:00:00')), null);
  assert.equal(slotKey(monthly, at('2026-11-20T08:00:00')), null);
  assert.equal(slotKey(monthly, at('2026-11-20T09:00:00')), '2026-11');
  assert.equal(slotKey(monthly, at('2026-11-23T07:00:00')), '2026-11', 'app was closed on the 20th');
});

const telegramCfg = { telegram: { enabled: true, token: 't', chats: [{ id: 1 }] } };
const summaryRule = (over = {}) => ({ name: 'Օրական ամփոփում', trigger: daily, conditions: [], actions: [{ type: 'sendSummary', kind: 'daily', telegram: true, emails: '' }], ...over });
const outbox = (db) => db.prepare('SELECT channel, recipient, kind FROM outbox ORDER BY id').all();

test('tick: runs once per slot', () => {
  const { service, db } = makeService(telegramCfg);
  saveDue(service, db, summaryRule());
  service.automations.tick(at('2026-11-27T19:00:00'));
  assert.equal(outbox(db).length, 0);
  service.automations.tick(at('2026-11-27T20:05:00'));
  service.automations.tick(at('2026-11-27T20:06:00'));
  assert.equal(outbox(db).length, 1);
  assert.equal(ok(service.call('automations.runs', {})).length, 1);
});

test('tick: the next day runs again', () => {
  const { service, db } = makeService(telegramCfg);
  saveDue(service, db, summaryRule());
  service.automations.tick(at('2026-11-27T20:05:00'));
  service.automations.tick(at('2026-11-28T20:05:00'));
  assert.equal(outbox(db).length, 2);
});

test('tick: a failing scheduled rule is logged once per slot, not every minute', () => {
  const { service, db } = makeService(); // no Telegram, no email: nobody to send to
  saveDue(service, db, summaryRule());
  service.automations.tick(at('2026-11-27T20:05:00'));
  service.automations.tick(at('2026-11-27T20:06:00'));
  const runs = ok(service.call('automations.runs', {}));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
});

test('sendSummary: daily summary to Telegram chats and email addresses', () => {
  const { service, db } = makeService({ ...telegramCfg, email: { enabled: true, host: 'smtp.test' } });
  saveDue(service, db, summaryRule({ actions: [{ type: 'sendSummary', kind: 'daily', telegram: true, emails: 'boss@club.am' }] }));
  service.automations.tick(at('2026-11-27T20:05:00'));
  assert.deepEqual(outbox(db), [
    { channel: 'telegram', recipient: '1', kind: 'daily' },
    { channel: 'email', recipient: 'boss@club.am', kind: 'daily' },
  ]);
});

test('sendReminders: skips students already reminded this month', () => {
  const { service, db } = makeService({ email: { enabled: true, host: 'smtp.test' } });
  const g = ok(service.call('groups.save', { name: 'A', monthly_fee: 30000 })).id;
  const sid = ok(service.call('students.save', { first_name: 'Ա', last_name: 'Բ', group_id: g, monthly_fee: 30000, status: 'active', join_date: '2025-01-01', parent_email: 'p@test.am' })).id;
  // An overdue fee: a charge due in the past.
  db.prepare(`INSERT INTO charges (student_id, kind, period, amount, due_date, status) VALUES (?, 'monthly', '2025-06', 30000, '2025-06-15', 'unpaid')`).run(sid);
  saveDue(service, db, { name: 'Հիշեցումներ', trigger: { type: 'schedule', every: 'monthly', day: 20, time: '09:00' }, conditions: [], actions: [{ type: 'sendReminders' }] });
  service.automations.tick(at('2026-11-20T09:05:00'));
  const reminders = () => db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'reminder'`).get().n;
  assert.equal(reminders(), 1);
  db.prepare(`UPDATE automations SET schedule_state = NULL`).run(); // as if run again the same month
  service.automations.tick(at('2026-11-21T09:05:00'));
  assert.equal(reminders(), 1);
});

test('tick: prunes runs older than 12 months', () => {
  const { service, db } = makeService();
  const add = (age) => db.prepare(`INSERT INTO automation_runs (automation_id, rule_name, at, status) VALUES (1, 'x', datetime('now', 'localtime', ?), 'done')`).run(age);
  add('-13 months');
  add('-11 months');
  service.automations.tick(new Date());
  const left = db.prepare('SELECT COUNT(*) AS n FROM automation_runs').get().n;
  assert.equal(left, 1);
});
