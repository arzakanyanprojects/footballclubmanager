// Test helpers: a real service on a fresh temporary database (the service runs under plain Node).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../electron/db');
const { createService } = require('../electron/service');

function makeService(notifyCfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-test-'));
  const db = openDatabase(path.join(dir, 'test.db'));
  const service = createService(db, { getNotify: () => notifyCfg });
  return { service, db, dir };
}

// Unwraps a call, failing the test on an error result.
function ok(r) {
  if (!r || !r.ok) throw new Error(`call failed: ${JSON.stringify(r)}`);
  return r.result;
}

// Two groups (regular 30 000, championship 35 000) and one active student in the regular one.
function seed(service, { fee = 30000, category = null } = {}) {
  const regular = ok(service.call('groups.save', { name: 'A', monthly_fee: 30000, championship: 0 })).id;
  const champ = ok(service.call('groups.save', { name: 'C', monthly_fee: 35000, championship: 1 })).id;
  const studentId = ok(
    service.call('students.save', {
      first_name: 'Արամ', last_name: 'Պետրոսյան', group_id: regular, monthly_fee: fee, category,
      status: 'active', join_date: '2026-01-01',
    })
  ).id;
  return { regular, champ, studentId };
}

// A scheduled rule saved now starts with its next slot; tests that check a run «when it is due» save it as
// never having run (independent of the real clock).
function saveDue(service, db, rule) {
  const { id } = ok(service.call('automations.save', rule));
  db.prepare('UPDATE automations SET schedule_state = NULL WHERE id = ?').run(id);
  return id;
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

module.exports = { makeService, ok, seed, columns, saveDue };
