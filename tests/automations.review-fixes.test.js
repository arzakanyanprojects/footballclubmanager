// Fixes from the final review of the automations work.
const test = require('node:test');
const assert = require('node:assert');
const { makeService, ok, seed } = require('./helpers');

const noteOnGroupChange = { name: 'Նշում', trigger: { type: 'student.groupChanged' }, conditions: [], actions: [{ type: 'addNote', text: '{newGroup}' }] };
const get = (service, id) => ok(service.call('students.get', { id }));

test('review: a rule that breaks before it starts does not make the committed save look failed', () => {
  const { service, db } = makeService();
  const { champ, studentId } = seed(service);
  // A damaged rule row (conditions not a list) — it can't even be checked.
  db.prepare(`INSERT INTO automations (name, enabled, trigger, conditions, actions) VALUES ('Վնասված', 1, ?, '{}', '[]')`).run(JSON.stringify({ type: 'student.groupChanged' }));
  ok(service.call('automations.save', noteOnGroupChange));
  const r = service.call('students.save', { ...get(service, studentId).student, group_id: champ });
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = get(service, studentId);
  assert.equal(s.student.group_id, champ);
  assert.deepEqual(s.notes.map((n) => n.text), ['C'], 'the other rule still runs');
  const runs = ok(service.call('automations.runs', {}));
  assert.ok(runs.some((x) => x.rule_name === 'Վնասված' && x.status === 'failed'), JSON.stringify(runs));
});

test('review: a new monthly rule whose day already passed waits for next month', () => {
  const { service, db } = makeService({ telegram: { enabled: true, token: 't', chats: [{ id: 1 }] } });
  ok(service.call('automations.save', { name: 'Ամսական', trigger: { type: 'schedule', every: 'monthly', day: 1, time: '00:00' }, conditions: [], actions: [{ type: 'sendSummary', kind: 'monthly', telegram: true, emails: '' }] }));
  const now = new Date();
  service.automations.tick(now);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0, 'not sent the moment it is saved');
  service.automations.tick(new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 5));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1, 'sent on next month’s day');
});

test('review: a daily rule saved after its time today starts tomorrow', () => {
  const { service, db } = makeService({ telegram: { enabled: true, token: 't', chats: [{ id: 1 }] } });
  ok(service.call('automations.save', { name: 'Օրական', trigger: { type: 'schedule', every: 'daily', time: '00:00' }, conditions: [], actions: [{ type: 'sendSummary', kind: 'daily', telegram: true, emails: '' }] }));
  service.automations.tick(new Date());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
});

test('review: turning a scheduled rule back on does not send for the slot already past', () => {
  const { service, db } = makeService({ telegram: { enabled: true, token: 't', chats: [{ id: 1 }] } });
  const rule = { name: 'Օրական', enabled: false, trigger: { type: 'schedule', every: 'daily', time: '00:00' }, conditions: [], actions: [{ type: 'sendSummary', kind: 'daily', telegram: true, emails: '' }] };
  const { id } = ok(service.call('automations.save', rule));
  db.prepare('UPDATE automations SET schedule_state = NULL WHERE id = ?').run(id); // as if it never ran
  ok(service.call('automations.save', { ...rule, id, enabled: true }));
  service.automations.tick(new Date());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
});

test('review: linking a sibling that sets «2 և ավել երեխա» starts Կարգավիճակ rules', () => {
  const { service } = makeService();
  const { regular, studentId } = seed(service);
  const other = ok(service.call('students.save', { first_name: 'Անի', last_name: 'Պետրոսյան', group_id: regular, monthly_fee: 30000, status: 'active', join_date: '2026-01-01' })).id;
  ok(service.call('automations.save', { name: 'Եղբայր/քույր', trigger: { type: 'student.categoryChanged' }, conditions: [], actions: [{ type: 'addNote', text: '{oldCategory} → {newCategory}' }] }));
  ok(service.call('students.link', { id: studentId, otherId: other, relation: 'sibling', setCategory: true }));
  const s = get(service, other);
  assert.equal(s.student.category, 'siblings');
  assert.deepEqual(s.notes.map((n) => n.text), ['Առանց կարգավիճակ → 2 և ավել երեխա']);
});

test('review: the outbox has labels for the automations’ messages', async () => {
  const { dictionaries } = await import('../electron/locales.mjs');
  for (const lang of ['en', 'hy']) for (const kind of ['automation', 'report']) assert.ok(dictionaries[lang][`notify.kind_${kind}`], `${lang} notify.kind_${kind}`);
});
