const test = require('node:test');
const assert = require('node:assert');
const { makeService, ok, seed } = require('./helpers');

const noteRule = (over = {}) => ({
  name: 'Նշում խմբափոխության համար',
  trigger: { type: 'student.groupChanged' },
  conditions: [],
  actions: [{ type: 'addNote', text: '{oldGroup} → {newGroup}' }],
  ...over,
});
const student = (service, id) => ok(service.call('students.get', { id }));
const moveTo = (service, id, groupId, extra = {}) => {
  const s = student(service, id).student;
  return service.call('students.save', { ...s, group_id: groupId, ...extra });
};

test('engine: groupChanged rule adds a note when the group changes', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', noteRule()));
  ok(moveTo(service, studentId, champ));
  const notes = student(service, studentId).notes.map((n) => n.text);
  assert.ok(notes.includes('A → C'), JSON.stringify(notes));
});

test('engine: saving without a group change runs nothing', () => {
  const { service } = makeService();
  const { regular, studentId } = seed(service);
  ok(service.call('automations.save', noteRule()));
  ok(moveTo(service, studentId, regular, { phone: '099' }));
  assert.equal(student(service, studentId).notes.length, 0);
  assert.equal(ok(service.call('automations.runs', {})).length, 0);
});

test('engine: disabled rule does nothing', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', noteRule({ enabled: false })));
  ok(moveTo(service, studentId, champ));
  assert.equal(student(service, studentId).notes.length, 0);
});

test('engine: rule for statusChanged ignores a group change', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', noteRule({ trigger: { type: 'student.statusChanged' } })));
  ok(moveTo(service, studentId, champ));
  assert.equal(student(service, studentId).notes.length, 0);
});

test('engine: statusChanged fires on termination', () => {
  const { service } = makeService();
  const { studentId } = seed(service);
  ok(service.call('automations.save', noteRule({ trigger: { type: 'student.statusChanged' }, actions: [{ type: 'addNote', text: '{oldStatus} → {newStatus}' }] })));
  ok(service.call('students.terminate', { id: studentId, date: '2026-11-27', reason: 'test' }));
  assert.equal(student(service, studentId).notes.length, 1);
});

test('engine: student.created fires for a new student', () => {
  const { service } = makeService();
  ok(service.call('automations.save', noteRule({ trigger: { type: 'student.created' }, actions: [{ type: 'addNote', text: 'Բարի գալուստ {student}' }] })));
  const { studentId } = seed(service);
  assert.deepEqual(student(service, studentId).notes.map((n) => n.text), ['Բարի գալուստ Արամ Պետրոսյան']);
});

test('engine: payment.received fires once for a payment of several months', () => {
  const { service } = makeService();
  const { studentId } = seed(service);
  ok(service.call('automations.save', noteRule({ trigger: { type: 'payment.received' }, actions: [{ type: 'addNote', text: 'Վճարվեց {total}' }] })));
  ok(service.call('charges.payMonths', { studentId, periods: ['2026-11', '2026-12'], method: 'cash' }));
  const data = student(service, studentId);
  const notes = data.notes.map((n) => n.text);
  assert.equal(notes.length, 1, JSON.stringify(notes));
  // The sum of the months just paid (the app prices each month itself, e.g. holiday shares).
  const paid = data.charges.filter((c) => c.status === 'paid' && ['2026-11', '2026-12'].includes(c.period)).reduce((s, c) => s + c.amount, 0);
  assert.equal(paid > 0, true);
  assert.equal(notes[0], `Վճարվեց ${paid.toLocaleString('en-US')} ֏`);
});

test('engine: failing rule leaves the save in place and is logged as failed', () => {
  const { service, db } = makeService();
  const { champ, studentId } = seed(service);
  // A rule from a newer version (an action this version doesn't know) fails as a whole.
  db.prepare(`INSERT INTO automations (name, enabled, trigger, conditions, actions) VALUES ('Նոր', 1, ?, '[]', ?)`).run(
    JSON.stringify({ type: 'student.groupChanged' }),
    JSON.stringify([{ type: 'addNote', text: 'x' }, { type: 'fromTheFuture' }])
  );
  const r = moveTo(service, studentId, champ);
  assert.equal(r.ok, true);
  assert.equal(student(service, studentId).student.group_id, champ);
  assert.equal(student(service, studentId).notes.length, 0, 'the rule is rolled back as a whole');
  const [run] = ok(service.call('automations.runs', {}));
  assert.equal(run.status, 'failed');
  assert.equal(run.student_id, studentId);
});

test('engine: call result carries the automations that ran', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', noteRule()));
  const r = moveTo(service, studentId, champ);
  assert.equal(r.automations.length, 1);
  assert.equal(r.automations[0].name, noteRule().name);
  assert.equal(r.automations[0].status, 'done');
});

test('engine: rule note shows in student history under the rule name', () => {
  const { service } = makeService();
  const { champ, studentId } = seed(service);
  ok(service.call('automations.save', noteRule()));
  ok(moveTo(service, studentId, champ));
  const hist = ok(service.call('students.history', { id: studentId }));
  const events = hist.events || hist;
  assert.ok(events.some((e) => e.action === 'note.added' && e.user === `Ավտոմատացում · ${noteRule().name}`), JSON.stringify(events.slice(0, 5)));
});
