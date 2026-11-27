const test = require('node:test');
const assert = require('node:assert');
const { makeService, ok } = require('./helpers');

const championshipRule = {
  name: 'Առաջնություն → 35 000',
  enabled: true,
  trigger: { type: 'student.groupChanged' },
  conditions: [
    { field: 'oldGroup.championship', op: 'is', value: false },
    { field: 'newGroup.championship', op: 'is', value: true },
  ],
  actions: [
    { type: 'setFee', mode: 'keepDiscount' },
    { type: 'addNote', text: 'Տեղափոխվեց {newGroup}, ամսավճարը՝ {newFee}' },
  ],
};

test('crud: save and list round-trips trigger, conditions, actions', () => {
  const { service } = makeService();
  const { id } = ok(service.call('automations.save', championshipRule));
  const list = ok(service.call('automations.list', {}));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].name, championshipRule.name);
  assert.equal(list[0].enabled, 1);
  assert.deepEqual(list[0].trigger, championshipRule.trigger);
  assert.deepEqual(list[0].conditions, championshipRule.conditions);
  assert.deepEqual(list[0].actions, championshipRule.actions);
  assert.equal(list[0].runs_count, 0);
});

test('crud: save with id updates the rule', () => {
  const { service } = makeService();
  const { id } = ok(service.call('automations.save', championshipRule));
  ok(service.call('automations.save', { ...championshipRule, id, name: 'Նոր անուն', enabled: false }));
  const [r] = ok(service.call('automations.list', {}));
  assert.equal(r.name, 'Նոր անուն');
  assert.equal(r.enabled, 0);
});

test('crud: rejects a rule without a name', () => {
  const { service } = makeService();
  const r = service.call('automations.save', { ...championshipRule, name: '  ' });
  assert.equal(r.error, 'NAME_REQUIRED');
});

test('crud: rejects unknown trigger type', () => {
  const { service } = makeService();
  const r = service.call('automations.save', { ...championshipRule, trigger: { type: 'student.flew' } });
  assert.equal(r.error, 'AUTOMATION_INVALID');
  assert.equal(r.detail.field, 'trigger');
});

test('crud: rejects unknown action type', () => {
  const { service } = makeService();
  const r = service.call('automations.save', { ...championshipRule, actions: [{ type: 'launchRocket' }] });
  assert.equal(r.error, 'AUTOMATION_INVALID');
  assert.equal(r.detail.field, 'actions');
});

test('crud: rejects setFee without a mode', () => {
  const { service } = makeService();
  const r = service.call('automations.save', { ...championshipRule, actions: [{ type: 'setFee' }] });
  assert.equal(r.error, 'AUTOMATION_INVALID');
});

test('crud: rejects unknown condition field or op', () => {
  const { service } = makeService();
  assert.equal(service.call('automations.save', { ...championshipRule, conditions: [{ field: 'shoeSize', op: 'is', value: 1 }] }).error, 'AUTOMATION_INVALID');
  assert.equal(service.call('automations.save', { ...championshipRule, conditions: [{ field: 'fee', op: 'approx', value: 1 }] }).error, 'AUTOMATION_INVALID');
});

test('crud: rejects a schedule without a valid time', () => {
  const { service } = makeService();
  const r = service.call('automations.save', { ...championshipRule, trigger: { type: 'schedule', every: 'daily', time: '25:00' }, conditions: [], actions: [{ type: 'sendReminders' }] });
  assert.equal(r.error, 'AUTOMATION_INVALID');
});

test('crud: delete keeps runs', () => {
  const { service, db } = makeService();
  const { id } = ok(service.call('automations.save', championshipRule));
  db.prepare(`INSERT INTO automation_runs (automation_id, rule_name, status, detail) VALUES (?, ?, 'done', '[]')`).run(id, championshipRule.name);
  ok(service.call('automations.delete', { id }));
  assert.equal(ok(service.call('automations.list', {})).length, 0);
  const runs = ok(service.call('automations.runs', {}));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].rule_name, championshipRule.name);
});

test('crud: non-admin without settings.automations gets FORBIDDEN', () => {
  const { service } = makeService();
  ok(service.call('users.save', { username: 'admin', password: 'admin1', perms: [] }));
  ok(service.call('users.save', { username: 'clerk', password: 'clerk1', perms: ['students.view'] }, { token: ok(service.call('auth.login', { username: 'admin', password: 'admin1' })).token }));
  const token = ok(service.call('auth.login', { username: 'clerk', password: 'clerk1' })).token;
  assert.equal(service.call('automations.list', {}, { token }).error, 'FORBIDDEN');
  assert.equal(service.call('automations.save', championshipRule, { token }).error, 'FORBIDDEN');
});

test('crud: user with settings.automations may manage rules', () => {
  const { service } = makeService();
  ok(service.call('users.save', { username: 'admin', password: 'admin1', perms: [] }));
  const admin = ok(service.call('auth.login', { username: 'admin', password: 'admin1' })).token;
  ok(service.call('users.save', { username: 'boss', password: 'boss12', perms: ['settings.automations'] }, { token: admin }));
  const token = ok(service.call('auth.login', { username: 'boss', password: 'boss12' })).token;
  ok(service.call('automations.save', championshipRule, { token }));
  assert.equal(ok(service.call('automations.list', {}, { token })).length, 1);
});
