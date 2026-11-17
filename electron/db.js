const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version):
// an SQL script, or a function for steps that need more than SQL.
const MIGRATIONS = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE groups (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    coach       TEXT,
    schedule    TEXT,
    monthly_fee INTEGER NOT NULL DEFAULT 0,
    color       TEXT,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE students (
    id           INTEGER PRIMARY KEY,
    first_name   TEXT NOT NULL,
    last_name    TEXT NOT NULL,
    birth_date   TEXT,
    gender       TEXT,
    phone        TEXT,
    email        TEXT,
    address      TEXT,
    document_no  TEXT,
    parent_name  TEXT,
    parent_phone TEXT,
    group_id     INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    monthly_fee  INTEGER NOT NULL DEFAULT 0,
    join_date    TEXT NOT NULL,
    billing_from TEXT,
    leave_date   TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    notes        TEXT,
    photo        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at   TEXT
  );
  CREATE INDEX ix_students_group ON students(group_id);

  CREATE TABLE products (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    price    INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  );

  -- Everything a student owes: monthly fees, kit/clothes purchases, other one-off charges.
  CREATE TABLE charges (
    id          INTEGER PRIMARY KEY,
    student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,              -- monthly | product | other
    period      TEXT,                       -- YYYY-MM for monthly fees
    product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
    description TEXT,
    quantity    INTEGER NOT NULL DEFAULT 1,
    amount      INTEGER NOT NULL,
    due_date    TEXT,
    status      TEXT NOT NULL DEFAULT 'unpaid', -- unpaid | paid | waived
    paid_at     TEXT,
    method      TEXT,                       -- easypay | card | transfer
    note        TEXT,
    created_by  TEXT,
    paid_by     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE UNIQUE INDEX ux_charges_monthly ON charges(student_id, period) WHERE kind = 'monthly';
  CREATE INDEX ix_charges_student ON charges(student_id);
  CREATE INDEX ix_charges_status ON charges(status, due_date);
  CREATE INDEX ix_charges_paid ON charges(paid_at);

  CREATE TABLE attendance (
    id         INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    status     TEXT NOT NULL,               -- present | absent | late | excused
    group_id   INTEGER,
    marked_by  TEXT,
    UNIQUE (student_id, date)
  );
  CREATE INDEX ix_attendance_date ON attendance(date);

  CREATE TABLE contract_templates (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT
  );

  CREATE TABLE contracts (
    id          INTEGER PRIMARY KEY,
    number      TEXT,
    student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    template_id INTEGER REFERENCES contract_templates(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    start_date  TEXT,
    end_date    TEXT,
    status      TEXT NOT NULL DEFAULT 'draft', -- draft | signed | terminated
    signed_date TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at  TEXT
  );
  CREATE INDEX ix_contracts_student ON contracts(student_id);

  CREATE TABLE activity_log (
    id      INTEGER PRIMARY KEY,
    at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    user    TEXT,
    action  TEXT NOT NULL,
    details TEXT
  );
  `,
  // v2: whether the student's medical certificate has been handed in.
  `
  ALTER TABLE students ADD COLUMN medical_doc INTEGER NOT NULL DEFAULT 0;
  `,
  // v3: the student's patronymic (Հայրանուն, the father's first name).
  `
  ALTER TABLE students ADD COLUMN patronymic TEXT;
  `,
  // v4: benefit category (siblings | half | war | staff), shown as Կարգավիճակ.
  `
  ALTER TABLE students ADD COLUMN category TEXT;
  `,
  // v5: number of the student's (paper) contract.
  `
  ALTER TABLE students ADD COLUMN contract_no TEXT;
  `,
  // v6: full parent details for contracts. parent_name stays as "first last" for lists and search.
  `
  ALTER TABLE students ADD COLUMN parent_first_name TEXT;
  ALTER TABLE students ADD COLUMN parent_last_name TEXT;
  ALTER TABLE students ADD COLUMN parent_doc_no TEXT;
  ALTER TABLE students ADD COLUMN parent_doc_issuer TEXT;
  ALTER TABLE students ADD COLUMN parent_doc_date TEXT;
  ALTER TABLE students ADD COLUMN parent_ssn TEXT;
  ALTER TABLE students ADD COLUMN parent_address TEXT;
  ALTER TABLE students ADD COLUMN parent_email TEXT;
  UPDATE students SET
    parent_first_name = CASE WHEN instr(trim(parent_name), ' ') > 0
                             THEN substr(trim(parent_name), 1, instr(trim(parent_name), ' ') - 1) ELSE trim(parent_name) END,
    parent_last_name = CASE WHEN instr(trim(parent_name), ' ') > 0
                            THEN trim(substr(trim(parent_name), instr(trim(parent_name), ' ') + 1)) END,
    parent_address = address,
    parent_email = email;
  `,
  // v7: why a student became inactive (Պատճառ).
  `
  ALTER TABLE students ADD COLUMN inactive_reason TEXT;
  `,
  // v8: coach phone and assistant coach for groups.
  `
  ALTER TABLE groups ADD COLUMN coach_phone TEXT;
  ALTER TABLE groups ADD COLUMN assistant TEXT;
  ALTER TABLE groups ADD COLUMN assistant_phone TEXT;
  `,
  // v9: the club takes no cash; payments stored as cash (demo data) become EasyPay.
  `
  UPDATE charges SET method = 'easypay' WHERE method = 'cash';
  `,
  // v10: Word (.docx) contract templates, preloaded with the club's contract; contract date;
  // monthly fees are due by the 15th (contract clause 3.7).
  (db) => {
    db.exec(`
      CREATE TABLE doc_templates (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        file       BLOB NOT NULL,
        file_name  TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT
      );
      ALTER TABLE contracts ADD COLUMN doc_template_id INTEGER REFERENCES doc_templates(id) ON DELETE SET NULL;
      ALTER TABLE contracts ADD COLUMN contract_date TEXT;
      UPDATE settings SET value = '15' WHERE key = 'due_day';
      UPDATE charges SET due_date = period || '-15' WHERE kind = 'monthly';
    `);
    db.prepare('INSERT INTO doc_templates (name, file, file_name) VALUES (?, ?, ?)').run(
      'Վճարովի թիմերի պայմանագիր',
      fs.readFileSync(path.join(__dirname, 'templates', 'pyunik-contract.docx')),
      'Վճարովի թիմերի պայմանագիր.docx'
    );
  },
  // v11: the training days of each group (the columns of the «Հաճախելիություն» sheet).
  `
  CREATE TABLE training_days (
    id       INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    date     TEXT NOT NULL,
    UNIQUE (group_id, date)
  );
  `,
  // v12: months whose training days were already set up, so a month cleared on purpose stays empty.
  `
  CREATE TABLE training_months (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    month    TEXT NOT NULL,
    PRIMARY KEY (group_id, month)
  );
  INSERT OR IGNORE INTO training_months (group_id, month) SELECT DISTINCT group_id, substr(date, 1, 7) FROM training_days;
  `,
  // v13: when a group's monthly attendance sheet was saved («Ներկայացված») and by whom.
  `
  ALTER TABLE training_months ADD COLUMN submitted_at TEXT;
  ALTER TABLE training_months ADD COLUMN submitted_by TEXT;
  `,
  // v14: the service the student is enrolled in («Ծառայություններ»).
  `
  ALTER TABLE students ADD COLUMN service TEXT;
  `,
  // v15: the ՀԴՄ (fiscal) receipt printed for a payment.
  `
  ALTER TABLE charges ADD COLUMN hdm_receipt TEXT;
  ALTER TABLE charges ADD COLUMN hdm_at TEXT;
  `,
  // v16: users, sign-in sessions and per-user rights (see auth.js).
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    rights TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    last_login_at TEXT
  );
  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  `,
  // v17: documents uploaded for a student (e.g. the medical certificate), stored in the database
  // so every computer sees them and they are part of the backups.
  `
  CREATE TABLE student_files (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'other',
    file_name TEXT NOT NULL,
    mime TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    created_by TEXT
  );
  CREATE INDEX idx_student_files_student ON student_files(student_id);
  `,
  // v18: messages waiting to be sent by email / Telegram (sent by the host PC, see notify.js).
  `
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    channel TEXT NOT NULL,          -- 'email' | 'telegram'
    recipient TEXT NOT NULL,        -- email address or Telegram chat id
    subject TEXT,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,             -- 'receipt' | 'reminder' | 'payment' | 'daily' | 'monthly' | 'test'
    student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
    period TEXT,                    -- month a reminder was sent for
    status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'sent' | 'failed'
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    sent_at TEXT,
    created_by TEXT
  );
  CREATE INDEX idx_outbox_status ON outbox(status);
  CREATE INDEX idx_outbox_student ON outbox(student_id, kind, period);
  `,
  // v19: excused absences (from absence applications). Training days in the period are «Հարգելի»
  // and the monthly fee of every month the period touches is cancelled (charges.excused_by).
  `
  CREATE TABLE absences (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    reason TEXT,
    file_id INTEGER REFERENCES student_files(id) ON DELETE SET NULL,
    created_charges TEXT,           -- ids of monthly fees this absence created (removed again on undo)
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    created_by TEXT
  );
  CREATE INDEX idx_absences_student ON absences(student_id, date_from, date_to);
  ALTER TABLE charges ADD COLUMN excused_by INTEGER;
  `,
  // v20: the training timetable (Դասացուցակ). schedule_base is each group's usual week
  // (weekday 0 = Sunday … 6 = Saturday); schedule_days changes one date only (or cancels it).
  `
  CREATE TABLE pitches (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO pitches (name, sort) VALUES ('№ 2', 1), ('№ 3', 2), ('№ 3/1', 3), ('№ 4', 4), ('№ 4/1', 5), ('№ 5', 6), ('№ 5/1', 7);
  CREATE TABLE schedule_base (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    pitch TEXT,
    note TEXT,
    UNIQUE (group_id, weekday)
  );
  CREATE TABLE schedule_days (
    id INTEGER PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    start TEXT,
    end TEXT,
    pitch TEXT,
    note TEXT,
    cancelled INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT,
    UNIQUE (group_id, date)
  );
  CREATE INDEX idx_schedule_days_date ON schedule_days(date);
  `,
  // v21: a stand-in coach / assistant for one date of the timetable.
  `
  ALTER TABLE schedule_days ADD COLUMN coach TEXT;
  ALTER TABLE schedule_days ADD COLUMN assistant TEXT;
  `,
  // v22: the parent's Viber / WhatsApp number (when it differs from the phone, or kept alongside).
  `
  ALTER TABLE students ADD COLUMN parent_messenger TEXT;
  `,
  // v23: the absence period («Դիմում») a payment refers to, e.g. 01.10–05.10.
  `
  ALTER TABLE charges ADD COLUMN absence_from TEXT;
  ALTER TABLE charges ADD COLUMN absence_to TEXT;
  `,
];

function seed(db) {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const setting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  setting.run('club_name', 'Football Club');
  setting.run('club_address', '');
  setting.run('club_phone', '');
  setting.run('director_name', '');
  setting.run('currency', 'AMD');
  setting.run('due_day', '15');
  setting.run('billing_start', period);
}

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // Unicode-aware lower() so search works for Armenian/Cyrillic names too.
  db.function('ulower', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase()));

  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      const step = MIGRATIONS[v];
      if (typeof step === 'function') step(db);
      else db.exec(step);
      if (v === 0) seed(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

module.exports = { openDatabase };
