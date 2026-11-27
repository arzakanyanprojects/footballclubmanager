const test = require('node:test');
const assert = require('node:assert');
const { keepDiscountFee } = require('../electron/automations');
const { makeService, ok, seed } = require('./helpers');

const champRule = (actions) => ({
  name: 'Առաջնություն',
  trigger: { type: 'student.groupChanged' },
  conditions: [{ field: 'oldGroup.championship', op: 'is', value: false }, { field: 'newGroup.championship', op: 'is', value: true }],
  actions,
});
const keepDiscount = [{ type: 'setFee', mode: 'keepDiscount' }, { type: 'addNote', text: '{oldFee} → {newFee}' }];
const get = (service, id) => ok(service.call('students.get', { id }));
const save = (service, id, patch) => service.call('students.save', { ...get(service, id).student, ...patch });
const thisMonth = () => new Date().toISOString().slice(0, 7);
const monthCharge = (service, id) => get(service, id).charges.find((c) => c.kind === 'monthly' && c.period === thisMonth() && c.status === 'unpaid');
const lastRun = (service) => ok(service.call('automations.runs', {}))[0];

test('keepDiscountFee: keeps the share of the group price, rounded to 500', () => {
  assert.equal(keepDiscountFee(15000, 30000, 35000), 17500);
  assert.equal(keepDiscountFee(30000, 30000, 35000), 35000);
  assert.equal(keepDiscountFee(0, 30000, 35000), 0);
  assert.equal(keepDiscountFee(20000, 30000, 35000), 23500);
  assert.equal(keepDiscountFee(30000, 0, 35000), null);
  assert.equal(keepDiscountFee(30000, 30000, 0), null);
});

test('actions: championship example — half price becomes 17 500, this month re-priced, note added', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service, { fee: 15000, category: 'siblings' });
  ok(service.call('automations.save', champRule(keepDiscount)));
  const before = monthCharge(service, studentId);
  ok(save(service, studentId, { group_id: champ }));
  const s = get(service, studentId);
  assert.equal(s.student.monthly_fee, 17500);
  if (before) assert.equal(monthCharge(service, studentId).amount, Math.round((before.amount * 17500) / 15000));
  assert.deepEqual(s.notes.map((n) => n.text), ['15,000 ֏ → 17,500 ֏']);
  assert.equal(lastRun(service).status, 'done');
});

test('actions: full price 30 000 becomes 35 000', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service, { fee: 30000, category: 'staff' });
  ok(service.call('automations.save', champRule(keepDiscount)));
  ok(save(service, studentId, { group_id: champ }));
  assert.equal(get(service, studentId).student.monthly_fee, 35000);
});

test('actions: «Ըստ հրամանի» fee is not changed, the note is still added', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service, { fee: 20000, category: 'order' });
  ok(service.call('automations.save', champRule(keepDiscount)));
  ok(save(service, studentId, { group_id: champ }));
  const s = get(service, studentId);
  assert.equal(s.student.monthly_fee, 20000);
  assert.equal(s.notes.length, 1);
  const run = lastRun(service);
  assert.equal(run.detail[0].status, 'skipped');
  assert.match(run.detail[0].text, /հրաման/);
});

test('actions: a fee typed by hand in the same save is kept', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service, { fee: 30000 });
  ok(service.call('automations.save', champRule(keepDiscount)));
  ok(save(service, studentId, { group_id: champ, monthly_fee: 32000 }));
  assert.equal(get(service, studentId).student.monthly_fee, 32000);
  assert.equal(lastRun(service).detail[0].status, 'skipped');
});

test('actions: fixed fee sets the amount', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', champRule([{ type: 'setFee', mode: 'fixed', amount: 35000 }])));
  ok(save(service, studentId, { group_id: champ }));
  assert.equal(get(service, studentId).student.monthly_fee, 35000);
});

test('actions: sendEmail without email set up fails with the reason', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', champRule([{ type: 'sendEmail', to: 'boss@club.am', subject: 'x', body: 'y' }])));
  ok(save(service, studentId, { group_id: champ }));
  const run = lastRun(service);
  assert.equal(run.status, 'failed');
  assert.match(run.detail[0].text, /փոստ/);
});

test('actions: sendEmail to the parent and an address queues filled emails', () => {
  const { service, db } = makeService({ email: { enabled: true, host: 'smtp.test' } });
  const { champ, studentId } = seed(service);
  ok(save(service, studentId, { parent_email: 'parent@test.am' }));
  ok(service.call('automations.save', champRule([{ type: 'sendEmail', toParent: true, to: 'boss@club.am', subject: '{student} — {newGroup}', body: 'Բարև, {parent}' }])));
  ok(save(service, studentId, { group_id: champ }));
  const rows = db.prepare(`SELECT recipient, subject, kind, student_id FROM outbox ORDER BY id`).all();
  assert.deepEqual(rows.map((r) => r.recipient).sort(), ['boss@club.am', 'parent@test.am']);
  assert.equal(rows[0].subject, 'Արամ Պետրոսյան — C');
  assert.equal(rows[0].kind, 'automation');
});

test('actions: sendTelegram queues one message per chat', () => {
  const { service, db } = makeService({ telegram: { enabled: true, token: 't', chats: [{ id: 1 }, { id: 2 }, { id: 3, on: false }] } });
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', champRule([{ type: 'sendTelegram', text: '{student}՝ {newGroup}' }])));
  ok(save(service, studentId, { group_id: champ }));
  const rows = db.prepare(`SELECT recipient, body FROM outbox WHERE channel = 'telegram'`).all();
  assert.deepEqual(rows.map((r) => r.recipient), ['1', '2']);
  assert.equal(rows[0].body, 'Արամ Պետրոսյան՝ C');
});

test('actions: addDebt creates an unpaid charge', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', champRule([{ type: 'addDebt', amount: 5000, month: 'this', note: 'Համազգեստ' }])));
  ok(save(service, studentId, { group_id: champ }));
  const debt = get(service, studentId).charges.find((c) => c.amount === 5000);
  assert.ok(debt, 'debt created');
  assert.equal(debt.status, 'unpaid');
  assert.match(debt.description || '', /Համազգեստ/);
});

test('actions: setCategory changes Կարգավիճակ and does not start other rules', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', champRule([{ type: 'setCategory', value: 'staff' }])));
  ok(service.call('automations.save', { name: 'Կարգավիճակի նշում', trigger: { type: 'student.categoryChanged' }, conditions: [], actions: [{ type: 'addNote', text: '{newCategory}' }] }));
  ok(save(service, studentId, { group_id: champ }));
  const s = get(service, studentId);
  assert.equal(s.student.category, 'staff');
  assert.equal(s.notes.length, 0, 'the rule’s own change does not trigger the note rule');
  ok(save(service, studentId, { category: 'siblings' }));
  assert.equal(get(service, studentId).notes.length, 1, 'a user’s change does');
});
