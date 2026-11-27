const test = require('node:test');
const assert = require('node:assert');
const { makeService, ok, seed } = require('./helpers');

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const cfgAll = (over = {}) => ({
  email: { enabled: true, host: 'smtp.test' },
  telegram: { enabled: true, token: 't', chats: [{ id: 1 }] },
  receipts: true,
  paymentAlerts: true,
  reminders: { auto: true, day: 20 },
  daily: { enabled: true, time: '20:00' },
  monthly: { enabled: true },
  summaryEmails: 'boss@club.am',
  templates: {},
  state: {},
  ...over,
});
const names = (service) => ok(service.call('automations.list', {})).map((r) => r.name).sort();

test('migrate: only enabled switches become rules', () => {
  const cfg = cfgAll({ paymentAlerts: false, monthly: { enabled: false } });
  const { service } = makeService(cfg);
  const created = service.automations.migrateNotify(cfg);
  assert.equal(created.length, 3);
  assert.deepEqual(names(service), ['Անդորրագիր ծնողին', 'Օրական ամփոփում', 'Պարտքի հիշեցումներ'].sort());
});

test('migrate: nothing enabled creates nothing', () => {
  const cfg = cfgAll({ receipts: false, paymentAlerts: false, reminders: { auto: false, day: 20 }, daily: { enabled: false, time: '20:00' }, monthly: { enabled: false } });
  const { service } = makeService(cfg);
  assert.deepEqual(service.automations.migrateNotify(cfg), []);
});

test('migrate: second call creates nothing', () => {
  const cfg = cfgAll();
  const { service } = makeService(cfg);
  assert.equal(service.automations.migrateNotify(cfg).length, 5);
  assert.deepEqual(service.automations.migrateNotify(cfg), []);
  assert.equal(names(service).length, 5);
});

test('migrate: receipt rule sends the same email text as before for a payment', () => {
  const cfg = cfgAll({ paymentAlerts: false, reminders: { auto: false }, daily: { enabled: false }, monthly: { enabled: false } });
  const { service, db } = makeService(cfg);
  service.automations.migrateNotify(cfg);
  const { studentId } = seed(service);
  ok(service.call('students.save', { ...ok(service.call('students.get', { id: studentId })).student, parent_email: 'p@test.am', parent_first_name: 'Անի' }));
  ok(service.call('charges.payMonths', { studentId, periods: ['2026-11'], method: 'card' }));
  const mails = db.prepare(`SELECT recipient, subject, body FROM outbox WHERE channel = 'email'`).all();
  assert.equal(mails.length, 1, 'one receipt (the old fixed receipt is gone)');
  assert.equal(mails[0].recipient, 'p@test.am');
  assert.equal(mails[0].subject, 'Վճարումն ընդունված է — Արամ Պետրոսյան');
  assert.match(mails[0].body, /Անի/);
  assert.doesNotMatch(mails[0].body, /\{\w+\}/, 'every placeholder filled');
});

test('migrate: a parent without email is skipped, not failed', () => {
  const cfg = cfgAll({ paymentAlerts: false, reminders: { auto: false }, daily: { enabled: false }, monthly: { enabled: false } });
  const { service } = makeService(cfg);
  service.automations.migrateNotify(cfg);
  const { studentId } = seed(service);
  ok(service.call('charges.payMonths', { studentId, periods: ['2026-11'], method: 'card' }));
  assert.equal(ok(service.call('automations.runs', {}))[0].status, 'skipped');
});

test('migrate: payment alert goes to Telegram with who took it', () => {
  const cfg = cfgAll({ receipts: false, reminders: { auto: false }, daily: { enabled: false }, monthly: { enabled: false } });
  const { service, db } = makeService(cfg);
  service.automations.migrateNotify(cfg);
  const { studentId } = seed(service);
  ok(service.call('charges.payMonths', { studentId, periods: ['2026-11'], method: 'card' }, { user: 'Նարինե' }));
  const [tg] = db.prepare(`SELECT body FROM outbox WHERE channel = 'telegram'`).all();
  assert.match(tg.body, /^💳 Վճարում — Արամ Պետրոսյան/);
  assert.match(tg.body, /Գրանցող՝ Նարինե/);
});

test('migrate: a summary already sent today is not sent again after the upgrade', () => {
  const cfg = cfgAll({ receipts: false, paymentAlerts: false, reminders: { auto: false }, monthly: { enabled: false }, daily: { enabled: true, time: '00:00' }, state: { daily: today() } });
  const { service, db } = makeService(cfg);
  service.automations.migrateNotify(cfg);
  service.automations.tick(new Date());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
});
