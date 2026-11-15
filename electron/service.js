// All data operations. The host PC runs these directly; client PCs reach them over the LAN
// through the same method names (see server.js / remote.js), so there is one code path.

const word = require('./word');
const { createAuth } = require('./auth');

class AppError extends Error {}

// Email texts parents get (editable in Settings → Notifications). {placeholders} are filled in.
const DEFAULT_TEMPLATES = {
  reminderSubject: 'Վճարման հիշեցում — {student}',
  reminderBody:
    'Հարգելի {parent},\n\nՀիշեցնում ենք, որ հետևյալ վճարումը դեռ կատարված չէ․\n\nՍան՝ {student}\nՎճարում՝ {months}\nԳումար՝ {amount}\n\nԽնդրում ենք կատարել վճարումը։ Հարցերի դեպքում զանգահարեք {clubPhone}։\n\nՀարգանքով՝\n{club}',
  receiptSubject: 'Վճարումն ընդունված է — {student}',
  receiptBody:
    'Հարգելի {parent},\n\nՇնորհակալություն, վճարումն ընդունված է։\n\nՍան՝ {student}\n{items}\nԸնդամենը՝ {total} ({method})\nԱմսաթիվ՝ {date}\n\nՀարգանքով՝\n{club}',
};

// Used when a payment is recorded without a method (the UI always sends one).
const DEFAULT_METHOD = 'easypay';

const pad = (n) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const currentPeriod = () => today().slice(0, 7);
const addMonths = (period, n) => {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const blank = (v) => v == null || String(v).trim() === '';
const str = (v) => (blank(v) ? null : String(v).trim());
const int = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : def;
};
const formatDate = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

