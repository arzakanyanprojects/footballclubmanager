const test = require('node:test');
const assert = require('node:assert');
const { makeService, columns } = require('./helpers');

test('storage: migration creates automations tables', () => {
  const { db } = makeService();
  assert.ok(columns(db, 'automations').includes('trigger'));
  assert.ok(columns(db, 'automations').includes('schedule_state'));
  assert.ok(columns(db, 'automation_runs').includes('rule_name'));
  assert.ok(columns(db, 'outbox').includes('attachment'));
});
