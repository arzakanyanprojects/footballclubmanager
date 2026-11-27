const test = require('node:test');
const assert = require('node:assert');
const { matches } = require('../electron/automations');
const { makeService, ok, seed } = require('./helpers');

const facts = {
  group: 7, 'group.championship': true,
  oldGroup: 3, 'oldGroup.championship': false, newGroup: 7, 'newGroup.championship': true,
  category: '', oldCategory: '', newCategory: '', status: 'active', oldStatus: 'active', newStatus: 'active',
  fee: 15000,
};
const c = (field, op, value) => [{ field, op, value }];

test('conditions: empty list matches', () => assert.equal(matches([], facts), true));
test('conditions: championship is true/false', () => {
  assert.equal(matches(c('newGroup.championship', 'is', true), facts), true);
  assert.equal(matches(c('oldGroup.championship', 'is', true), facts), false);
});
test('conditions: group is / isNot / in / notIn', () => {
  assert.equal(matches(c('group', 'is', 7), facts), true);
  assert.equal(matches(c('group', 'isNot', 7), facts), false);
  assert.equal(matches(c('group', 'in', [1, 7]), facts), true);
  assert.equal(matches(c('group', 'notIn', [1, 7]), facts), false);
  assert.equal(matches(c('group', 'is', '7'), facts), true, 'ids from a select come as strings');
});
test('conditions: category "" matches no category', () => {
  assert.equal(matches(c('category', 'is', ''), facts), true);
  assert.equal(matches(c('category', 'in', ['siblings', 'staff']), facts), false);
});
test('conditions: fee lt / gt / eq', () => {
  assert.equal(matches(c('fee', 'lt', 20000), facts), true);
  assert.equal(matches(c('fee', 'gt', 20000), facts), false);
  assert.equal(matches(c('fee', 'eq', 15000), facts), true);
});
test('conditions: payment facts', () => {
  const pf = { ...facts, 'payment.total': 45000, 'payment.method': 'card', 'payment.hasMonthly': true };
  assert.equal(matches(c('payment.total', 'gt', 0), pf), true);
  assert.equal(matches(c('payment.method', 'is', 'cash'), pf), false);
  assert.equal(matches(c('payment.hasMonthly', 'is', true), pf), true);
});
test('conditions: all must match', () => {
  assert.equal(matches([...c('fee', 'lt', 20000), ...c('group', 'is', 99)], facts), false);
});
test('conditions: unknown field or missing fact is false, never throws', () => {
  assert.equal(matches(c('shoeSize', 'is', 1), facts), false);
  assert.equal(matches(c('payment.total', 'gt', 0), facts), false);
  assert.equal(matches(c('oldGroup', 'isNot', 5), { ...facts, oldGroup: undefined }), false);
});

test('conditions: championship example matches only regular → championship moves', () => {
  const { service } = makeService();
  const { regular, champ, studentId } = seed(service);
  const regular2 = ok(service.call('groups.save', { name: 'B', monthly_fee: 30000, championship: 0 })).id;
  ok(service.call('automations.save', {
    name: 'Առաջնություն',
    trigger: { type: 'student.groupChanged' },
    conditions: [{ field: 'oldGroup.championship', op: 'is', value: false }, { field: 'newGroup.championship', op: 'is', value: true }],
    actions: [{ type: 'addNote', text: '{oldGroup} → {newGroup}' }],
  }));
  const move = (g) => ok(service.call('students.save', { ...ok(service.call('students.get', { id: studentId })).student, group_id: g }));
  move(regular2); // regular → regular: no
  move(champ); // regular → championship: yes
  move(regular); // championship → regular: no
  const notes = ok(service.call('students.get', { id: studentId })).notes.map((n) => n.text);
  assert.deepEqual(notes, ['B → C']);
});