function createService(db, { onWrite, getNotify } = {}) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  // node:sqlite rejects unknown/undefined named parameters, so bind only what the SQL uses.
  const bind = (sql, params = {}) => {
    const out = {};
    for (const m of sql.matchAll(/[:$@]([A-Za-z_]\w*)/g)) {
      let v = params[m[1]];
      if (v === undefined) v = null;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      out[m[1]] = v;
    }
    return out;
  };
  const all = (sql, p) => stmt(sql).all(bind(sql, p));
  const one = (sql, p) => stmt(sql).get(bind(sql, p));
  const run = (sql, p) => stmt(sql).run(bind(sql, p));

  const settings = () => Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  const log = (ctx, action, details) =>
    run('INSERT INTO activity_log (user, action, details) VALUES (:user, :action, :details)', {
      user: ctx.user || null,
      action,
      details: details || null,
    });
  const studentName = (id) => {
    const s = one('SELECT first_name, last_name FROM students WHERE id = :id', { id });
    return s ? `${s.first_name} ${s.last_name}` : `#${id}`;
  };

  // Create the monthly fee charge for every active student for every month up to now.
  // Idempotent thanks to the unique (student_id, period) index on monthly charges.
  function ensureMonthlyCharges() {
    const s = settings();
    const dueDay = Math.min(Math.max(int(s.due_day, 10), 1), 28);
    const r = run(
      `WITH RECURSIVE months(p) AS (
         SELECT :start
         UNION ALL
         SELECT strftime('%Y-%m', date(p || '-01', '+1 month')) FROM months WHERE p < :current
       )
       INSERT OR IGNORE INTO charges (student_id, kind, period, amount, due_date, created_by)
       SELECT st.id, 'monthly', m.p, st.monthly_fee, m.p || '-' || :dueDay, 'system'
       FROM students st
       JOIN months m ON m.p >= substr(st.join_date, 1, 7)
                    AND m.p >= IFNULL(st.billing_from, '0000-00')
       WHERE st.status = 'active' AND st.monthly_fee > 0`,
      { start: s.billing_start || currentPeriod(), current: currentPeriod(), dueDay: pad(dueDay) }
    );
    return r.changes;
  }

  // ---------------------------------------------------------------- settings
  const SETTING_KEYS = ['club_name', 'club_address', 'club_phone', 'director_name', 'currency', 'due_day', 'billing_start', 'club_logo'];

  // ---------------------------------------------------------------- excused absences
  // Training days in the period become «Հարգելի» (unless marked present) and the monthly fee of each
  // month the period touches is not owed (waived, marked with the absence; paid months stay paid).
  function excuseAbsence(absenceId) {
    const a = one('SELECT * FROM absences WHERE id = :id', { id: absenceId });
    const s = one('SELECT id, group_id, monthly_fee FROM students WHERE id = :id', { id: a.student_id });
    if (s.group_id) {
      for (const d of all(
        `SELECT date FROM training_days WHERE group_id = :g AND date BETWEEN :from AND :to`,
        { g: s.group_id, from: a.date_from, to: a.date_to }
      )) {
        run(
          `INSERT INTO attendance (student_id, date, status, group_id, marked_by)
           VALUES (:sid, :date, 'excused', :g, :user)
           ON CONFLICT(student_id, date) DO UPDATE SET status = 'excused', marked_by = excluded.marked_by
           WHERE attendance.status NOT IN ('present', 'late')`,
          { sid: s.id, date: d.date, g: s.group_id, user: a.created_by }
        );
      }
    }
    const dueDay = pad(int(settings().due_day, 15));
    const created = [];
    for (let period = a.date_from.slice(0, 7); period <= a.date_to.slice(0, 7); period = addMonths(period, 1)) {
      const c = one(`SELECT id, status FROM charges WHERE student_id = :sid AND kind = 'monthly' AND period = :period`, { sid: s.id, period });
      if (c) {
        if (c.status === 'unpaid') run(`UPDATE charges SET status = 'waived', excused_by = :aid WHERE id = :id`, { id: c.id, aid: a.id });
      } else if (s.monthly_fee > 0) {
        const r = run(
          `INSERT INTO charges (student_id, kind, period, amount, due_date, status, excused_by, created_by)
           VALUES (:sid, 'monthly', :period, :fee, :due, 'waived', :aid, :user)`,
          { sid: s.id, period, fee: s.monthly_fee, due: `${period}-${dueDay}`, aid: a.id, user: a.created_by }
        );
        created.push(Number(r.lastInsertRowid));
      }
    }
    run('UPDATE absences SET created_charges = :c WHERE id = :id', { id: a.id, c: JSON.stringify(created) });
  }

  // Undoes an absence (its application was deleted).
  function removeAbsence(absenceId) {
    const a = one('SELECT * FROM absences WHERE id = :id', { id: absenceId });
    if (!a) return;
    // Fees this absence created for months still ahead go away; normal monthly billing adds them when their time comes.
    for (const cid of JSON.parse(a.created_charges || '[]')) {
      run(`DELETE FROM charges WHERE id = :cid AND excused_by = :id AND status = 'waived' AND period > :now`, { cid, id: a.id, now: currentPeriod() });
    }
    run(`UPDATE charges SET status = 'unpaid', excused_by = NULL WHERE excused_by = :id AND status = 'waived'`, { id: a.id });
    run(
      `DELETE FROM attendance WHERE student_id = :sid AND status = 'excused' AND date BETWEEN :from AND :to
         AND NOT EXISTS (SELECT 1 FROM absences b WHERE b.id != :id AND b.student_id = :sid AND attendance.date BETWEEN b.date_from AND b.date_to)`,
      { sid: a.student_id, from: a.date_from, to: a.date_to, id: a.id }
    );
    run('DELETE FROM absences WHERE id = :id', { id: a.id });
  }

  // ---------------------------------------------------------------- email / Telegram messages
  const HY_MONTHS = ['Հունվար', 'Փետրվար', 'Մարտ', 'Ապրիլ', 'Մայիս', 'Հունիս', 'Հուլիս', 'Օգոստոս', 'Սեպտեմբեր', 'Հոկտեմբեր', 'Նոյեմբեր', 'Դեկտեմբեր'];
  const HY_METHODS = { card: 'Անկանխիկ', easypay: 'EasyPay', transfer: 'Փոխանցում' };
  const monthHy = (period) => `${HY_MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
  const amd = (n) => {
    const cur = settings().currency || 'AMD';
    return `${Math.round(n || 0).toLocaleString('en-US')} ${cur === 'AMD' ? '֏' : cur}`;
  };
  const chargeText = (c) =>
    c.kind === 'monthly' ? `Ամսավճար · ${monthHy(c.period)}` : c.description || (c.kind === 'product' ? 'Ապրանք' : 'Այլ վճար');
  const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  const notifyCfg = () => (getNotify ? getNotify() : null) || {};
  const emailOn = () => !!notifyCfg().email?.enabled;
  const telegramChats = () => {
    const tg = notifyCfg().telegram || {};
    return tg.enabled && tg.token ? (tg.chats || []).filter((c) => c.on !== false).map((c) => String(c.id)) : [];
  };
  const enqueue = (m, ctx = {}) =>
    run(
      `INSERT INTO outbox (channel, recipient, subject, body, kind, student_id, period, created_by)
       VALUES (:channel, :recipient, :subject, :body, :kind, :studentId, :period, :user)`,
      { studentId: null, period: null, subject: null, ...m, user: ctx.user || null }
    );
  const studentVars = (sid) => {
    const s = one('SELECT * FROM students WHERE id = :id', { id: sid });
    const st = settings();
    return {
      s,
      vars: {
        student: s ? `${s.first_name} ${s.last_name}` : '',
        parent: s ? [s.parent_first_name, s.parent_last_name].filter(Boolean).join(' ') || s.parent_name || 'ծնող' : '',
        club: st.club_name || 'FC Manager',
        clubPhone: st.club_phone || '',
        date: formatDate(today()),
      },
    };
  };

  // After a payment: receipt email to the parent, alert to the staff's Telegram chats.
  function notifyPaid(studentId, charges, method, ctx) {
    const cfg = notifyCfg();
    if (!charges.length) return;
    const { s, vars } = studentVars(studentId);
    const total = charges.reduce((sum, c) => sum + c.amount, 0);
    const items = charges.map((c) => `• ${chargeText(c)} — ${amd(c.amount)}`).join('\n');
    const all = { ...vars, items, total: amd(total), method: HY_METHODS[method] || method };
    if (cfg.receipts && emailOn() && s?.parent_email) {
      const tpl = { ...DEFAULT_TEMPLATES, ...(cfg.templates || {}) };
      enqueue({ channel: 'email', recipient: s.parent_email, subject: fill(tpl.receiptSubject, all), body: fill(tpl.receiptBody, all), kind: 'receipt', studentId }, ctx);
    }
    if (cfg.paymentAlerts) {
      const text = `💳 Վճարում — ${vars.student}\n${items}\nԸնդամենը՝ ${amd(total)} (${all.method})${ctx.user ? `\nԳրանցող՝ ${ctx.user}` : ''}`;
      for (const chat of telegramChats()) enqueue({ channel: 'telegram', recipient: chat, body: text, kind: 'payment', studentId }, ctx);
    }
  }

  // Overdue reminder emails. studentIds: null = everyone with an overdue fee.
  // skipReminded: leave out students already reminded this month (automatic reminders).
  function remindOverdue(studentIds, ctx, { skipReminded = false } = {}) {
    const period = currentPeriod();
    const tpl = { ...DEFAULT_TEMPLATES, ...(notifyCfg().templates || {}) };
    const rows = all(
      `SELECT c.student_id, c.kind, c.period, c.description, c.amount FROM charges c JOIN students s ON s.id = c.student_id
       WHERE c.status = 'unpaid' AND c.due_date < :t AND s.status = 'active' ORDER BY c.due_date`,
      { t: today() }
    ).filter((r) => !studentIds || studentIds.includes(r.student_id));
    const bySt = new Map();
    for (const r of rows) {
      if (!bySt.has(r.student_id)) bySt.set(r.student_id, []);
      bySt.get(r.student_id).push(r);
    }
    const result = { queued: 0, noEmail: [], already: 0 };
    for (const [sid, list] of bySt) {
      const { s, vars } = studentVars(sid);
      if (!s.parent_email) {
        result.noEmail.push(vars.student);
        continue;
      }
      if (skipReminded && one(`SELECT id FROM outbox WHERE student_id = :sid AND kind = 'reminder' AND period = :period`, { sid, period })) {
        result.already++;
        continue;
      }
      const all = {
        ...vars,
        months: list.map((c) => (c.kind === 'monthly' ? monthHy(c.period) : chargeText(c))).join(', '),
        amount: amd(list.reduce((sum, c) => sum + c.amount, 0)),
      };
      enqueue({ channel: 'email', recipient: s.parent_email, subject: fill(tpl.reminderSubject, all), body: fill(tpl.reminderBody, all), kind: 'reminder', studentId: sid, period }, ctx);
      result.queued++;
    }
    if (result.queued) log(ctx, 'notify.reminders', String(result.queued));
    return result;
  }

  // Summary text for the staff: a day ('2026-11-15') or a month ('2026-10').
  function summaryText(kind, when) {
    const st = settings();
    const like = kind === 'daily' ? when : `${when}-%`;
    const paid = all(
      `SELECT IFNULL(method, 'easypay') AS method, COUNT(*) AS n, SUM(amount) AS total FROM charges
       WHERE status = 'paid' AND paid_at LIKE :like GROUP BY 1`,
      { like }
    );
    const n = paid.reduce((s, r) => s + r.n, 0);
    const total = paid.reduce((s, r) => s + r.total, 0);
    const overdue = one(
      `SELECT IFNULL(SUM(amount), 0) AS total, COUNT(DISTINCT student_id) AS students FROM charges WHERE status = 'unpaid' AND due_date < :t`,
      { t: today() }
    );
    const joined = one(`SELECT COUNT(*) AS n FROM students WHERE join_date LIKE :like`, { like }).n;
    const active = one(`SELECT COUNT(*) AS n FROM students WHERE status = 'active'`).n;
    const title = kind === 'daily' ? `📊 ${st.club_name || 'FC Manager'} — ${formatDate(when)}` : `📅 ${st.club_name || 'FC Manager'} — ${monthHy(when)}`;
    const lines = [title, '', `Ստացված վճարումներ՝ ${n}, ընդամենը ${amd(total)}`];
    for (const m of ['card', 'easypay', 'transfer']) {
      const r = paid.find((x) => x.method === m);
      if (r) lines.push(`  • ${HY_METHODS[m]}՝ ${amd(r.total)} (${r.n})`);
    }
    if (kind === 'monthly') {
      const fees = one(
        `SELECT IFNULL(SUM(amount), 0) AS expected, IFNULL(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid
         FROM charges WHERE kind = 'monthly' AND period = :p AND status != 'waived'`,
        { p: when }
      );
      lines.push(`Ամսավճարներ՝ ${amd(fees.paid)} / ${amd(fees.expected)}`);
      lines.push(`Ակտիվ սաներ՝ ${active}`);
    }
    lines.push(`Նոր սաներ՝ ${joined}`);
    lines.push(`Ժամկետանց պարտք՝ ${amd(overdue.total)} (${overdue.students} սան)`);
    return { subject: title.replace(/^\S+\s/, ''), body: lines.join('\n') };
  }

  // Sends a summary to the staff: Telegram chats + summary email addresses.
  function queueSummary(kind, when, ctx = {}) {
    const { subject, body } = summaryText(kind, when);
    let n = 0;
    for (const chat of telegramChats()) {
      enqueue({ channel: 'telegram', recipient: chat, body, kind }, ctx);
      n++;
    }
    if (emailOn()) {
      for (const to of String(notifyCfg().summaryEmails || '').split(/[,;\s]+/).filter((x) => x.includes('@'))) {
        enqueue({ channel: 'email', recipient: to, subject, body, kind }, ctx);
        n++;
      }
    }
    return n;
  }

  const methods = {
    'settings.get': () => settings(),

    'settings.update': (p, ctx) => {
      for (const key of SETTING_KEYS) {
        if (p[key] === undefined) continue;
        run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', {
          key,
          value: p[key] == null ? '' : String(p[key]),
        });
      }
      log(ctx, 'settings.updated');
      return settings();
    },

    // ---------------------------------------------------------------- dashboard
    'dashboard.summary': () => {
      const t = today();
      const period = currentPeriod();
      const months = [];
      for (let i = 5; i >= 0; i--) months.push(addMonths(period, -i));
      const collectedRows = all(
        `SELECT substr(paid_at, 1, 7) AS period, SUM(amount) AS total
         FROM charges WHERE status = 'paid' AND paid_at >= :from GROUP BY 1`,
        { from: `${months[0]}-01` }
      );
      const byPeriod = Object.fromEntries(collectedRows.map((r) => [r.period, r.total]));

      return {
        activeStudents: one(`SELECT COUNT(*) AS n FROM students WHERE status = 'active'`).n,
        newThisMonth: one(`SELECT COUNT(*) AS n FROM students WHERE substr(join_date, 1, 7) = :period`, { period }).n,
        collectedThisMonth: byPeriod[period] || 0,
        collectedLastMonth: byPeriod[addMonths(period, -1)] || 0,
        overdue: one(
          `SELECT IFNULL(SUM(amount), 0) AS total, COUNT(DISTINCT student_id) AS students
           FROM charges WHERE status = 'unpaid' AND due_date < :t`,
          { t }
        ),
        monthlyThisPeriod: one(
          `SELECT IFNULL(SUM(amount), 0) AS expected,
                  IFNULL(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid,
                  COUNT(*) AS count,
                  SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paidCount
           FROM charges WHERE kind = 'monthly' AND period = :period AND status != 'waived'`,
          { period }
        ),
        attendanceToday: one(
          `SELECT COUNT(*) AS marked,
                  SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END) AS present
           FROM attendance WHERE date = :t`,
          { t }
        ),
        collections: months.map((m) => ({ period: m, total: byPeriod[m] || 0 })),
        debtors: all(
          `SELECT s.id, s.first_name, s.last_name, g.name AS group_name, SUM(c.amount) AS debt,
                  MIN(c.due_date) AS oldest
           FROM charges c JOIN students s ON s.id = c.student_id
           LEFT JOIN groups g ON g.id = s.group_id
           WHERE c.status = 'unpaid' AND c.due_date < :t
           GROUP BY s.id ORDER BY debt DESC LIMIT 8`,
          { t }
        ),
        recentPayments: all(
          `SELECT c.id, c.kind, c.period, c.description, c.amount, c.paid_at, c.method,
                  s.id AS student_id, s.first_name, s.last_name
           FROM charges c JOIN students s ON s.id = c.student_id
           WHERE c.status = 'paid' ORDER BY c.paid_at DESC, c.id DESC LIMIT 8`
        ),
        expiringContracts: all(
          `SELECT ct.id, ct.number, ct.end_date, s.first_name, s.last_name, s.id AS student_id
           FROM contracts ct JOIN students s ON s.id = ct.student_id
           WHERE ct.status = 'signed' AND ct.end_date BETWEEN :t AND date(:t, '+30 days')
           ORDER BY ct.end_date LIMIT 8`,
          { t }
        ),
        activity: all('SELECT * FROM activity_log ORDER BY id DESC LIMIT 12'),
      };
    },

    // ---------------------------------------------------------------- groups
    // days_total / days_filled: this month's training days, and how many of them have saved attendance.
    'groups.list': () =>
      all(
        `SELECT g.*,
                (SELECT COUNT(*) FROM students s WHERE s.group_id = g.id AND s.status = 'active') AS student_count,
                (SELECT COUNT(*) FROM training_days td WHERE td.group_id = g.id AND substr(td.date, 1, 7) = :period) AS days_total,
                (SELECT COUNT(*) FROM training_days td WHERE td.group_id = g.id AND substr(td.date, 1, 7) = :period
                   AND EXISTS (SELECT 1 FROM attendance a JOIN students s ON s.id = a.student_id
                               WHERE s.group_id = g.id AND a.date = td.date)) AS days_filled
         FROM groups g`,
        { period: currentPeriod() }
      ).sort((a, b) => a.archived - b.archived || a.name.localeCompare(b.name, 'hy', { numeric: true, sensitivity: 'base' })),

    'groups.save': (p, ctx) => {
      if (blank(p.name)) throw new AppError('NAME_REQUIRED');
      const row = {
        id: p.id,
        name: str(p.name),
        coach: str(p.coach),
        coach_phone: str(p.coach_phone),
        assistant: str(p.assistant),
        assistant_phone: str(p.assistant_phone),
        color: str(p.color),
        archived: p.archived ? 1 : 0,
      };
      if (p.id) {
        run(
          `UPDATE groups SET name = :name, coach = :coach, coach_phone = :coach_phone, assistant = :assistant,
                  assistant_phone = :assistant_phone, color = :color, archived = :archived WHERE id = :id`,
          row
        );
        log(ctx, 'group.updated', row.name);
        return { id: p.id };
      }
      const r = run(
        `INSERT INTO groups (name, coach, coach_phone, assistant, assistant_phone, color, archived)
         VALUES (:name, :coach, :coach_phone, :assistant, :assistant_phone, :color, :archived)`,
        row
      );
      log(ctx, 'group.created', row.name);
      return { id: Number(r.lastInsertRowid) };
    },

    'groups.delete': ({ id }, ctx) => {
      const g = one('SELECT name FROM groups WHERE id = :id', { id });
      run('DELETE FROM groups WHERE id = :id', { id });
      log(ctx, 'group.deleted', g?.name);
      return true;
    },

    // ---------------------------------------------------------------- students
    'students.list': (p = {}) =>
      all(
        `SELECT s.id, s.first_name, s.last_name, s.birth_date, s.phone, s.parent_name, s.parent_phone,
                s.group_id, g.name AS group_name, g.color AS group_color, g.coach AS group_coach, s.monthly_fee, s.join_date, s.status, s.inactive_reason, s.medical_doc, s.patronymic, s.category, s.contract_no, s.service,
                s.parent_first_name, s.parent_last_name, s.parent_doc_no, s.parent_doc_issuer, s.parent_doc_date, s.parent_ssn, s.parent_address, s.parent_email,
                IFNULL((SELECT SUM(amount) FROM charges c
                        WHERE c.student_id = s.id AND c.status = 'unpaid' AND c.due_date < :t), 0) AS overdue,
                IFNULL((SELECT SUM(amount) FROM charges c
                        WHERE c.student_id = s.id AND c.status = 'unpaid'), 0) AS unpaid,
                -- Monthly fee per month in the requested range (the season shown in the students list).
                (SELECT json_group_array(json_object('id', c.id, 'period', c.period, 'status', c.status,
                                                     'due_date', c.due_date, 'amount', c.amount, 'excused_by', c.excused_by))
                 FROM charges c WHERE c.student_id = s.id AND c.kind = 'monthly'
                   AND c.period BETWEEN :monthsFrom AND :monthsTo) AS months
         FROM students s LEFT JOIN groups g ON g.id = s.group_id
         WHERE (:status IS NULL OR s.status = :status)
           AND (:groupId IS NULL OR s.group_id = :groupId)
           AND (:search IS NULL OR ulower(s.first_name || ' ' || s.last_name || ' ' || s.first_name || ' ' ||
                IFNULL(s.phone, '') || ' ' || IFNULL(s.parent_name, '') || ' ' || IFNULL(s.parent_phone, '') || ' ' ||
                IFNULL(s.contract_no, ''))
                LIKE '%' || ulower(:search) || '%')
         ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`,
        {
          t: today(),
          status: str(p.status),
          groupId: p.groupId || null,
          search: str(p.search),
          monthsFrom: str(p.monthsFrom) || '9999-99',
          monthsTo: str(p.monthsTo) || '0000-00',
        }
      ).map((r) => ({ ...r, months: JSON.parse(r.months || '[]') })),

    'students.get': ({ id }) => {
      const student = one(
        `SELECT s.*, g.name AS group_name, g.color AS group_color, g.schedule AS group_schedule
         FROM students s LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = :id`,
        { id }
      );
      if (!student) throw new AppError('NOT_FOUND');
      return {
        student,
        charges: all(
          `SELECT * FROM charges WHERE student_id = :id
           ORDER BY CASE status WHEN 'unpaid' THEN 0 ELSE 1 END, IFNULL(due_date, created_at) DESC, id DESC`,
          { id }
        ),
        attendance: all('SELECT date, status FROM attendance WHERE student_id = :id ORDER BY date DESC LIMIT 120', { id }),
        attendanceStats: one(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present,
                  SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late,
                  SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent,
                  SUM(CASE WHEN status = 'excused' THEN 1 ELSE 0 END) AS excused
           FROM attendance WHERE student_id = :id AND date >= date('now', 'localtime', '-90 days')`,
          { id }
        ),
        contracts: all(
          `SELECT id, number, title, contract_date, start_date, end_date, status, signed_date, created_at, doc_template_id
           FROM contracts WHERE student_id = :id ORDER BY id DESC`,
          { id }
        ),
        files: all(
          `SELECT id, kind, file_name, mime, size, created_at, created_by FROM student_files
           WHERE student_id = :id ORDER BY id DESC`,
          { id }
        ),
      };
    },

    'students.save': (p, ctx) => {
      if (blank(p.first_name) || blank(p.last_name)) throw new AppError('NAME_REQUIRED');
      if (blank(p.join_date)) throw new AppError('JOIN_DATE_REQUIRED');
      const row = {
        id: p.id,
        first_name: str(p.first_name),
        patronymic: str(p.patronymic),
        contract_no: str(p.contract_no),
        service: str(p.service),
        category: ['siblings', 'half', 'war', 'staff'].includes(p.category) ? p.category : null,
        last_name: str(p.last_name),
        birth_date: str(p.birth_date),
        gender: str(p.gender),
        phone: str(p.phone),
        email: str(p.email),
        address: str(p.address),
        document_no: str(p.document_no),
        parent_first_name: str(p.parent_first_name),
        parent_last_name: str(p.parent_last_name),
        parent_name: [str(p.parent_first_name), str(p.parent_last_name)].filter(Boolean).join(' ') || null,
        parent_doc_no: str(p.parent_doc_no),
        parent_doc_issuer: str(p.parent_doc_issuer),
        parent_doc_date: str(p.parent_doc_date),
        parent_ssn: str(p.parent_ssn),
        parent_address: str(p.parent_address),
        parent_email: str(p.parent_email),
        parent_phone: str(p.parent_phone),
        group_id: p.group_id ? int(p.group_id) : null,
        monthly_fee: int(p.monthly_fee),
        join_date: str(p.join_date),
        status: p.status === 'inactive' ? 'inactive' : 'active',
        inactive_reason: p.status === 'inactive' ? str(p.inactive_reason) : null,
        notes: str(p.notes),
        medical_doc: p.medical_doc === true || Number(p.medical_doc) === 1 ? 1 : 0,
        photo: p.photo || null,
      };

      if (p.id) {
        const prev = one('SELECT status, monthly_fee, leave_date, billing_from FROM students WHERE id = :id', { id: p.id });
        if (!prev) throw new AppError('NOT_FOUND');
        row.leave_date = prev.leave_date;
        row.billing_from = prev.billing_from;
        if (prev.status === 'active' && row.status === 'inactive') row.leave_date = today();
        // Coming back after a break: start billing again from this month, not from the gap.
        if (prev.status === 'inactive' && row.status === 'active') {
          row.leave_date = null;
          row.billing_from = currentPeriod();
        }
        run(
          `UPDATE students SET first_name = :first_name, last_name = :last_name, patronymic = :patronymic, category = :category, contract_no = :contract_no, service = :service, birth_date = :birth_date,
             gender = :gender, phone = :phone, email = :email, address = :address, document_no = :document_no,
             parent_name = :parent_name, parent_phone = :parent_phone, group_id = :group_id,
             parent_first_name = :parent_first_name, parent_last_name = :parent_last_name, parent_doc_no = :parent_doc_no, parent_doc_issuer = :parent_doc_issuer,
             parent_doc_date = :parent_doc_date, parent_ssn = :parent_ssn, parent_address = :parent_address, parent_email = :parent_email,
             monthly_fee = :monthly_fee, join_date = :join_date, status = :status, inactive_reason = :inactive_reason, leave_date = :leave_date,
             billing_from = :billing_from, notes = :notes, photo = :photo, medical_doc = :medical_doc,
             updated_at = datetime('now', 'localtime')
           WHERE id = :id`,
          row
        );
        // A changed fee applies to this month's and future unpaid monthly charges.
        if (prev.monthly_fee !== row.monthly_fee) {
          run(
            `UPDATE charges SET amount = :fee
             WHERE student_id = :id AND kind = 'monthly' AND status = 'unpaid' AND period >= :period`,
            { fee: row.monthly_fee, id: p.id, period: currentPeriod() }
          );
        }
        log(ctx, 'student.updated', `${row.first_name} ${row.last_name}`);
        ensureMonthlyCharges();
        return { id: p.id };
      }

      const r = run(
        `INSERT INTO students (first_name, last_name, patronymic, category, contract_no, service, birth_date, gender, phone, email, address, document_no,
           parent_name, parent_phone, group_id, monthly_fee, join_date, status, inactive_reason, notes, photo, medical_doc,
           parent_first_name, parent_last_name, parent_doc_no, parent_doc_issuer, parent_doc_date, parent_ssn, parent_address, parent_email)
         VALUES (:first_name, :last_name, :patronymic, :category, :contract_no, :service, :birth_date, :gender, :phone, :email, :address, :document_no,
           :parent_name, :parent_phone, :group_id, :monthly_fee, :join_date, :status, :inactive_reason, :notes, :photo, :medical_doc,
           :parent_first_name, :parent_last_name, :parent_doc_no, :parent_doc_issuer, :parent_doc_date, :parent_ssn, :parent_address, :parent_email)`,
        row
      );
      log(ctx, 'student.created', `${row.first_name} ${row.last_name}`);
      ensureMonthlyCharges();
      return { id: Number(r.lastInsertRowid) };
    },

    // Import from another program. rows: [{ ...student fields, group_name }] (already matched to fields).
    // A row matches an existing student by contract number, else by name + birth date.
    // mode 'skip' leaves existing students as they are; 'update' fills in the imported fields.
    'students.import': ({ rows, mode = 'skip', createGroups = true }, ctx) => {
      const result = { created: 0, updated: 0, skipped: 0, groupsCreated: 0, errors: [] };
      const groupIds = new Map(all('SELECT id, name FROM groups').map((g) => [g.name.trim().toLowerCase(), g.id]));
      const save = methods['students.save'];
      (rows || []).forEach((raw, i) => {
        try {
          const p = Object.fromEntries(Object.entries(raw || {}).filter(([, v]) => !blank(v)));
          if (p.group_name) {
            const key = String(p.group_name).trim().toLowerCase();
            if (!groupIds.has(key) && createGroups) {
              const r = run('INSERT INTO groups (name) VALUES (:name)', { name: String(p.group_name).trim() });
              groupIds.set(key, Number(r.lastInsertRowid));
              result.groupsCreated++;
            }
            if (groupIds.has(key)) p.group_id = groupIds.get(key);
          }
          delete p.group_name;
          const existing =
            (p.contract_no && one('SELECT * FROM students WHERE contract_no = :c', { c: str(p.contract_no) })) ||
            one(
              `SELECT * FROM students WHERE ulower(first_name) = ulower(:f) AND ulower(last_name) = ulower(:l)
                 AND IFNULL(birth_date, '') = IFNULL(:b, '')`,
              { f: str(p.first_name), l: str(p.last_name), b: str(p.birth_date) }
            );
          if (existing) {
            if (mode !== 'update') {
              result.skipped++;
              return;
            }
            save({ ...existing, ...p, id: existing.id }, ctx);
            result.updated++;
            return;
          }
          save({ join_date: today(), status: 'active', ...p }, ctx);
          result.created++;
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          result.errors.push({ row: i + 1, error: err.message });
        }
      });
      log(ctx, 'students.imported', `${result.created} / ${result.updated} / ${result.skipped}`);
      return result;
    },

    // ---------------------------------------------------------------- student documents
    'files.list': ({ studentId }) =>
      all(
        `SELECT id, kind, file_name, mime, size, created_at, created_by FROM student_files
         WHERE student_id = :studentId ORDER BY id DESC`,
        { studentId }
      ),

    'files.get': ({ id }) => {
      const f = one('SELECT file_name, mime, data FROM student_files WHERE id = :id', { id });
      if (!f) throw new AppError('NOT_FOUND');
      return { fileName: f.file_name, mime: f.mime, data: Buffer.from(f.data).toString('base64') };
    },

    'files.upload': ({ studentId, kind, name, type, data }, ctx) => {
      if (!one('SELECT id FROM students WHERE id = :id', { id: studentId })) throw new AppError('NOT_FOUND');
      const buf = Buffer.from(String(data || ''), 'base64');
      if (!buf.length) throw new AppError('FILE_EMPTY');
      if (buf.length > 15 * 1024 * 1024) throw new AppError('FILE_TOO_BIG');
      const k = kind === 'medical' ? 'medical' : 'other';
      const r = run(
        `INSERT INTO student_files (student_id, kind, file_name, mime, size, data, created_by)
         VALUES (:studentId, :kind, :name, :type, :size, :data, :user)`,
        { studentId, kind: k, name: str(name) || 'document', type: str(type), size: buf.length, data: buf, user: ctx.user || null }
      );
      // An uploaded medical certificate means it has been provided.
      if (k === 'medical') run('UPDATE students SET medical_doc = 1 WHERE id = :id', { id: studentId });
      log(ctx, 'file.uploaded', `${studentName(studentId)} — ${str(name)}`);
      return { id: Number(r.lastInsertRowid) };
    },

    'files.delete': ({ id }, ctx) => {
      const f = one('SELECT student_id, file_name, kind FROM student_files WHERE id = :id', { id });
      if (!f) throw new AppError('NOT_FOUND');
      if (f.kind === 'absence') for (const a of all('SELECT id FROM absences WHERE file_id = :id', { id })) removeAbsence(a.id);
      run('DELETE FROM student_files WHERE id = :id', { id });
      log(ctx, 'file.deleted', `${studentName(f.student_id)} — ${f.file_name}`);
      return true;
    },

    // ---------------------------------------------------------------- email / Telegram
    // Reminder emails to parents of students with overdue fees (all, or the given students).
    'notify.remind': ({ studentIds } = {}, ctx) => {
      if (!emailOn()) throw new AppError('EMAIL_NOT_SET');
      return remindOverdue(studentIds && studentIds.length ? studentIds : null, ctx);
    },

    // Recent messages and their status.
    'notify.outbox': ({ limit = 50 } = {}) =>
      all(
        `SELECT o.id, o.channel, o.recipient, o.subject, o.kind, o.status, o.error, o.created_at, o.sent_at,
                s.first_name, s.last_name
         FROM outbox o LEFT JOIN students s ON s.id = o.student_id ORDER BY o.id DESC LIMIT :limit`,
        { limit: Math.min(int(limit, 50), 500) }
      ),

    'notify.retry': ({ id }) => {
      run(`UPDATE outbox SET status = 'pending', attempts = 0, error = NULL WHERE id = :id AND status = 'failed'`, { id });
      return true;
    },

    // Absence application (Բացակայության դիմում): fills the club's form and keeps it under the student's documents.
    'applications.create': (p, ctx) => {
      const student = one(
        `SELECT s.*, g.name AS group_name FROM students s LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = :id`,
        { id: p.studentId }
      );
      if (!student) throw new AppError('NOT_FOUND');
      if (blank(p.from) || blank(p.to)) throw new AppError('PERIOD_REQUIRED');
      if (String(p.to) < String(p.from)) throw new AppError('PERIOD_INVALID');
      const contract = one(
        `SELECT number, contract_date FROM contracts WHERE student_id = :id
         ORDER BY IFNULL(contract_date, created_at) DESC, id DESC LIMIT 1`,
        { id: p.studentId }
      );
      const date = str(p.date) || today();
      const template = require('fs').readFileSync(require('path').join(__dirname, 'templates', 'absence-application.docx'));
      const buf = word.fillTemplate(template, word.absenceValues(student, contract, { ...p, date }));
      const name = `Բացակայության դիմում — ${student.first_name} ${student.last_name} — ${formatDate(str(p.from))}–${formatDate(str(p.to))}.docx`;
      const r = run(
        `INSERT INTO student_files (student_id, kind, file_name, mime, size, data, created_by)
         VALUES (:studentId, 'absence', :name, :type, :size, :data, :user)`,
        {
          studentId: p.studentId,
          name,
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: buf.length,
          data: buf,
          user: ctx.user || null,
        }
      );
      const fileId = Number(r.lastInsertRowid);
      const absenceId = Number(
        run(
          `INSERT INTO absences (student_id, date_from, date_to, reason, file_id, created_by)
           VALUES (:studentId, :from, :to, :reason, :fileId, :user)`,
          { studentId: p.studentId, from: str(p.from), to: str(p.to), reason: str(p.reason), fileId, user: ctx.user || null }
        ).lastInsertRowid
      );
      excuseAbsence(absenceId);
      log(ctx, 'application.created', `${student.first_name} ${student.last_name} — ${formatDate(str(p.from))}–${formatDate(str(p.to))}`);
      return { id: fileId, fileName: name, data: buf.toString('base64') };
    },

    // ---------------------------------------------------------------- timetable (Դասացուցակ)
    // Everything the timetable page needs for the chosen dates.
    'schedule.get': ({ dates = [] } = {}) => {
      const list = (dates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
      const prev = list.map((d) => addDays(d, -7));
      const inDates = (arr) => (arr.length ? arr.map((d) => `'${d}'`).join(',') : "''");
      return {
        groups: all(
          `SELECT id, name, color, coach, coach_phone, assistant, assistant_phone FROM groups WHERE archived = 0`
        ).sort((a, b) => a.name.localeCompare(b.name, 'hy', { numeric: true, sensitivity: 'base' })),
        pitches: all('SELECT name FROM pitches ORDER BY sort, name').map((p) => p.name),
        base: all('SELECT group_id, weekday, start, end, pitch, note FROM schedule_base'),
        days: all(`SELECT group_id, date, start, end, pitch, note, cancelled FROM schedule_days WHERE date IN (${inDates(list)})`),
        // Last week's changes, for «copy from last week».
        prevDays: all(`SELECT group_id, date FROM schedule_days WHERE date IN (${inDates(prev)})`).length,
      };
    },

    // The usual weekly slot of a group. Empty start = no training that weekday.
    'schedule.saveBase': ({ groupId, weekday, start, end, pitch, note }, ctx) => {
      if (!groupId || !(weekday >= 0 && weekday <= 6)) throw new AppError('DATE_REQUIRED');
      if (blank(start)) {
        run('DELETE FROM schedule_base WHERE group_id = :groupId AND weekday = :weekday', { groupId, weekday });
      } else {
        if (blank(end) || str(end) <= str(start)) throw new AppError('TIME_INVALID');
        run(
          `INSERT INTO schedule_base (group_id, weekday, start, end, pitch, note) VALUES (:groupId, :weekday, :start, :end, :pitch, :note)
           ON CONFLICT(group_id, weekday) DO UPDATE SET start = excluded.start, end = excluded.end, pitch = excluded.pitch, note = excluded.note`,
          { groupId, weekday, start: str(start), end: str(end), pitch: str(pitch), note: str(note) }
        );
      }
      log(ctx, 'schedule.base', `${one('SELECT name FROM groups WHERE id = :groupId', { groupId })?.name || ''} — ${weekday}`);
      return true;
    },

    // A change for one date (or cancelling that day's training).
    'schedule.setDay': ({ groupId, date, start, end, pitch, note, cancelled }, ctx) => {
      if (!groupId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new AppError('DATE_REQUIRED');
      if (!cancelled && (blank(start) || blank(end) || str(end) <= str(start))) throw new AppError('TIME_INVALID');
      run(
        `INSERT INTO schedule_days (group_id, date, start, end, pitch, note, cancelled, updated_by)
         VALUES (:groupId, :date, :start, :end, :pitch, :note, :cancelled, :user)
         ON CONFLICT(group_id, date) DO UPDATE SET start = excluded.start, end = excluded.end, pitch = excluded.pitch,
           note = excluded.note, cancelled = excluded.cancelled, updated_by = excluded.updated_by`,
        { groupId, date, start: str(start), end: str(end), pitch: str(pitch), note: str(note), cancelled: cancelled ? 1 : 0, user: ctx.user || null }
      );
      return true;
    },

    // Back to the usual schedule for that date.
    'schedule.resetDay': ({ groupId, date }) => {
      run('DELETE FROM schedule_days WHERE group_id = :groupId AND date = :date', { groupId, date });
      return true;
    },

    // Copies last week's changes (same weekday, 7 days earlier) onto the chosen dates.
    'schedule.copyWeek': ({ dates = [] }, ctx) => {
      let n = 0;
      for (const date of dates) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const from = addDays(date, -7);
        run('DELETE FROM schedule_days WHERE date = :date', { date });
        for (const d of all('SELECT * FROM schedule_days WHERE date = :from', { from })) {
          run(
            `INSERT INTO schedule_days (group_id, date, start, end, pitch, note, cancelled, updated_by)
             VALUES (:group_id, :date, :start, :end, :pitch, :note, :cancelled, :user)`,
            { ...d, date, user: ctx.user || null }
          );
          n++;
        }
      }
      log(ctx, 'schedule.copied', `${dates.join(', ')} — ${n}`);
      return { copied: n };
    },

    'schedule.savePitches': ({ names = [] }) => {
      const clean = [...new Set(names.map((x) => String(x || '').trim()).filter(Boolean))];
      run('DELETE FROM pitches');
      clean.forEach((name, i) => run('INSERT INTO pitches (name, sort) VALUES (:name, :sort)', { name, sort: i + 1 }));
      return true;
    },

    // Adds the timetable's trainings on these dates to the attendance sheets (Հաճախումներ).
    'schedule.toAttendance': ({ sessions = [] }, ctx) => {
      let added = 0;
      for (const s of sessions) {
        if (!s.groupId || !/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) continue;
        // The month counts as set up, so the 10 default days are not added on top.
        run('INSERT OR IGNORE INTO training_months (group_id, month) VALUES (:g, :m)', { g: s.groupId, m: s.date.slice(0, 7) });
        added += Number(run('INSERT OR IGNORE INTO training_days (group_id, date) VALUES (:g, :d)', { g: s.groupId, d: s.date }).changes) || 0;
      }
      log(ctx, 'schedule.toAttendance', String(added));
      return { added };
    },

    'students.delete': ({ id }, ctx) => {
      const name = studentName(id);
      run('DELETE FROM students WHERE id = :id', { id });
      log(ctx, 'student.deleted', name);
      return true;
    },

    // ---------------------------------------------------------------- products (kit, clothes, equipment)
    'products.list': () => all('SELECT * FROM products ORDER BY archived, name COLLATE NOCASE'),

    'products.save': (p, ctx) => {
      if (blank(p.name)) throw new AppError('NAME_REQUIRED');
      const row = { id: p.id, name: str(p.name), price: int(p.price), archived: p.archived ? 1 : 0 };
      if (p.id) {
        run('UPDATE products SET name = :name, price = :price, archived = :archived WHERE id = :id', row);
        log(ctx, 'product.updated', row.name);
        return { id: p.id };
      }
      const r = run('INSERT INTO products (name, price, archived) VALUES (:name, :price, :archived)', row);
      log(ctx, 'product.created', row.name);
      return { id: Number(r.lastInsertRowid) };
    },

    'products.delete': ({ id }, ctx) => {
      const pr = one('SELECT name FROM products WHERE id = :id', { id });
      run('DELETE FROM products WHERE id = :id', { id });
      log(ctx, 'product.deleted', pr?.name);
      return true;
    },

    // ---------------------------------------------------------------- charges & payments
    'charges.list': (p = {}) => {
      const rows = all(
        `SELECT c.*, s.first_name, s.last_name, s.group_id, g.name AS group_name, pr.name AS product_name
         FROM charges c
         JOIN students s ON s.id = c.student_id
         LEFT JOIN groups g ON g.id = s.group_id
         LEFT JOIN products pr ON pr.id = c.product_id
         WHERE (:status IS NULL OR c.status = :status)
           AND (:overdue = 0 OR (c.status = 'unpaid' AND c.due_date < :t))
           AND (:kind IS NULL OR c.kind = :kind)
           AND (:period IS NULL OR (CASE WHEN c.status = 'paid' AND :byPaid = 1
                                         THEN substr(c.paid_at, 1, 7)
                                         ELSE IFNULL(c.period, substr(c.due_date, 1, 7)) END) = :period)
           AND (:groupId IS NULL OR s.group_id = :groupId)
           AND (:studentId IS NULL OR c.student_id = :studentId)
           AND (:search IS NULL OR ulower(s.first_name || ' ' || s.last_name || ' ' || s.first_name || ' ' ||
                IFNULL(c.description, '') || ' ' || IFNULL(pr.name, '')) LIKE '%' || ulower(:search) || '%')
         ORDER BY CASE WHEN c.status = 'paid' THEN c.paid_at ELSE c.due_date END DESC, c.id DESC
         LIMIT 3000`,
        {
          t: today(),
          status: str(p.status),
          overdue: p.overdue ? 1 : 0,
          kind: str(p.kind),
          period: str(p.period),
          byPaid: p.status === 'paid' ? 1 : 0,
          groupId: p.groupId || null,
          studentId: p.studentId || null,
          search: str(p.search),
        }
      );
      return rows;
    },

    'charges.create': (p, ctx) => {
      if (!p.studentId) throw new AppError('STUDENT_REQUIRED');
      const kind = ['monthly', 'product', 'other'].includes(p.kind) ? p.kind : 'other';
      const quantity = Math.max(int(p.quantity, 1), 1);
      let amount = int(p.amount);
      let description = str(p.description);
      if (kind === 'product' && p.productId) {
        const product = one('SELECT name, price FROM products WHERE id = :id', { id: p.productId });
        if (!product) throw new AppError('NOT_FOUND');
        if (blank(p.amount)) amount = product.price * quantity;
        description = description || product.name;
      }
      if (kind === 'monthly') {
        if (!/^\d{4}-\d{2}$/.test(p.period || '')) throw new AppError('PERIOD_REQUIRED');
        const exists = one(
          `SELECT id FROM charges WHERE student_id = :studentId AND kind = 'monthly' AND period = :period`,
          { studentId: p.studentId, period: p.period }
        );
        if (exists) throw new AppError('MONTH_ALREADY_EXISTS');
      }
      if (amount <= 0) throw new AppError('AMOUNT_REQUIRED');
      const paid = !!p.paid;
      const r = run(
        `INSERT INTO charges (student_id, kind, period, product_id, description, quantity, amount, due_date,
                              status, paid_at, method, note, created_by, paid_by)
         VALUES (:studentId, :kind, :period, :productId, :description, :quantity, :amount, :dueDate,
                 :status, :paidAt, :method, :note, :user, :paidBy)`,
        {
          studentId: p.studentId,
          kind,
          period: kind === 'monthly' ? p.period : null,
          productId: kind === 'product' ? p.productId || null : null,
          description,
          quantity,
          amount,
          dueDate: str(p.dueDate) || (kind === 'monthly' ? `${p.period}-${pad(int(settings().due_day, 10))}` : today()),
          status: paid ? 'paid' : 'unpaid',
          paidAt: paid ? str(p.paidAt) || today() : null,
          method: paid ? str(p.method) || DEFAULT_METHOD : null,
          note: str(p.note),
          user: ctx.user || null,
          paidBy: paid ? ctx.user || null : null,
        }
      );
      log(ctx, paid ? 'charge.created_paid' : 'charge.created', `${studentName(p.studentId)} — ${description || kind} — ${amount}`);
      const newId = Number(r.lastInsertRowid);
      if (paid) notifyPaid(p.studentId, [one('SELECT * FROM charges WHERE id = :id', { id: newId })], str(p.method) || DEFAULT_METHOD, ctx);
      return { id: newId };
    },

    'charges.update': (p, ctx) => {
      const c = one('SELECT * FROM charges WHERE id = :id', { id: p.id });
      if (!c) throw new AppError('NOT_FOUND');
      const amount = int(p.amount, c.amount);
      if (amount <= 0) throw new AppError('AMOUNT_REQUIRED');
      let dueDate = str(p.dueDate) || c.due_date;
      // A monthly fee moved to another month replaces that month's unpaid fee; a paid month can't be taken.
      // The month it leaves gets its fee re-created automatically if it is still owed.
      if (c.kind === 'monthly' && /^\d{4}-\d{2}$/.test(p.period || '') && p.period !== c.period) {
        const target = one(
          `SELECT id, status FROM charges WHERE student_id = :studentId AND kind = 'monthly' AND period = :period`,
          { studentId: c.student_id, period: p.period }
        );
        if (target?.status === 'paid') throw new AppError('MONTH_ALREADY_PAID');
        if (target) run('DELETE FROM charges WHERE id = :id', { id: target.id });
        dueDate = `${p.period}-${pad(int(settings().due_day, 15))}`;
        run('UPDATE charges SET period = :period WHERE id = :id', { id: c.id, period: p.period });
      }
      run(
        `UPDATE charges SET amount = :amount, description = :description, due_date = :dueDate, note = :note,
                quantity = :quantity, paid_at = CASE WHEN status = 'paid' THEN IFNULL(:paidAt, paid_at) ELSE paid_at END,
                method = CASE WHEN status = 'paid' THEN IFNULL(:method, method) ELSE method END
         WHERE id = :id`,
        {
          id: p.id,
          amount,
          description: p.description === undefined ? c.description : str(p.description),
          dueDate,
          note: p.note === undefined ? c.note : str(p.note),
          quantity: Math.max(int(p.quantity, c.quantity), 1),
          paidAt: str(p.paidAt),
          method: str(p.method),
        }
      );
      log(ctx, 'charge.updated', `${studentName(c.student_id)} — ${amount}`);
      return true;
    },

    // amounts (optional) maps charge id -> the amount actually received, replacing the charge's amount.
    'charges.markPaid': ({ ids, amounts = {}, method, paidAt }, ctx) => {
      let total = 0;
      const done = [];
      for (const id of ids || []) {
        const c = one(`SELECT student_id, amount FROM charges WHERE id = :id AND status != 'paid'`, { id });
        if (!c) continue;
        const amount = amounts[id] == null || amounts[id] === '' ? c.amount : int(amounts[id], c.amount);
        if (amount <= 0) throw new AppError('AMOUNT_REQUIRED');
        run(
          `UPDATE charges SET status = 'paid', amount = :amount, paid_at = :paidAt, method = :method, paid_by = :user
           WHERE id = :id`,
          { id, amount, paidAt: str(paidAt) || today(), method: str(method) || DEFAULT_METHOD, user: ctx.user || null }
        );
        total += amount;
        done.push(id);
        log(ctx, 'charge.paid', `${studentName(c.student_id)} — ${amount}`);
      }
      // One receipt / alert per student.
      const byStudent = new Map();
      for (const id of done) {
        const c = one('SELECT * FROM charges WHERE id = :id', { id });
        if (!byStudent.has(c.student_id)) byStudent.set(c.student_id, []);
        byStudent.get(c.student_id).push(c);
      }
      for (const [sid, list] of byStudent) notifyPaid(sid, list, str(method) || DEFAULT_METHOD, ctx);
      return { total, ids: done };
    },

    'charges.markUnpaid': ({ id }, ctx) => {
      const c = one('SELECT student_id, amount FROM charges WHERE id = :id', { id });
      if (!c) throw new AppError('NOT_FOUND');
      run(`UPDATE charges SET status = 'unpaid', paid_at = NULL, method = NULL, paid_by = NULL, excused_by = NULL WHERE id = :id`, { id });
      log(ctx, 'charge.unpaid', `${studentName(c.student_id)} — ${c.amount}`);
      return true;
    },

    'charges.waive': ({ id }, ctx) => {
      const c = one('SELECT student_id, amount FROM charges WHERE id = :id', { id });
      if (!c) throw new AppError('NOT_FOUND');
      run(`UPDATE charges SET status = 'waived', paid_at = NULL, method = NULL WHERE id = :id`, { id });
      log(ctx, 'charge.waived', `${studentName(c.student_id)} — ${c.amount}`);
      return true;
    },

    'charges.delete': ({ id }, ctx) => {
      const c = one('SELECT student_id, kind, amount FROM charges WHERE id = :id', { id });
      if (!c) throw new AppError('NOT_FOUND');
      // Monthly charges would be re-created automatically; they are waived instead.
      if (c.kind === 'monthly') throw new AppError('MONTHLY_CANNOT_DELETE');
      run('DELETE FROM charges WHERE id = :id', { id });
      log(ctx, 'charge.deleted', `${studentName(c.student_id)} — ${c.amount}`);
      return true;
    },

    // Records the monthly fee as paid for the chosen months (YYYY-MM): settles the month's charge if it
    // exists (with the amount received), or creates it already paid. Months already paid are skipped.
    'charges.payMonths': ({ studentId, periods, amount, method, paidAt, note }, ctx) => {
      const st = one('SELECT monthly_fee FROM students WHERE id = :id', { id: studentId });
      if (!st) throw new AppError('NOT_FOUND');
      const fee = blank(amount) ? st.monthly_fee : int(amount);
      if (!(fee > 0)) throw new AppError('AMOUNT_REQUIRED');
      const dueDay = pad(int(settings().due_day, 15));
      const paid = { paidAt: str(paidAt) || today(), method: str(method) || DEFAULT_METHOD, user: ctx.user || null, note: str(note), amount: fee };
      let total = 0;
      const done = [];
      const donePeriods = [];
      for (const period of periods || []) {
        if (!/^\d{4}-\d{2}$/.test(period)) continue;
        const existing = one(
          `SELECT id, status FROM charges WHERE student_id = :studentId AND kind = 'monthly' AND period = :period`,
          { studentId, period }
        );
        if (existing?.status === 'paid') continue;
        if (existing) {
          run(
            `UPDATE charges SET status = 'paid', amount = :amount, paid_at = :paidAt, method = :method, paid_by = :user,
                    note = IFNULL(:note, note)
             WHERE id = :id`,
            { id: existing.id, ...paid }
          );
          done.push(existing.id);
        } else {
          const r = run(
            `INSERT INTO charges (student_id, kind, period, amount, due_date, status, paid_at, method, note, created_by, paid_by)
             VALUES (:studentId, 'monthly', :period, :amount, :dueDate, 'paid', :paidAt, :method, :note, :user, :user)`,
            { studentId, period, dueDate: `${period}-${dueDay}`, ...paid }
          );
          done.push(Number(r.lastInsertRowid));
        }
        total += fee;
        donePeriods.push(period);
      }
      log(ctx, 'charge.paid', `${studentName(studentId)} — ${(periods || []).join(', ')} — ${total}`);
      if (done.length) notifyPaid(studentId, done.map((id) => one('SELECT * FROM charges WHERE id = :id', { id })), paid.method, ctx);
      return { total, ids: done, periods: donePeriods };
    },

    // Saves the ՀԴՄ receipt number printed for these payments.
    'charges.setReceipt': ({ ids, receipt }, ctx) => {
      for (const id of ids || []) {
        run(`UPDATE charges SET hdm_receipt = :receipt, hdm_at = datetime('now', 'localtime') WHERE id = :id`, { id, receipt: str(receipt) });
      }
      log(ctx, 'charge.receipt', `${receipt} — ${(ids || []).length}`);
      return true;
    },

    // ---------------------------------------------------------------- attendance
    'attendance.save': ({ date, groupId, entries }, ctx) => {
      if (!date) throw new AppError('DATE_REQUIRED');
      let marked = 0;
      for (const e of entries || []) {
        if (!e.status) {
          run('DELETE FROM attendance WHERE student_id = :studentId AND date = :date', { studentId: e.studentId, date });
          continue;
        }
        run(
          `INSERT INTO attendance (student_id, date, status, group_id, marked_by)
           VALUES (:studentId, :date, :status, :groupId, :user)
           ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`,
          { studentId: e.studentId, date, status: e.status, groupId: groupId || null, user: ctx.user || null }
        );
        marked++;
      }
      log(ctx, 'attendance.saved', `${formatDate(date)} — ${marked}`);
      return { marked };
    },

    // ---------------------------------------------------------------- attendance sheet («Հաճախելիություն»)
    // A month opened for the first time gets the club's standard 10 training days, which can then be edited.
    'training.ensure': ({ groupId, month }) => {
      if (!groupId || !/^\d{4}-\d{2}$/.test(month || '')) throw new AppError('DATE_REQUIRED');
      if (one('SELECT 1 AS x FROM training_months WHERE group_id = :groupId AND month = :month', { groupId, month })) {
        return { created: 0 };
      }
      run('INSERT INTO training_months (group_id, month) VALUES (:groupId, :month)', { groupId, month });
      const dates = defaultTrainingDays(month);
      for (const date of dates) run('INSERT OR IGNORE INTO training_days (group_id, date) VALUES (:groupId, :date)', { groupId, date });
      return { created: dates.length };
    },

    'training.month': ({ groupId, month }) => {
      const range = { groupId, from: `${month}-01`, to: `${addMonths(month, 1)}-01`, t: today() };
      return {
        days: all(
          `SELECT id, date FROM training_days WHERE group_id = :groupId AND date >= :from AND date < :to ORDER BY date`,
          range
        ),
        students: all(
          `SELECT s.id, s.first_name, s.last_name, s.patronymic, s.status,
                  IFNULL((SELECT SUM(amount) FROM charges c WHERE c.student_id = s.id AND c.status = 'unpaid'), 0) AS unpaid,
                  IFNULL((SELECT SUM(amount) FROM charges c
                          WHERE c.student_id = s.id AND c.status = 'unpaid' AND c.due_date < :t), 0) AS overdue
           FROM students s
           WHERE s.group_id = :groupId
             AND (s.status = 'active' OR EXISTS (SELECT 1 FROM attendance a WHERE a.student_id = s.id
                                                 AND a.date >= :from AND a.date < :to))
           ORDER BY s.first_name COLLATE NOCASE, s.last_name COLLATE NOCASE`,
          range
        ),
        records: all(
          `SELECT a.student_id, a.date, a.status FROM attendance a JOIN students s ON s.id = a.student_id
           WHERE s.group_id = :groupId AND a.date >= :from AND a.date < :to`,
          range
        ),
        // Excused absence periods touching this month (blank days in them count as «Հարգելի»).
        absences: all(
          `SELECT a.student_id, a.date_from, a.date_to FROM absences a JOIN students s ON s.id = a.student_id
           WHERE s.group_id = :groupId AND a.date_from < :to AND a.date_to >= :from`,
          range
        ),
        submitted: one(
          'SELECT submitted_at, submitted_by FROM training_months WHERE group_id = :groupId AND month = :month',
          { groupId, month }
        ) || {},
        // Training days that already have saved attendance.
        filled: all(
          `SELECT td.date FROM training_days td
           WHERE td.group_id = :groupId AND td.date >= :from AND td.date < :to
             AND EXISTS (SELECT 1 FROM attendance a JOIN students s ON s.id = a.student_id
                         WHERE s.group_id = :groupId AND a.date = td.date)`,
          range
        ).map((r) => r.date),
      };
    },

    // Saves the whole month's sheet (status present, absent, or empty to clear) and marks it «Ներկայացված».
    'training.submit': ({ groupId, month, entries }, ctx) => {
      if (!groupId || !/^\d{4}-\d{2}$/.test(month || '')) throw new AppError('DATE_REQUIRED');
      for (const e of entries || []) {
        if (e.status === 'present' || e.status === 'absent' || e.status === 'excused') {
          run(
            `INSERT INTO attendance (student_id, date, status, group_id, marked_by)
             VALUES (:studentId, :date, :status, :groupId, :user)
             ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`,
            { studentId: e.studentId, date: e.date, status: e.status, groupId, user: ctx.user || null }
          );
        } else {
          run('DELETE FROM attendance WHERE student_id = :studentId AND date = :date', { studentId: e.studentId, date: e.date });
        }
      }
      run(
        `INSERT INTO training_months (group_id, month, submitted_at, submitted_by)
         VALUES (:groupId, :month, datetime('now', 'localtime'), :user)
         ON CONFLICT(group_id, month) DO UPDATE SET submitted_at = excluded.submitted_at, submitted_by = excluded.submitted_by`,
        { groupId, month, user: ctx.user || null }
      );
      log(ctx, 'training.submitted', `${one('SELECT name FROM groups WHERE id = :groupId', { groupId })?.name || ''} — ${month}`);
      return true;
    },

    'training.addDay': ({ groupId, date }) => {
      if (!groupId || blank(date)) throw new AppError('DATE_REQUIRED');
      if (one('SELECT id FROM training_days WHERE group_id = :groupId AND date = :date', { groupId, date })) {
        throw new AppError('DAY_EXISTS');
      }
      const r = run('INSERT INTO training_days (group_id, date) VALUES (:groupId, :date)', { groupId, date });
      return { id: Number(r.lastInsertRowid) };
    },

    // Changing a training day's date moves the marks made on it to the new date.
    'training.moveDay': ({ id, date }) => {
      const day = one('SELECT group_id, date FROM training_days WHERE id = :id', { id });
      if (!day) throw new AppError('NOT_FOUND');
      if (blank(date)) throw new AppError('DATE_REQUIRED');
      if (date === day.date) return true;
      if (one('SELECT id FROM training_days WHERE group_id = :groupId AND date = :date', { groupId: day.group_id, date })) {
        throw new AppError('DAY_EXISTS');
      }
      const p = { groupId: day.group_id, old: day.date, date };
      run(
        `UPDATE attendance SET date = :date
         WHERE date = :old AND student_id IN (SELECT id FROM students WHERE group_id = :groupId)
           AND NOT EXISTS (SELECT 1 FROM attendance b WHERE b.student_id = attendance.student_id AND b.date = :date)`,
        p
      );
      run(`DELETE FROM attendance WHERE date = :old AND student_id IN (SELECT id FROM students WHERE group_id = :groupId)`, p);
      run('UPDATE training_days SET date = :date WHERE id = :id', { id, date });
      return true;
    },

    // Removes every training day of the month (and the marks made on them), so the club can add its own.
    'training.clearMonth': ({ groupId, month }, ctx) => {
      const range = { groupId, from: `${month}-01`, to: `${addMonths(month, 1)}-01` };
      run(
        `DELETE FROM attendance WHERE student_id IN (SELECT id FROM students WHERE group_id = :groupId)
           AND date IN (SELECT date FROM training_days WHERE group_id = :groupId AND date >= :from AND date < :to)`,
        range
      );
      const r = run('DELETE FROM training_days WHERE group_id = :groupId AND date >= :from AND date < :to', range);
      log(ctx, 'training.cleared', `${one('SELECT name FROM groups WHERE id = :groupId', { groupId })?.name || ''} — ${month}`);
      return { removed: r.changes };
    },

    'training.removeDay': ({ id }) => {
      const day = one('SELECT group_id, date FROM training_days WHERE id = :id', { id });
      if (!day) return true;
      run(`DELETE FROM attendance WHERE date = :date AND student_id IN (SELECT id FROM students WHERE group_id = :groupId)`, {
        date: day.date,
        groupId: day.group_id,
      });
      run('DELETE FROM training_days WHERE id = :id', { id });
      return true;
    },

    // One cell of the sheet: present, absent, or cleared (status empty).
    'attendance.mark': ({ studentId, date, status, groupId }, ctx) => {
      if (!studentId || blank(date)) throw new AppError('DATE_REQUIRED');
      if (!status) {
        run('DELETE FROM attendance WHERE student_id = :studentId AND date = :date', { studentId, date });
        return true;
      }
      run(
        `INSERT INTO attendance (student_id, date, status, group_id, marked_by)
         VALUES (:studentId, :date, :status, :groupId, :user)
         ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status, marked_by = excluded.marked_by`,
        { studentId, date, status, groupId: groupId || null, user: ctx.user || null }
      );
      return true;
    },

    // ---------------------------------------------------------------- Word contract templates
    'docTemplates.list': () =>
      all(
        `SELECT id, name, file_name, length(file) AS size, created_at, updated_at
         FROM doc_templates ORDER BY name COLLATE NOCASE`
      ),

    // The template file itself (base64), to download or replace it.
    'docTemplates.get': ({ id }) => {
      const tpl = one('SELECT id, name, file_name, file FROM doc_templates WHERE id = :id', { id });
      if (!tpl) throw new AppError('NOT_FOUND');
      return { id: tpl.id, name: tpl.name, file_name: tpl.file_name, data: Buffer.from(tpl.file).toString('base64') };
    },

    'docTemplates.save': (p, ctx) => {
      if (blank(p.name)) throw new AppError('NAME_REQUIRED');
      let file = null;
      if (p.data) {
        file = Buffer.from(p.data, 'base64');
        try {
          word.inspectTemplate(file);
        } catch {
          throw new AppError('BAD_TEMPLATE');
        }
      }
      if (p.id) {
        run(
          `UPDATE doc_templates SET name = :name, file = IFNULL(:file, file), file_name = IFNULL(:fileName, file_name),
                  updated_at = datetime('now', 'localtime') WHERE id = :id`,
          { id: p.id, name: str(p.name), file, fileName: str(p.file_name) }
        );
        log(ctx, 'template.updated', str(p.name));
        return { id: p.id };
      }
      if (!file) throw new AppError('BAD_TEMPLATE');
      const r = run('INSERT INTO doc_templates (name, file, file_name) VALUES (:name, :file, :fileName)', {
        name: str(p.name),
        file,
        fileName: str(p.file_name),
      });
      log(ctx, 'template.created', str(p.name));
      return { id: Number(r.lastInsertRowid) };
    },

    'docTemplates.delete': ({ id }, ctx) => {
      const tpl = one('SELECT name FROM doc_templates WHERE id = :id', { id });
      run('DELETE FROM doc_templates WHERE id = :id', { id });
      log(ctx, 'template.deleted', tpl?.name);
      return true;
    },

    // ---------------------------------------------------------------- contracts
    'contracts.list': (p = {}) =>
      all(
        `SELECT ct.id, ct.number, ct.title, ct.contract_date, ct.start_date, ct.end_date, ct.signed_date, ct.created_at,
                ct.doc_template_id,
                CASE WHEN ct.status = 'signed' AND ct.end_date < :t THEN 'expired' ELSE ct.status END AS status,
                s.id AS student_id, s.first_name, s.last_name, s.patronymic, g.name AS group_name
         FROM contracts ct JOIN students s ON s.id = ct.student_id
         LEFT JOIN groups g ON g.id = s.group_id
         WHERE (:search IS NULL OR ulower(s.first_name || ' ' || s.last_name || ' ' || s.first_name || ' ' ||
                IFNULL(ct.number, '') || ' ' || ct.title) LIKE '%' || ulower(:search) || '%')
           AND (:status IS NULL OR (CASE WHEN ct.status = 'signed' AND ct.end_date < :t THEN 'expired'
                                         ELSE ct.status END) = :status)
         ORDER BY IFNULL(ct.contract_date, ct.created_at) DESC, ct.id DESC`,
        { t: today(), search: str(p.search), status: str(p.status) }
      ),

    'contracts.get': ({ id }) => {
      const c = one(
        `SELECT ct.*, s.first_name, s.last_name, s.patronymic FROM contracts ct JOIN students s ON s.id = ct.student_id
         WHERE ct.id = :id`,
        { id }
      );
      if (!c) throw new AppError('NOT_FOUND');
      return c;
    },

    // A contract from a Word template; the number comes from the student's «Պայմանագրի համար».
    'contracts.create': (p, ctx) => {
      const s = one('SELECT id, contract_no FROM students WHERE id = :id', { id: p.studentId });
      if (!s) throw new AppError('STUDENT_REQUIRED');
      const tpl = p.docTemplateId ? one('SELECT id, name FROM doc_templates WHERE id = :id', { id: p.docTemplateId }) : null;
      if (!tpl) throw new AppError('TEMPLATE_REQUIRED');
      if (blank(p.contractDate)) throw new AppError('DATE_REQUIRED');
      const r = run(
        `INSERT INTO contracts (number, student_id, doc_template_id, title, body, contract_date, start_date, status, created_by)
         VALUES (:number, :studentId, :templateId, :title, '', :contractDate, :startDate, 'draft', :user)`,
        {
          number: str(s.contract_no),
          studentId: s.id,
          templateId: tpl.id,
          title: tpl.name,
          contractDate: str(p.contractDate),
          startDate: str(p.startDate),
          user: ctx.user || null,
        }
      );
      log(ctx, 'contract.created', `${s.contract_no || ''} — ${studentName(s.id)}`);
      return { id: Number(r.lastInsertRowid) };
    },

    'contracts.save': (p, ctx) => {
      const c = one('SELECT number, student_id FROM contracts WHERE id = :id', { id: p.id });
      if (!c) throw new AppError('NOT_FOUND');
      const status = ['draft', 'signed', 'terminated'].includes(p.status) ? p.status : 'draft';
      run(
        `UPDATE contracts SET title = :title, body = :body, contract_date = :contractDate, start_date = :startDate,
                end_date = :endDate, status = :status, signed_date = :signedDate, updated_at = datetime('now', 'localtime')
         WHERE id = :id`,
        {
          id: p.id,
          title: str(p.title) || c.number || '',
          body: p.body || '',
          contractDate: str(p.contract_date),
          startDate: str(p.start_date),
          endDate: str(p.end_date),
          status,
          signedDate: status === 'signed' ? str(p.signed_date) || today() : str(p.signed_date),
        }
      );
      log(ctx, 'contract.updated', `${c.number || ''} — ${studentName(c.student_id)}`);
      return true;
    },

    'contracts.delete': ({ id }, ctx) => {
      const c = one('SELECT number, student_id FROM contracts WHERE id = :id', { id });
      run('DELETE FROM contracts WHERE id = :id', { id });
      if (c) log(ctx, 'contract.deleted', `${c.number || ''} — ${studentName(c.student_id)}`);
      return true;
    },

    // The filled Word file of a contract (base64), built from the student's current details.
    'contracts.document': ({ id }) => {
      const c = one('SELECT * FROM contracts WHERE id = :id', { id });
      if (!c) throw new AppError('NOT_FOUND');
      const tpl = c.doc_template_id ? one('SELECT file FROM doc_templates WHERE id = :id', { id: c.doc_template_id }) : null;
      if (!tpl) throw new AppError('TEMPLATE_REQUIRED');
      const s = one(
        `SELECT st.*, g.name AS group_name FROM students st LEFT JOIN groups g ON g.id = st.group_id WHERE st.id = :id`,
        { id: c.student_id }
      );
      let file;
      try {
        file = word.fillTemplate(Buffer.from(tpl.file), word.contractValues(s, c));
      } catch {
        throw new AppError('BAD_TEMPLATE');
      }
      const name = `Պայմանագիր ${c.number || ''} ${s.last_name} ${s.first_name}`.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ');
      return { fileName: `${name.trim()}.docx`, data: file.toString('base64') };
    },

    // ---------------------------------------------------------------- reports
    // Payments received between two dates, for Excel export: one method, or all when method is empty.
    'reports.list': ({ method, from, to } = {}) =>
      all(
        `SELECT c.id, c.paid_at, c.amount, c.kind, c.period, c.description, c.quantity, c.method, c.paid_by, c.note,
                pr.name AS product_name, s.first_name, s.last_name, s.patronymic, s.contract_no, s.parent_name,
                s.parent_phone, g.name AS group_name
         FROM charges c
         JOIN students s ON s.id = c.student_id
         LEFT JOIN groups g ON g.id = s.group_id
         LEFT JOIN products pr ON pr.id = c.product_id
         WHERE c.status = 'paid' AND (:method IS NULL OR c.method = :method) AND c.paid_at BETWEEN :from AND :to
         ORDER BY c.paid_at, s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`,
        { method: str(method), from: str(from) || '0000-00-00', to: str(to) || '9999-12-31' }
      ),

    // ---------------------------------------------------------------- demo data
    'demo.load': (p, ctx) => {
      if (one('SELECT COUNT(*) AS n FROM students').n > 0) throw new AppError('DEMO_NOT_EMPTY');
      return require('./demo').load({ methods, one, all, run, settings, ctx });
    },

    'demo.clear': (p, ctx) => {
      if (settings().demo_loaded !== '1') throw new AppError('NO_DEMO');
      return require('./demo').clear({ run, settings, ctx });
    },

    // ---------------------------------------------------------------- activity
    'activity.list': ({ limit } = {}) =>
      all('SELECT * FROM activity_log ORDER BY id DESC LIMIT :limit', { limit: Math.min(int(limit, 200), 1000) }),
  };

  // 10 training days spread evenly over the month, moving any Sunday to the next day.
  function defaultTrainingDays(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const dates = new Set();
    for (let i = 0; i < 10; i++) {
      let day = 1 + Math.round((i * (last - 1)) / 9);
      if (new Date(y, m - 1, day).getDay() === 0) day = day < last ? day + 1 : day - 1;
      dates.add(`${month}-${pad(day)}`);
    }
    return [...dates].sort();
  }

  const READ_ONLY = /\.(get|list|summary|sheet|month|preview|document|status)$/;
  const auth = createAuth({ all, one, run, AppError, log });
  Object.assign(methods, auth.methods);

  // Single entry point used by both the local IPC bridge and the LAN server.
  // ctx: { user (name from the calling PC), token (sign-in session) }
  function call(method, params, ctx = {}) {
    const fn = methods[method];
    if (!fn) return { ok: false, error: 'UNKNOWN_METHOD' };
    const write = !READ_ONLY.test(method);
    try {
      const gate = auth.check(method, write, ctx);
      if (gate.error) return { ok: false, error: gate.error };
      ctx = gate.ctx;
      if (!write) {
        // Reads that show dues make sure this month's fees exist first.
        if (/^(dashboard|students|charges)\./.test(method) && ensureMonthlyCharges() > 0) onWrite?.();
        return { ok: true, result: auth.filter(method, fn(params || {}, ctx), ctx) };
      }
      db.exec('BEGIN IMMEDIATE');
      let result;
      try {
        result = fn(params || {}, ctx);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      // Signing in/out changes no club data, so other PCs don't need to refresh.
      if (!method.startsWith('auth.')) onWrite?.();
      return { ok: true, result };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, error: err.message };
      console.error(`[service] ${method} failed:`, err);
      return { ok: false, error: 'INTERNAL', detail: err.message };
    }
  }

  // Used by notify.js on the host PC (not reachable over the LAN).
  const outbox = {
    pending: () => all(`SELECT * FROM outbox WHERE status = 'pending' ORDER BY id LIMIT 20`),
    sent: (id) => run(`UPDATE outbox SET status = 'sent', sent_at = datetime('now', 'localtime'), error = NULL WHERE id = :id`, { id }),
    failed: (id, error, final) =>
      run(`UPDATE outbox SET attempts = attempts + 1, error = :error, status = CASE WHEN :final = 1 THEN 'failed' ELSE status END WHERE id = :id`, {
        id,
        error: String(error || '').slice(0, 300),
        final: final ? 1 : 0,
      }),
    add: (m) => enqueue(m, { user: 'FC Manager' }),
    summary: (kind, when) => queueSummary(kind, when, { user: 'FC Manager' }),
    autoReminders: () => (emailOn() ? remindOverdue(null, { user: 'FC Manager' }, { skipReminded: true }) : null),
    preview: (kind, when) => summaryText(kind, when),
  };

  return { call, ensureMonthlyCharges, settings, outbox };
}

module.exports = { createService, DEFAULT_TEMPLATES };
