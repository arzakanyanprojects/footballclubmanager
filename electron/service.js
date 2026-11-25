// All data operations. The host PC runs these directly; client PCs reach them over the LAN
// through the same method names (see server.js / remote.js), so there is one code path.

const { feeShares: holidayShares, freeHalves, parseHolidays } = require('./holidays');
const word = require('./word');
const { createAuth } = require('./auth');

class AppError extends Error {
  constructor(code, detail) {
    super(code);
    this.detail = detail;
  }
}
const { createLocks, mondayOf } = require('./locks');

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
const formatDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

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
  // studentId / meta: the student the action is about and its details (for the student's history).
  const log = (ctx, action, details, studentId = null, meta = null) => {
    run('INSERT INTO activity_log (user, action, details, student_id, meta) VALUES (:user, :action, :details, :studentId, :meta)', {
      user: ctx.user || null,
      action,
      details: details || null,
      studentId: studentId || null,
      meta: meta ? JSON.stringify(meta) : null,
    });
    noteAction(ctx, action, details, meta);
  };

  // ---------------------------------------------------------------- users' actions → Telegram
  // The actions of the users chosen in Settings → Notifications are collected during one save and sent
  // together when it is saved (one message for a payment of three months, one for an attendance sheet).
  const LABELS = require('./activityLabels');
  let actionNotes = []; // lines of the save in progress
  let actionUser = null;
  // Ticked in the user's own settings (Settings → Users → «Գործողությունները՝ Telegram-ով»).
  const watched = (ctx) => !ctx.quiet && !!ctx.account?.notify_actions;
  const showValue = (k, v) => {
    if (v === '' || v == null) return '—';
    if (k === 'category') return LABELS.categories[v] || v;
    if (k === 'status') return LABELS.statuses[v] || v;
    if (k === 'medical_doc') return Number(v) ? '✓' : '✕';
    if (/date$/.test(k)) return String(v).slice(0, 10).split('-').reverse().join('/');
    if (k === 'monthly_fee') return amd(v);
    return String(v);
  };
  function noteAction(ctx, action, details, meta) {
    if (action === 'attendance.changed' || !watched(ctx)) return; // the sheet's summary line says it
    actionUser = ctx.account.full_name || ctx.account.username;
    let line = `• ${LABELS.actions[action] || action}${details ? ` — ${details}` : ''}`;
    // A payment / fee: the student, then that month and its amount (one line per month).
    if (meta?.amount != null && /^charge\./.test(action)) {
      const who = String(details || '').split(' — ')[0];
      const month = /^\d{4}-\d{2}$/.test(meta.period || '') ? `${LABELS.months[Number(meta.period.slice(5)) - 1]} ${meta.period.slice(0, 4)}` : meta.description || '';
      line = `• ${LABELS.actions[action] || action} — ${who}${month ? ` · ${month}` : ''} · ${amd(meta.amount)}${meta.method ? ` (${LABELS.methods[meta.method] || meta.method})` : ''}`;
    }
    if (Array.isArray(meta?.changes))
      for (const [k, a, b] of meta.changes.slice(0, 8)) line += `\n   ${LABELS.fields[k] || k}: ${showValue(k, a)} → ${showValue(k, b)}`;
    if (!actionNotes.includes(line)) actionNotes.push(line);
  }
  function sendActionNotes() {
    const lines = actionNotes;
    const who = actionUser;
    actionNotes = [];
    actionUser = null;
    if (!lines.length) return;
    const chats = telegramChats();
    if (!chats.length) return;
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const when = `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    const shown = lines.slice(0, 20);
    const more = lines.length > shown.length ? `\n… ևս ${lines.length - shown.length}` : '';
    const text = `👤 ${who} · ${when}\n${shown.join('\n')}${more}`;
    for (const chat of chats) enqueue({ channel: 'telegram', recipient: chat, body: text, kind: 'action' }, { user: who });
  }
  // A charge as the history shows it.
  const chargeMeta = (id) => {
    const c = one('SELECT id, kind, period, description, amount, status, method, paid_at, hdm_receipt FROM charges WHERE id = :id', { id });
    return c ? { chargeId: c.id, kind: c.kind, period: c.period, description: c.description, amount: c.amount, status: c.status, method: c.method, paidAt: c.paid_at, hdm: c.hdm_receipt } : null;
  };
  // Student fields compared for «what changed» (photo only as changed / not).
  const HISTORY_FIELDS = ['first_name', 'last_name', 'patronymic', 'birth_date', 'document_no', 'contract_no', 'category', 'service', 'medical_doc',
    'group_id', 'monthly_fee', 'join_date', 'status', 'inactive_reason', 'leave_date',
    'parent_first_name', 'parent_last_name', 'parent_phone', 'parent_messenger', 'parent_email', 'parent_ssn', 'parent_doc_no', 'parent_doc_issuer',
    'parent_doc_date', 'parent_address', 'phone', 'email', 'address', 'photo'];
  const diffStudent = (before, after) => {
    const groupName = (id) => (id ? one('SELECT name FROM groups WHERE id = :id', { id })?.name || `#${id}` : '');
    const out = [];
    for (const k of HISTORY_FIELDS) {
      const a = before?.[k] ?? '';
      const b = after?.[k] ?? '';
      if (String(a) === String(b)) continue;
      if (k === 'photo') out.push([k, a ? '•' : '', b ? '•' : '']);
      else if (k === 'group_id') out.push(['group', groupName(a), groupName(b)]);
      else out.push([k, a, b]);
    }
    return out;
  };
  // Students connected to this one through links (directly or through another linked student).
  const relatedOf = (id) => {
    const ids = new Set([id]);
    const queue = [id];
    const direct = new Map();
    while (queue.length) {
      const cur = queue.shift();
      for (const l of all('SELECT a_id, b_id, relation FROM student_links WHERE a_id = :c OR b_id = :c', { c: cur })) {
        const other = l.a_id === cur ? l.b_id : l.a_id;
        if (cur === id) direct.set(other, l.relation);
        if (!ids.has(other)) {
          ids.add(other);
          queue.push(other);
        }
      }
    }
    ids.delete(id);
    return [...ids]
      .map((sid) => {
        const r = one(
          `SELECT s.id, s.first_name, s.last_name, s.patronymic, s.birth_date, s.status, s.category, s.contract_no, s.monthly_fee,
                  g.name AS group_name, g.color AS group_color,
                  IFNULL((SELECT SUM(amount) FROM charges c WHERE c.student_id = s.id AND c.status = 'unpaid' AND c.due_date < :t), 0) AS overdue
           FROM students s LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = :sid`,
          { sid, t: today() }
        );
        return r ? { ...r, relation: direct.get(sid) ?? null, direct: direct.has(sid) } : null;
      })
      .filter(Boolean);
  };
  const studentName = (id) => {
    const s = one('SELECT first_name, last_name FROM students WHERE id = :id', { id });
    return s ? `${s.first_name} ${s.last_name}` : `#${id}`;
  };

  // Create the monthly fee charge for every active student for every month up to now.
  // Idempotent thanks to the unique (student_id, period) index on monthly charges.
  // Holidays (date ranges in the settings) → the share of the monthly fee each month costs, e.g. { "2026-12": 50 }.
  const feeShares = () => holidayShares(parseHolidays(settings().holidays));
  const feeFor = (fee, period, shares = feeShares()) => (shares[period] != null ? Math.round((Number(fee) * shares[period]) / 100) : Number(fee));
  // A student who joins on the 16th or later owes only the 2nd half of that month (with the holidays: their halves too).
  const joinsLate = (joinDate) => /^\d{4}-\d{2}-\d{2}/.test(joinDate || '') && Number(String(joinDate).slice(8, 10)) >= 16;
  const studentFee = (fee, period, joinDate) => {
    if (!(joinsLate(joinDate) && String(joinDate).slice(0, 7) === period)) return feeFor(fee, period);
    const free = new Set([1, ...(freeHalves(parseHolidays(settings().holidays)).get(period) || [])]);
    return Math.round((Number(fee) * (100 - 50 * free.size)) / 100);
  };
  // The joining month of late joiners gets its half price (unpaid system fees only).
  function priceJoinMonths(studentId = null) {
    for (const c of all(
      `SELECT c.id, c.amount, c.period, s.monthly_fee, s.join_date FROM charges c JOIN students s ON s.id = c.student_id
       WHERE c.kind = 'monthly' AND c.status = 'unpaid' AND c.excused_by IS NULL AND c.period = substr(s.join_date, 1, 7)
         AND s.first_fee IS NULL AND CAST(substr(s.join_date, 9, 2) AS INTEGER) >= 16 ${studentId ? 'AND s.id = :sid AND c.student_id = :sid' : ''}`,
      studentId ? { sid: studentId } : {}
    )) {
      // Only a month still at the usual price (a special price, e.g. set by an import, stays).
      if (c.amount !== feeFor(c.monthly_fee, c.period) && c.amount !== studentFee(c.monthly_fee, c.period, c.join_date)) continue;
      const want = studentFee(c.monthly_fee, c.period, c.join_date);
      if (want <= 0) run('DELETE FROM charges WHERE id = :id', { id: c.id });
      else if (want !== c.amount) run('UPDATE charges SET amount = :want WHERE id = :id', { id: c.id, want });
    }
  }
  // SQL for a month's fee: the student's fee times the month's share.
  const feeSql = (feeCol, periodCol, shares = feeShares()) => {
    const cases = Object.entries(shares).map(([p, v]) => `WHEN '${p}' THEN ${Number(v) / 100}`);
    return cases.length ? `CAST(ROUND(${feeCol} * (CASE ${periodCol} ${cases.join(' ')} ELSE 1 END)) AS INTEGER)` : feeCol;
  };

  // studentId: only that student's fees (after saving one student); otherwise everyone's.
  function ensureMonthlyCharges(studentId = null) {
    const s = settings();
    const dueDay = Math.min(Math.max(int(s.due_day, 10), 1), 28);
    const r = run(
      `WITH RECURSIVE months(p) AS (
         SELECT :start
         UNION ALL
         SELECT strftime('%Y-%m', date(p || '-01', '+1 month')) FROM months WHERE p < :current
       )
       INSERT OR IGNORE INTO charges (student_id, kind, period, amount, due_date, created_by)
       SELECT st.id, 'monthly', m.p,
              CASE WHEN st.first_fee IS NOT NULL AND m.p = substr(st.join_date, 1, 7) THEN st.first_fee ELSE ${feeSql('st.monthly_fee', 'm.p')} END,
              m.p || '-' || :dueDay, 'system'
       FROM students st
       JOIN months m ON m.p >= substr(st.join_date, 1, 7)
                    AND m.p >= IFNULL(st.billing_from, '0000-00')
       WHERE st.status = 'active'
         AND (CASE WHEN st.first_fee IS NOT NULL AND m.p = substr(st.join_date, 1, 7) THEN st.first_fee ELSE st.monthly_fee END) > 0
         ${studentId ? 'AND st.id = :sid' : ''}
         ${(() => {
           const free = Object.entries(feeShares()).filter(([, v]) => v === 0).map(([p]) => `'${p}'`);
           return free.length ? `AND m.p NOT IN (${free.join(', ')})` : ''; // months with no fee at all
         })()}`,
      { start: s.billing_start || currentPeriod(), current: currentPeriod(), dueDay: pad(dueDay), ...(studentId ? { sid: studentId } : {}) }
    );
    priceJoinMonths(studentId);
    return r.changes;
  }

  // ---------------------------------------------------------------- settings
  const SETTING_KEYS = ['club_name', 'club_address', 'club_phone', 'director_name', 'currency', 'due_day', 'billing_start', 'club_logo', 'holidays',
    'contract_prefix', 'contract_next', // the next new student's contract number: prefix + number
    'msg_reminder', 'msg_receipt', 'msg_free']; // msg_*: WhatsApp / Viber message texts

  // A «Դիմում» period on a payment: both dates, the end not before the start; otherwise none.
  function absenceRange(from, to) {
    const f = str(from);
    const t = str(to);
    if (!f || !t) return { from: null, to: null };
    if (t < f) throw new AppError('PERIOD_INVALID');
    return { from: f, to: t };
  }

  // ---------------------------------------------------------------- imported payments
  // payments: paid months read from a team file (amount 0 — typed in later).
  // carried: a moving file's charges, copied as they are.
  // A month already paid (or waived) is never overwritten; an unpaid one becomes paid.
  function addImportedPayments(studentId, payments, carried, ctx) {
    const dueDay = pad(int(settings().due_day, 15));
    const methodOk = (m) => (['card', 'easypay', 'transfer'].includes(m) ? m : DEFAULT_METHOD);
    let n = 0;
    const monthly = (c) => {
      const ex = one(`SELECT id, status FROM charges WHERE student_id = :sid AND kind = 'monthly' AND period = :period`, { sid: studentId, period: c.period });
      if (ex && ex.status !== 'unpaid') return;
      if (ex && c.status !== 'paid') return;
      if (ex) {
        run(
          `UPDATE charges SET status = 'paid', amount = CASE WHEN :amount > 0 THEN :amount ELSE amount END, paid_at = :paidAt, method = :method,
             paid_by = :user, note = IFNULL(:note, note) WHERE id = :id`,
          { id: ex.id, amount: int(c.amount), paidAt: c.paid_at, method: methodOk(c.method), user: ctx.user || null, note: str(c.note) }
        );
      } else {
        run(
          `INSERT INTO charges (student_id, kind, period, amount, due_date, status, paid_at, method, note, created_by, paid_by)
           VALUES (:sid, 'monthly', :period, :amount, :due, :status, :paidAt, :method, :note, :user, :paidBy)`,
          {
            sid: studentId, period: c.period, amount: int(c.amount), due: c.due_date || `${c.period}-${dueDay}`,
            status: ['paid', 'unpaid', 'waived'].includes(c.status) ? c.status : 'paid',
            paidAt: c.status === 'unpaid' ? null : c.paid_at, method: c.status === 'paid' ? methodOk(c.method) : null,
            note: str(c.note), user: ctx.user || null, paidBy: c.status === 'paid' ? ctx.user || null : null,
          }
        );
      }
      n++;
    };
    for (const p of payments) {
      if (!/^\d{4}-\d{2}$/.test(p.period || '') || !p.paid_at) continue;
      monthly({ ...p, status: 'paid', amount: Math.max(int(p.amount) || 0, 0) });
    }
    for (const c of carried) {
      if (c.kind === 'monthly') {
        if (/^\d{4}-\d{2}$/.test(c.period || '')) monthly(c);
        continue;
      }
      // Other payments: added once (same description, amount and date are not added again).
      const dup = one(
        `SELECT id FROM charges WHERE student_id = :sid AND kind = :kind AND IFNULL(description, '') = IFNULL(:d, '')
           AND amount = :amount AND IFNULL(due_date, '') = IFNULL(:due, '')`,
        { sid: studentId, kind: c.kind || 'other', d: str(c.description), amount: int(c.amount), due: str(c.due_date) }
      );
      if (dup) continue;
      run(
        `INSERT INTO charges (student_id, kind, description, amount, due_date, status, paid_at, method, note, created_by, paid_by)
         VALUES (:sid, :kind, :d, :amount, :due, :status, :paidAt, :method, :note, :user, :paidBy)`,
        {
          sid: studentId, kind: ['product', 'other'].includes(c.kind) ? c.kind : 'other', d: str(c.description), amount: int(c.amount),
          due: str(c.due_date) || today(), status: ['paid', 'unpaid', 'waived'].includes(c.status) ? c.status : 'unpaid',
          paidAt: c.status === 'paid' ? c.paid_at : null, method: c.status === 'paid' ? methodOk(c.method) : null,
          note: str(c.note), user: ctx.user || null, paidBy: c.status === 'paid' ? ctx.user || null : null,
        }
      );
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- excused absences
  // Training days in the period become «Հարգելի» (unless marked present). The fee works in half-months
  // (1–15, 16 – end), like the holidays: a half mostly covered by the application is not owed. A month
  // with both halves free (application and holidays together) is waived; with one half free it costs half,
  // and the payment shows the application's dates. Paid months stay as they are.
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
    const own = freeHalves([{ from: a.date_from, to: a.date_to }]);
    const holiday = freeHalves(parseHolidays(settings().holidays));
    const created = [];
    const reduced = {};
    for (const [period, halves] of own) {
      const free = new Set([...halves, ...(holiday.get(period) || [])]);
      const c = one(`SELECT id, status, amount FROM charges WHERE student_id = :sid AND kind = 'monthly' AND period = :period`, { sid: s.id, period });
      if (free.size >= 2) {
        if (c) {
          if (c.status === 'unpaid')
            run(`UPDATE charges SET status = 'waived', excused_by = :aid, absence_from = :from, absence_to = :to WHERE id = :id`, {
              id: c.id, aid: a.id, from: a.date_from, to: a.date_to,
            });
        } else if (s.monthly_fee > 0) {
          const r = run(
            `INSERT INTO charges (student_id, kind, period, amount, due_date, status, excused_by, absence_from, absence_to, created_by)
             VALUES (:sid, 'monthly', :period, :fee, :due, 'waived', :aid, :from, :to, :user)`,
            { sid: s.id, period, fee: s.monthly_fee, due: `${period}-${dueDay}`, aid: a.id, from: a.date_from, to: a.date_to, user: a.created_by }
          );
          created.push(Number(r.lastInsertRowid));
        }
        continue;
      }
      // Half the month: the fee is halved (still owed).
      const half = Math.round((Number(s.monthly_fee) || Number(c?.amount) || 0) / 2);
      if (!(half > 0)) continue;
      if (c) {
        if (c.status !== 'unpaid') continue;
        reduced[c.id] = c.amount;
        run(`UPDATE charges SET amount = :amount, excused_by = :aid, absence_from = :from, absence_to = :to WHERE id = :id`, {
          id: c.id, amount: half, aid: a.id, from: a.date_from, to: a.date_to,
        });
      } else {
        const r = run(
          `INSERT INTO charges (student_id, kind, period, amount, due_date, status, excused_by, absence_from, absence_to, created_by)
           VALUES (:sid, 'monthly', :period, :amount, :due, 'unpaid', :aid, :from, :to, :user)`,
          { sid: s.id, period, amount: half, due: `${period}-${dueDay}`, aid: a.id, from: a.date_from, to: a.date_to, user: a.created_by }
        );
        created.push(Number(r.lastInsertRowid));
      }
    }
    run('UPDATE absences SET created_charges = :c, reduced_charges = :r WHERE id = :id', { id: a.id, c: JSON.stringify(created), r: JSON.stringify(reduced) });
    // Every monthly fee of the months the application touches (paid ones too) shows its dates and opens it.
    run(
      `UPDATE charges SET absence_from = :from, absence_to = :to
       WHERE student_id = :sid AND kind = 'monthly' AND absence_from IS NULL AND period BETWEEN :pf AND :pt`,
      { sid: s.id, from: a.date_from, to: a.date_to, pf: a.date_from.slice(0, 7), pt: a.date_to.slice(0, 7) }
    );
  }

  // Undoes an absence (its application was deleted).
  function removeAbsence(absenceId) {
    const a = one('SELECT * FROM absences WHERE id = :id', { id: absenceId });
    if (!a) return;
    // Fees this absence created for months still ahead go away; normal monthly billing adds them when their time comes.
    for (const cid of JSON.parse(a.created_charges || '[]')) {
      run(`DELETE FROM charges WHERE id = :cid AND excused_by = :id AND status != 'paid' AND period > :now`, { cid, id: a.id, now: currentPeriod() });
    }
    // Halved fees get their amount back (if still unpaid); waived months are owed again.
    for (const [cid, amount] of Object.entries(JSON.parse(a.reduced_charges || '{}')))
      run(`UPDATE charges SET amount = :amount WHERE id = :cid AND status = 'unpaid'`, { cid: Number(cid), amount });
    run(`UPDATE charges SET status = 'unpaid', excused_by = NULL, absence_from = NULL, absence_to = NULL WHERE excused_by = :id AND status = 'waived'`, { id: a.id });
    run(
      `UPDATE charges SET absence_from = NULL, absence_to = NULL
       WHERE student_id = :sid AND excused_by IS NULL AND absence_from = :from AND absence_to = :to`,
      { sid: a.student_id, from: a.date_from, to: a.date_to }
    );
    run(
      `UPDATE charges SET excused_by = NULL, absence_from = NULL, absence_to = NULL WHERE excused_by = :id AND status != 'waived'`,
      { id: a.id }
    );
    run(
      `DELETE FROM attendance WHERE student_id = :sid AND status = 'excused' AND date BETWEEN :from AND :to
         AND NOT EXISTS (SELECT 1 FROM absences b WHERE b.id != :id AND b.student_id = :sid AND attendance.date BETWEEN b.date_from AND b.date_to)`,
      { sid: a.student_id, from: a.date_from, to: a.date_to, id: a.id }
    );
    run('DELETE FROM absences WHERE id = :id', { id: a.id });
  }

  // «Դիմում» — the same three things wherever it is made (the «Ստեղծել դիմում» button, a payment's
  // «Խմբագրել», paying a month with «Դիմում»): the application document under the student's documents,
  // the months it covers excused («Հարգելի») or halved, and the dates shown under those monthly fees.
  function createApplication(ctx, p) {
    const student = one(`SELECT s.*, g.name AS group_name FROM students s LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = :id`, { id: p.studentId });
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
    const fileId = Number(
      run(
        `INSERT INTO student_files (student_id, kind, file_name, mime, size, data, created_by)
         VALUES (:studentId, 'absence', :name, :type, :size, :data, :user)`,
        { studentId: p.studentId, name, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: buf.length, data: buf, user: ctx.user || null }
      ).lastInsertRowid
    );
    const absenceId = Number(
      run(
        `INSERT INTO absences (student_id, date_from, date_to, reason, file_id, created_by)
         VALUES (:studentId, :from, :to, :reason, :fileId, :user)`,
        { studentId: p.studentId, from: str(p.from), to: str(p.to), reason: str(p.reason), fileId, user: ctx.user || null }
      ).lastInsertRowid
    );
    excuseAbsence(absenceId);
    log(ctx, 'application.created', `${student.first_name} ${student.last_name} — ${formatDate(str(p.from))}–${formatDate(str(p.to))}`, p.studentId, {
      absenceId, fileId, from: str(p.from), to: str(p.to), reason: str(p.reason),
    });
    return { fileId, absenceId, name, buf };
  }
  // The application with exactly these dates for the student, if there is one.
  const applicationFor = (studentId, from, to) =>
    from && to ? one('SELECT * FROM absences WHERE student_id = :sid AND date_from = :from AND date_to = :to ORDER BY id DESC LIMIT 1', { sid: studentId, from, to }) : null;
  // An application taken back: the months it touched as they were, and its document deleted.
  function dropApplication(a, ctx) {
    if (!a) return;
    removeAbsence(a.id);
    if (a.file_id) {
      const f = one('SELECT file_name FROM student_files WHERE id = :id', { id: a.file_id });
      run('DELETE FROM student_files WHERE id = :id', { id: a.file_id });
      if (f) log(ctx, 'file.deleted', `${studentName(a.student_id)} — ${f.file_name}`, a.student_id, { name: f.file_name, kind: 'absence' });
    }
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

  // ---------------------------------------------------------------- edit locks + versions
  const locks = createLocks();
  // The record a write changes, as lock keys: refused while another window holds one of them.
  // The club's services (Settings: the student form's list); older names map to the new ones.
  const SERVICE_MAP = {
    'Առաջնություն անվճար': 'Առաջնություն', 'Առաջնություն զեղչված': 'Առաջնություն', 'Առաջնություն վճարովի': 'Առաջնություն',
    'Ուսումնամարզական %': 'Ուսումնամարզական', 'Ուսումնամարզական անվճար': 'Ուսումնամարզական',
    'Ֆուտբոլ անհ.12': 'Ֆուտբոլ անհ. 12', 'Ֆուտբոլ անհ.16': 'Ֆուտբոլ անհ. 16',
  };
  const normService = (v) => {
    const s = str(v);
    return s ? SERVICE_MAP[s.replace(/\s+/g, ' ')] || s.replace(/\s+/g, ' ') : s;
  };
  // Contract numbers in order: prefix («26-08-») + the next number, skipping numbers already used.
  // reserve: this one is taken now (the counter moves past it).
  const setSetting = (key, value) =>
    run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value: String(value) });
  function nextContractNo(reserve) {
    const st = settings();
    const prefix = st.contract_prefix || '';
    if (blank(st.contract_next)) return null;
    let n = Math.max(int(st.contract_next, 1), 1);
    while (one('SELECT 1 AS x FROM students WHERE contract_no = :c', { c: `${prefix}${n}` })) n++;
    if (reserve) setSetting('contract_next', n + 1);
    return `${prefix}${n}`;
  }
  // A number typed by hand that is next in line (or beyond) moves the counter past it too.
  function noteContractNo(no) {
    const st = settings();
    const prefix = st.contract_prefix || '';
    if (!no || blank(st.contract_next) || !String(no).startsWith(prefix)) return;
    const tail = String(no).slice(prefix.length);
    if (/^\d+$/.test(tail) && Number(tail) >= int(st.contract_next, 1)) setSetting('contract_next', Number(tail) + 1);
  }

  // A note under the student, with who added it (unless the same text is already there, e.g. a repeated import).
  function addNote(studentId, text, ctx, always = false) {
    const t = str(text);
    if (!t || !studentId) return null;
    if (!always && one('SELECT id FROM student_notes WHERE student_id = :sid AND text = :t', { sid: studentId, t })) return null;
    const r = run('INSERT INTO student_notes (student_id, text, created_by, user_id) VALUES (:sid, :t, :by, :uid)', {
      sid: studentId, t, by: ctx.user || null, uid: ctx.account?.id || null,
    });
    log(ctx, 'note.added', `${studentName(studentId)} — ${t.slice(0, 120)}`, studentId);
    return Number(r.lastInsertRowid);
  }

  function lockKeysFor(method, p = {}) {
    const studentOfCharge = (id) => one('SELECT student_id FROM charges WHERE id = :id', { id: Number(id) || 0 })?.student_id;
    const st = (...ids) => ids.filter(Boolean).map((id) => `student:${id}`);
    const month = (d) => String(d || '').slice(0, 7);
    switch (method) {
      case 'students.save':
        return p.id ? st(p.id) : [];
      case 'students.terminate':
      case 'students.delete':
        return st(p.id);
      case 'students.link':
      case 'students.unlink':
        return st(p.id, p.otherId);
      case 'charges.payMonths':
      case 'charges.create':
      case 'applications.create':
        return st(p.studentId);
      case 'charges.update':
      case 'charges.markUnpaid':
      case 'charges.waive':
      case 'charges.delete':
        return st(studentOfCharge(p.id));
      case 'charges.markPaid':
        return st(...new Set((p.ids || []).map(studentOfCharge)));
      case 'groups.save':
      case 'groups.delete':
        return p.id ? [`group:${p.id}`] : [];
      case 'schedule.setCoaches':
        return [`group:${p.groupId}`];
      case 'attendance.save':
      case 'attendance.mark':
        return p.groupId ? [`attendance:${p.groupId}:${month(p.date)}`] : [];
      case 'training.submit':
      case 'training.addDay':
      case 'training.clearMonth':
        return [`attendance:${p.groupId}:${p.month || month(p.date)}`];
      case 'training.moveDay':
      case 'training.removeDay': {
        const d = one('SELECT group_id, date FROM training_days WHERE id = :id', { id: Number(p.id) || 0 });
        return d ? [`attendance:${d.group_id}:${month(d.date)}`] : [];
      }
      case 'schedule.setDay':
      case 'schedule.resetDay':
        return [`schedule:week:${mondayOf(p.date)}`];
      case 'schedule.copyWeek':
        return [...new Set((p.dates || []).map((d) => `schedule:week:${mondayOf(d)}`))];
      case 'schedule.saveBase':
        return ['schedule:base'];
      case 'schedule.savePitches':
        return ['schedule:pitches'];
      case 'settings.update':
        return ['settings:club'];
      default:
        return [];
    }
  }
  // Saving a form opened at `version` when the record has changed since: refused, with who changed it.
  function checkVersion(table, id, version, studentId) {
    if (version == null || version === '') return;
    const cur = one(`SELECT version FROM ${table} WHERE id = :id`, { id });
    if (!cur || Number(cur.version) === Number(version)) return;
    const last = studentId
      ? one('SELECT user, at FROM activity_log WHERE student_id = :sid ORDER BY id DESC LIMIT 1', { sid: studentId })
      : null;
    throw new AppError('CONFLICT', { who: last?.user || '—', at: last?.at || '' });
  }

  const methods = {
    'settings.get': () => settings(),

    'settings.update': (p, ctx) => {
      const sharesBefore = feeShares();
      for (const key of SETTING_KEYS) {
        if (p[key] === undefined) continue;
        run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', {
          key,
          value: p[key] == null ? '' : String(p[key]),
        });
      }
      // Holiday months changed: unpaid monthly fees of those months take the new share (or the full fee again).
      const sharesAfter = feeShares();
      const changed = [...new Set([...Object.keys(sharesBefore), ...Object.keys(sharesAfter)])].filter((m) => sharesBefore[m] !== sharesAfter[m]);
      for (const period of changed) {
        if (sharesAfter[period] === 0) {
          run(`DELETE FROM charges WHERE kind = 'monthly' AND status = 'unpaid' AND period = :period AND excused_by IS NULL`, { period });
          continue;
        }
        run(
          `UPDATE charges SET amount = ${feeSql('(SELECT monthly_fee FROM students s WHERE s.id = charges.student_id)', 'charges.period', sharesAfter)}
           WHERE kind = 'monthly' AND status = 'unpaid' AND period = :period AND excused_by IS NULL
             AND (SELECT monthly_fee FROM students s WHERE s.id = charges.student_id) > 0
             AND NOT EXISTS (SELECT 1 FROM students s WHERE s.id = charges.student_id AND s.first_fee IS NOT NULL AND substr(s.join_date, 1, 7) = charges.period)`,
          { period }
        );
      }
      if (changed.length) ensureMonthlyCharges();
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
        // The same money by the month the fee is for (as in the groups Excel), whenever it was paid.
        feesPaid: (() => {
          const rows = Object.fromEntries(
            all(
              `SELECT period, SUM(amount) AS total FROM charges WHERE status = 'paid' AND kind = 'monthly' AND period >= :from GROUP BY period`,
              { from: months[0] }
            ).map((r) => [r.period, r.total])
          );
          return months.map((m) => ({ period: m, total: rows[m] || 0 }));
        })(),
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
        monthly_fee: Math.max(int(p.monthly_fee), 0),
        championship: p.championship ? 1 : 0,
      };
      if (p.id) {
        checkVersion('groups', p.id, p.version, null);
        run(
          `UPDATE groups SET name = :name, coach = :coach, coach_phone = :coach_phone, assistant = :assistant,
                  assistant_phone = :assistant_phone, color = :color, archived = :archived,
                  monthly_fee = :monthly_fee, championship = :championship WHERE id = :id`,
          row
        );
        log(ctx, 'group.updated', row.name);
        return { id: p.id };
      }
      const r = run(
        `INSERT INTO groups (name, coach, coach_phone, assistant, assistant_phone, color, archived, monthly_fee, championship)
         VALUES (:name, :coach, :coach_phone, :assistant, :assistant_phone, :color, :archived, :monthly_fee, :championship)`,
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
    // How many students there are: active, inactive, all (for «shown N of M»).
    // The next new student's contract number (the first free one from Settings → Club).
    'students.contractNo.get': () => ({ next: nextContractNo(false), prefix: settings().contract_prefix || '', from: settings().contract_next || '' }),

    'students.summary': () => one(
      `SELECT SUM(status = 'active') AS active, SUM(status != 'active') AS inactive, COUNT(*) AS total FROM students`
    ),

    'students.list': (p = {}) =>
      all(
        `SELECT s.id, s.first_name, s.last_name, s.birth_date, s.phone, s.parent_name, s.parent_phone,
                s.group_id, g.name AS group_name, g.color AS group_color, g.coach AS group_coach, s.monthly_fee, s.join_date, s.status, s.inactive_reason, s.medical_doc, s.patronymic, s.category, s.contract_no, s.service,
                s.parent_first_name, s.parent_last_name, s.parent_doc_no, s.parent_doc_issuer, s.parent_doc_date, s.parent_ssn, s.parent_address, s.parent_email, s.parent_messenger,
                s.document_no, (SELECT group_concat(n.text, char(10)) FROM (SELECT text FROM student_notes WHERE student_id = s.id ORDER BY id) n) AS notes, s.leave_date,
                IFNULL((SELECT SUM(amount) FROM charges c
                        WHERE c.student_id = s.id AND c.status = 'unpaid' AND c.due_date < :t), 0) AS overdue,
                IFNULL((SELECT SUM(amount) FROM charges c
                        WHERE c.student_id = s.id AND c.status = 'unpaid'), 0) AS unpaid,
                -- Monthly fee per month in the requested range (the season shown in the students list).
                (SELECT json_group_array(json_object('id', c.id, 'period', c.period, 'status', c.status,
                                                     'due_date', c.due_date, 'amount', c.amount, 'excused_by', c.excused_by,
                                                     'paid_at', c.paid_at))
                 FROM charges c WHERE c.student_id = s.id AND c.kind = 'monthly'
                   AND c.period BETWEEN :monthsFrom AND :monthsTo) AS months
         FROM students s LEFT JOIN groups g ON g.id = s.group_id
         WHERE (:status IS NULL OR s.status = :status)
           AND (:groupId IS NULL OR s.group_id = :groupId)
           AND (:search IS NULL OR ulower(s.first_name || ' ' || s.last_name || ' ' || IFNULL(s.patronymic, '') || ' ' || s.first_name || ' ' ||
                IFNULL(s.phone, '') || ' ' || IFNULL(s.parent_name, '') || ' ' || IFNULL(s.parent_phone, '') || ' ' ||
                IFNULL(s.contract_no, ''))
                LIKE '%' || ulower(:search) || '%')
         ORDER BY s.created_at DESC, s.id DESC`, // the newest students first
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
        `SELECT s.*, g.name AS group_name, g.color AS group_color, g.schedule AS group_schedule,
                g.coach AS group_coach, g.assistant AS group_assistant
         FROM students s LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = :id`,
        { id }
      );
      if (!student) throw new AppError('NOT_FOUND');
      return {
        student,
        notes: all('SELECT id, text, created_at, created_by, user_id FROM student_notes WHERE student_id = :id ORDER BY id DESC', { id }),
        // Linked students (brothers, sisters…): everyone connected through links.
        related: relatedOf(Number(id)),
        // The group's usual training week (for the customer receipt).
        training: student.group_id
          ? all('SELECT weekday, start, end, pitch FROM schedule_base WHERE group_id = :g ORDER BY ((weekday + 6) % 7), start', { g: student.group_id })
          : [],
        charges: all(
          `SELECT c.*, (SELECT a.file_id FROM absences a WHERE a.student_id = c.student_id AND a.date_from = c.absence_from AND a.date_to = c.absence_to AND a.file_id IS NOT NULL ORDER BY a.id DESC LIMIT 1) AS absence_file_id FROM charges c WHERE c.student_id = :id
           ORDER BY CASE c.status WHEN 'unpaid' THEN 0 ELSE 1 END, IFNULL(c.due_date, c.created_at) DESC, c.id DESC`,
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
          `SELECT f.id, f.kind, f.file_name, f.mime, f.size, f.created_at, f.created_by, ap.date_from, ap.date_to
           FROM student_files f LEFT JOIN absences ap ON ap.file_id = f.id
           WHERE f.student_id = :id ORDER BY f.id DESC`,
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
        service: normService(p.service),
        category: ['siblings', 'half', 'war', 'staff', 'orphan'].includes(p.category) ? p.category : null,
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
        parent_messenger: str(p.parent_messenger),
        parent_phone: str(p.parent_phone),
        group_id: p.group_id ? int(p.group_id) : null,
        monthly_fee: int(p.monthly_fee),
        join_date: str(p.join_date),
        status: p.status === 'inactive' ? 'inactive' : 'active',
        inactive_reason: p.status === 'inactive' ? str(p.inactive_reason) : null,
        notes: null,
        first_fee: blank(p.first_fee) ? null : Math.max(int(p.first_fee), 0),
        medical_doc: p.medical_doc === true || Number(p.medical_doc) === 1 ? 1 : 0,
        photo: p.photo || null,
      };

      if (p.id) {
        const prev = one('SELECT status, monthly_fee, leave_date, billing_from FROM students WHERE id = :id', { id: p.id });
        const before = one('SELECT * FROM students WHERE id = :id', { id: p.id });
        if (!prev) throw new AppError('NOT_FOUND');
        checkVersion('students', p.id, p.version, p.id);
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
             parent_messenger = :parent_messenger,
             monthly_fee = :monthly_fee, join_date = :join_date, status = :status, inactive_reason = :inactive_reason, leave_date = :leave_date,
             billing_from = :billing_from, photo = :photo, medical_doc = :medical_doc,
             updated_at = datetime('now', 'localtime')
           WHERE id = :id`,
          row
        );
        // A changed fee applies to this month's and future unpaid monthly charges.
        if (prev.monthly_fee !== row.monthly_fee) {
          const shares = feeShares();
          const ownFirst = before.first_fee != null ? String(before.join_date || '').slice(0, 7) : null;
          for (const c of all(`SELECT id, period FROM charges WHERE student_id = :id AND kind = 'monthly' AND status = 'unpaid' AND period >= :period AND excused_by IS NULL`, { id: p.id, period: currentPeriod() }))
            if (c.period !== ownFirst)
            run('UPDATE charges SET amount = :fee WHERE id = :id', { id: c.id, fee: studentFee(row.monthly_fee, c.period, row.join_date) });
        }
        const changes = diffStudent(before, one('SELECT * FROM students WHERE id = :id', { id: p.id }));
        if (changes.length) log(ctx, 'student.updated', `${row.first_name} ${row.last_name}`, p.id, { changes });
        addNote(p.id, p.notes, ctx);
        ensureMonthlyCharges(p.id);
        return { id: p.id };
      }

      // The number shown in the form was the next one then; the next free one is taken now.
      if (p.contract_auto) row.contract_no = nextContractNo(true) || row.contract_no;
      else noteContractNo(row.contract_no);
      const r = run(
        `INSERT INTO students (first_name, last_name, patronymic, category, contract_no, service, birth_date, gender, phone, email, address, document_no,
           parent_name, parent_phone, group_id, monthly_fee, join_date, status, inactive_reason, notes, photo, medical_doc,
           parent_first_name, parent_last_name, parent_doc_no, parent_doc_issuer, parent_doc_date, parent_ssn, parent_address, parent_email, parent_messenger, first_fee)
         VALUES (:first_name, :last_name, :patronymic, :category, :contract_no, :service, :birth_date, :gender, :phone, :email, :address, :document_no,
           :parent_name, :parent_phone, :group_id, :monthly_fee, :join_date, :status, :inactive_reason, :notes, :photo, :medical_doc,
           :parent_first_name, :parent_last_name, :parent_doc_no, :parent_doc_issuer, :parent_doc_date, :parent_ssn, :parent_address, :parent_email, :parent_messenger, :first_fee)`,
        row
      );
      log(ctx, 'student.created', `${row.first_name} ${row.last_name}`, Number(r.lastInsertRowid));
      addNote(Number(r.lastInsertRowid), p.notes, ctx);
      ensureMonthlyCharges(Number(r.lastInsertRowid));
      return { id: Number(r.lastInsertRowid), contract_no: row.contract_no };
    },

    // «Դադարեցում»: the student stops on `date` — becomes inactive with that leave date. Monthly fees
    // for the months after it that are still unpaid are removed (they are no longer owed); the month
    // they stop in stays as it is.
    'students.terminate': ({ id, date, reason }, ctx) => {
      const s = one('SELECT id, status FROM students WHERE id = :id', { id });
      if (!s) throw new AppError('NOT_FOUND');
      const d = str(date);
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new AppError('DATE_REQUIRED');
      run(
        `UPDATE students SET status = 'inactive', leave_date = :d, inactive_reason = IFNULL(:reason, inactive_reason),
           updated_at = datetime('now', 'localtime') WHERE id = :id`,
        { id, d, reason: str(reason) }
      );
      const removed = run(
        `DELETE FROM charges WHERE student_id = :id AND kind = 'monthly' AND status = 'unpaid' AND period > :month`,
        { id, month: d.slice(0, 7) }
      ).changes;
      log(ctx, 'student.terminated', `${studentName(id)} — ${d.split('-').reverse().join('/')}`, id, { date: d, reason: str(reason), removed });
      return { removed };
    },

    // Import from another program. rows: [{ ...student fields, group_name }] (already matched to fields).
    // A row matches an existing student by contract number, else by name + birth date.
    // mode 'skip' leaves existing students as they are; 'update' fills in the imported fields.
    'students.import': ({ rows, mode = 'skip', createGroups = true }, ctx) => {
      const result = { created: 0, updated: 0, skipped: 0, groupsCreated: 0, payments: 0, errors: [] };
      const quiet = { ...ctx, quiet: true }; // one Telegram line for the whole import, not one per student
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
          const payments = Array.isArray(p.payments) ? p.payments : [];
          const carried = Array.isArray(p.charges) ? p.charges : [];
          const monthFees = p.month_fees && typeof p.month_fees === 'object' ? p.month_fees : {};
          delete p.payments;
          delete p.charges;
          delete p.month_fees;
          // A month billed at a special price (e.g. the championship groups' August): its unpaid fee too.
          const specialFees = (sid) => {
            for (const [period, amount] of Object.entries(monthFees))
              if (/^\d{4}-\d{2}$/.test(period) && int(amount) > 0)
                run(`UPDATE charges SET amount = :amount WHERE student_id = :sid AND kind = 'monthly' AND period = :period AND status = 'unpaid' AND excused_by IS NULL`, {
                  sid, period, amount: int(amount),
                });
          };
          // The same contract № is the same student only with the same first name (brothers can share
          // one contract, and a typo can give two families one number).
          const existing =
            (p.contract_no &&
              one('SELECT * FROM students WHERE contract_no = :c AND ulower(first_name) = ulower(:f)', { c: str(p.contract_no), f: str(p.first_name) })) ||
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
            save({ ...existing, ...p, id: existing.id }, quiet);
            result.updated++;
            result.payments += addImportedPayments(existing.id, payments, carried, quiet);
            specialFees(existing.id);
            return;
          }
          const created = save({ join_date: today(), status: 'active', ...p }, quiet);
          result.created++;
          result.payments += addImportedPayments(created.id, payments, carried, quiet);
          specialFees(created.id);
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          result.errors.push({ row: i + 1, error: err.message });
        }
      });
      log(ctx, 'students.imported', `${result.created} / ${result.updated} / ${result.skipped}`);
      return result;
    },

    // ---------------------------------------------------------------- linked students (siblings…)
    // A link is stored once per pair; everyone connected through links counts as related.
    'students.link': ({ id, otherId, relation, setCategory }, ctx) => {
      const a = Number(id);
      const b = Number(otherId);
      if (!a || !b || a === b) throw new AppError('NOT_FOUND');
      if (!one('SELECT id FROM students WHERE id = :a', { a }) || !one('SELECT id FROM students WHERE id = :b', { b })) throw new AppError('NOT_FOUND');
      const [x, y] = a < b ? [a, b] : [b, a];
      run('INSERT OR IGNORE INTO student_links (a_id, b_id, relation, created_by) VALUES (:x, :y, :relation, :user)', { x, y, relation: str(relation), user: ctx.user || null });
      // «2 և ավել երեխա»: the added brother / sister gets the siblings category (unless they already have one).
      if (setCategory) run(`UPDATE students SET category = 'siblings' WHERE id = :b AND (category IS NULL OR category = '')`, { b });
      log(ctx, 'student.linked', `${studentName(a)} ↔ ${studentName(b)}`, a, { otherId: b, other: studentName(b), relation: str(relation) });
      log(ctx, 'student.linked', `${studentName(b)} ↔ ${studentName(a)}`, b, { otherId: a, other: studentName(a), relation: str(relation) });
      return true;
    },
    'students.unlink': ({ id, otherId }, ctx) => {
      const a = Number(id);
      const b = Number(otherId);
      run('DELETE FROM student_links WHERE (a_id = :a AND b_id = :b) OR (a_id = :b AND b_id = :a)', { a, b });
      log(ctx, 'student.unlinked', `${studentName(a)} ↔ ${studentName(b)}`, a, { otherId: b, other: studentName(b) });
      log(ctx, 'student.unlinked', `${studentName(b)} ↔ ${studentName(a)}`, b, { otherId: a, other: studentName(a) });
      return true;
    },

    // ---------------------------------------------------------------- a student's history («Գործողություններ»)
    // Everything recorded about the student, plus what the data itself shows (payments, documents,
    // applications, contracts and attendance from before the history was kept).
    'students.history': ({ id }) => {
      const logs = all('SELECT id, at, user, action, details, meta FROM activity_log WHERE student_id = :id ORDER BY id DESC', { id }).map((l) => ({
        ...l,
        meta: l.meta ? JSON.parse(l.meta) : null,
      }));
      const seen = (actions, key, value) => logs.some((l) => actions.includes(l.action) && l.meta?.[key] === value);
      const events = [...logs];
      const s = one('SELECT created_at FROM students WHERE id = :id', { id });
      if (s && !logs.some((l) => ['student.created', 'student.transferred'].includes(l.action)))
        events.push({ at: s.created_at, user: null, action: 'student.created', derived: true });
      for (const c of all('SELECT * FROM charges WHERE student_id = :id', { id })) {
        if (c.status === 'paid' && c.paid_at && !seen(['charge.paid', 'charge.created_paid'], 'chargeId', c.id))
          events.push({
            at: c.paid_at, user: c.paid_by, action: 'charge.paid', derived: true,
            meta: { chargeId: c.id, kind: c.kind, period: c.period, description: c.description, amount: c.amount, method: c.method, hdm: c.hdm_receipt },
          });
        if (c.status === 'waived' && c.excused_by)
          events.push({ at: c.created_at, user: null, action: 'charge.excused', derived: true, meta: { chargeId: c.id, kind: c.kind, period: c.period, amount: c.amount } });
      }
      for (const f of all('SELECT id, kind, file_name, created_at, created_by FROM student_files WHERE student_id = :id', { id }))
        if (!seen(['file.uploaded', 'application.created'], 'fileId', f.id))
          events.push({ at: f.created_at, user: f.created_by, action: 'file.uploaded', derived: true, meta: { fileId: f.id, name: f.file_name, kind: f.kind } });
      for (const a of all('SELECT * FROM absences WHERE student_id = :id', { id }))
        if (!seen(['application.created'], 'absenceId', a.id))
          events.push({ at: a.created_at, user: a.created_by, action: 'application.created', derived: true, meta: { absenceId: a.id, from: a.date_from, to: a.date_to, reason: a.reason } });
      for (const c of all('SELECT number, created_at, created_by, status FROM contracts WHERE student_id = :id', { id }))
        if (!seen(['contract.created'], 'number', c.number || null))
          events.push({ at: c.created_at, user: c.created_by, action: 'contract.created', derived: true, meta: { number: c.number, status: c.status } });
      for (const a of all('SELECT date, status, marked_by FROM attendance WHERE student_id = :id', { id }))
        events.push({ at: `${a.date} 00:00:00`, user: a.marked_by, action: 'attendance.mark', derived: true, meta: { date: a.date, status: a.status } });
      return events.sort((x, y) => String(y.at).localeCompare(String(x.at)) || (y.id || 0) - (x.id || 0));
    },

    // ---------------------------------------------------------------- notes («Նշումներ» on the student's page)
    // Not tied to the student's edit lock: a note can be added while someone else edits the student.
    'notes.add': ({ studentId, text }, ctx) => {
      if (!one('SELECT id FROM students WHERE id = :id', { id: Number(studentId) || 0 })) throw new AppError('NOT_FOUND');
      if (!str(text)) throw new AppError('TEXT_REQUIRED');
      return { id: addNote(Number(studentId), text, ctx, true) };
    },
    'notes.delete': ({ id }, ctx) => {
      const n = one('SELECT * FROM student_notes WHERE id = :id', { id: Number(id) || 0 });
      if (!n) throw new AppError('NOT_FOUND');
      // The author or an administrator (anyone, when sign-in is off).
      if (ctx.account && !ctx.account.is_admin && Number(n.user_id) !== Number(ctx.account.id)) throw new AppError('FORBIDDEN');
      run('DELETE FROM student_notes WHERE id = :id', { id: n.id });
      log(ctx, 'note.deleted', `${studentName(n.student_id)} — ${n.text.slice(0, 120)}`, n.student_id);
      return { ok: true };
    },

    // ---------------------------------------------------------------- full transfer to another FC Manager
    // Everything about the chosen students, for moving them to another PC: the student (incl. termination
    // date and photo), payments (incl. «Դիմում» periods, «Հարգելի» months and ՀԴՄ numbers), attendance,
    // absence applications, uploaded documents (as base64) and contracts, plus their groups' training days.
    'students.export': ({ studentIds }) => {
      const ids = (studentIds || []).map(Number).filter(Boolean);
      const cols = (table) => all(`PRAGMA table_info(${table})`).map((c) => c.name);
      const pick = (row, drop) => Object.fromEntries(Object.entries(row).filter(([k]) => !drop.includes(k)));
      const groups = new Map();
      const students = [];
      for (const id of ids) {
        const s = one(`SELECT s.*, g.name AS group_name FROM students s LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = :id`, { id });
        if (!s) continue;
        if (s.group_id && !groups.has(s.group_id)) groups.set(s.group_id, one('SELECT * FROM groups WHERE id = :id', { id: s.group_id }));
        students.push({
          student: pick(s, ['id', 'group_id']),
          group: s.group_name || null,
          charges: all('SELECT * FROM charges WHERE student_id = :id ORDER BY id', { id }).map((c) => pick(c, ['student_id', 'product_id'])),
          attendance: all('SELECT date, status, marked_by FROM attendance WHERE student_id = :id ORDER BY date', { id }),
          notes: all('SELECT text, created_at, created_by FROM student_notes WHERE student_id = :id ORDER BY id', { id }),
          absences: all('SELECT * FROM absences WHERE student_id = :id ORDER BY id', { id }).map((a) => pick(a, ['student_id'])),
          files: all('SELECT * FROM student_files WHERE student_id = :id ORDER BY id', { id }).map((f) => ({
            ...pick(f, ['student_id', 'data']),
            data: f.data ? Buffer.from(f.data).toString('base64') : null,
          })),
          contracts: all(
            `SELECT c.*, t.name AS template_name, d.name AS doc_template_name FROM contracts c
             LEFT JOIN contract_templates t ON t.id = c.template_id LEFT JOIN doc_templates d ON d.id = c.doc_template_id
             WHERE c.student_id = :id ORDER BY c.id`,
            { id }
          ).map((c) => pick(c, ['student_id', 'template_id', 'doc_template_id'])),
        });
      }
      return {
        format: 'fcmanager-transfer',
        version: 1,
        exportedAt: new Date().toISOString(),
        columns: { students: cols('students') },
        groups: [...groups.values()].map((g) => ({
          ...pick(g, ['id']),
          trainingDays: all('SELECT date FROM training_days WHERE group_id = :id ORDER BY date', { id: g.id }).map((d) => d.date),
          trainingMonths: all('SELECT month, submitted_at, submitted_by FROM training_months WHERE group_id = :id', { id: g.id }),
        })),
        students,
      };
    },

    // Brings in a file from «students.export». A student already here (same contract №, or name + birth
    // date) is skipped, or with mode 'update' updated and its other data added where missing.
    'students.importFull': ({ data, mode = 'skip' }, ctx) => {
      if (!data || data.format !== 'fcmanager-transfer') throw new AppError('IMPORT_READ_FAILED');
      const colsOf = (table) => new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name));
      const tcols = {
        students: colsOf('students'), charges: colsOf('charges'), absences: colsOf('absences'),
        student_files: colsOf('student_files'), contracts: colsOf('contracts'), groups: colsOf('groups'),
      };
      const insert = (table, row) => {
        const keys = Object.keys(row).filter((k) => tcols[table].has(k) && k !== 'id');
        const r = run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => ':' + k).join(', ')})`, row);
        return Number(r.lastInsertRowid);
      };
      const res = { created: 0, updated: 0, skipped: 0, groupsCreated: 0, payments: 0, attendance: 0, files: 0, contracts: 0, absences: 0 };

      // Groups by name (created with their coaches and colour when missing) and their training days.
      const groupIds = new Map(all('SELECT id, name FROM groups').map((g) => [g.name.trim().toLowerCase(), g.id]));
      for (const g of data.groups || []) {
        const key = String(g.name || '').trim().toLowerCase();
        if (!key) continue;
        if (!groupIds.has(key)) {
          const { trainingDays, trainingMonths, ...row } = g;
          groupIds.set(key, insert('groups', row));
          res.groupsCreated++;
        }
        const gid = groupIds.get(key);
        for (const d of g.trainingDays || []) run('INSERT OR IGNORE INTO training_days (group_id, date) VALUES (:gid, :d)', { gid, d });
        for (const m of g.trainingMonths || [])
          run('INSERT OR IGNORE INTO training_months (group_id, month, submitted_at, submitted_by) VALUES (:gid, :month, :submitted_at, :submitted_by)', { gid, ...m });
      }
      const templateId = (table, name) => (name ? one(`SELECT id FROM ${table} WHERE name = :name`, { name })?.id ?? null : null);

      for (const item of data.students || []) {
        const s = item.student || {};
        const gid = item.group ? groupIds.get(String(item.group).trim().toLowerCase()) ?? null : null;
        const existing =
          (str(s.contract_no) && one('SELECT id FROM students WHERE contract_no = :c', { c: str(s.contract_no) })) ||
          one(
            `SELECT id FROM students WHERE ulower(first_name) = ulower(:f) AND ulower(last_name) = ulower(:l) AND IFNULL(birth_date, '') = IFNULL(:b, '')`,
            { f: str(s.first_name), l: str(s.last_name), b: str(s.birth_date) }
          );
        let sid;
        if (existing) {
          if (mode !== 'update') {
            res.skipped++;
            continue;
          }
          sid = existing.id;
          const keys = Object.keys(s).filter((k) => tcols.students.has(k) && !['id', 'created_at'].includes(k));
          run(`UPDATE students SET ${keys.map((k) => `${k} = :${k}`).join(', ')}, group_id = :__gid WHERE id = :__id`, { ...s, __gid: gid, __id: sid });
          res.updated++;
          log({ ...ctx, quiet: true }, 'student.transferUpdated', `${s.first_name} ${s.last_name}`, sid, { file: str(data.fileName) });
        } else {
          sid = insert('students', { ...s, group_id: gid });
          res.created++;
          log({ ...ctx, quiet: true }, 'student.transferred', `${s.first_name} ${s.last_name}`, sid, { file: str(data.fileName), exportedAt: data.exportedAt });
        }

        // Notes (an older file has them in the student's «notes» field).
        for (const n of item.notes || (str(s.notes) ? [{ text: str(s.notes), created_at: s.created_at || null, created_by: null }] : []))
          if (str(n.text) && !one('SELECT id FROM student_notes WHERE student_id = :sid AND text = :text', { sid, text: str(n.text) }))
            run(`INSERT INTO student_notes (student_id, text, created_at, created_by) VALUES (:sid, :text, IFNULL(:at, datetime('now', 'localtime')), :by)`,
              { sid, text: str(n.text), at: n.created_at || null, by: n.created_by || null });
        run('UPDATE students SET notes = NULL WHERE id = :sid AND notes IS NOT NULL', { sid });

        // Uploaded documents (skipped when the same file is already there).
        const fileIds = new Map();
        for (const f of item.files || []) {
          const dup = one('SELECT id FROM student_files WHERE student_id = :sid AND file_name = :n AND IFNULL(size, 0) = IFNULL(:size, 0) AND kind = :kind', {
            sid, n: f.file_name, size: f.size, kind: f.kind,
          });
          if (dup) {
            fileIds.set(f.id, dup.id);
            continue;
          }
          fileIds.set(f.id, insert('student_files', { ...f, student_id: sid, data: f.data ? Buffer.from(f.data, 'base64') : null }));
          res.files++;
        }
        // Absence applications («Դիմում»), linked to their document.
        const absenceIds = new Map();
        for (const a of item.absences || []) {
          const dup = one('SELECT id FROM absences WHERE student_id = :sid AND date_from = :f AND date_to = :t', { sid, f: a.date_from, t: a.date_to });
          if (dup) {
            absenceIds.set(a.id, dup.id);
            continue;
          }
          absenceIds.set(a.id, insert('absences', { ...a, student_id: sid, file_id: a.file_id ? fileIds.get(a.file_id) ?? null : null, created_charges: '[]' }));
          res.absences++;
        }
        // Payments: a month already settled here stays as it is; others are added once.
        const chargeIds = new Map();
        for (const c of item.charges || []) {
          const row = { ...c, student_id: sid, excused_by: c.excused_by ? absenceIds.get(c.excused_by) ?? null : null };
          if (c.kind === 'monthly' && c.period) {
            const ex = one(`SELECT id, status FROM charges WHERE student_id = :sid AND kind = 'monthly' AND period = :p`, { sid, p: c.period });
            if (ex) {
              chargeIds.set(c.id, ex.id);
              if (ex.status === 'unpaid' && c.status !== 'unpaid') {
                const keys = Object.keys(row).filter((k) => tcols.charges.has(k) && !['id', 'student_id', 'created_at'].includes(k));
                run(`UPDATE charges SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :__id`, { ...row, __id: ex.id });
                res.payments++;
              }
              continue;
            }
          } else {
            const dup = one(
              `SELECT id FROM charges WHERE student_id = :sid AND kind = :kind AND IFNULL(description, '') = IFNULL(:d, '') AND amount = :amount AND IFNULL(due_date, '') = IFNULL(:due, '')`,
              { sid, kind: c.kind, d: c.description, amount: c.amount, due: c.due_date }
            );
            if (dup) {
              chargeIds.set(c.id, dup.id);
              continue;
            }
          }
          chargeIds.set(c.id, insert('charges', row));
          res.payments++;
        }
        // The applications remember the fees they added (so cancelling one removes them).
        for (const a of item.absences || []) {
          const nid = absenceIds.get(a.id);
          const created = JSON.parse(a.created_charges || '[]').map((id) => chargeIds.get(id)).filter(Boolean);
          if (nid && created.length) run('UPDATE absences SET created_charges = :c WHERE id = :id', { id: nid, c: JSON.stringify(created) });
        }
        // Attendance.
        for (const a of item.attendance || []) {
          const r = run('INSERT OR IGNORE INTO attendance (student_id, date, status, group_id, marked_by) VALUES (:sid, :date, :status, :gid, :marked_by)', {
            sid, gid, ...a,
          });
          res.attendance += r.changes;
        }
        // Contracts (by number), with the template of the same name when this PC has it.
        for (const c of item.contracts || []) {
          if (c.number && one('SELECT id FROM contracts WHERE student_id = :sid AND number = :n', { sid, n: c.number })) continue;
          const { template_name, doc_template_name, ...row } = c;
          insert('contracts', {
            ...row,
            student_id: sid,
            template_id: templateId('contract_templates', template_name),
            doc_template_id: templateId('doc_templates', doc_template_name),
          });
          res.contracts++;
        }
      }
      log(ctx, 'students.imported', `${res.created} / ${res.updated} / ${res.skipped}`);
      return res;
    },

    // ---------------------------------------------------------------- student documents
    'files.list': ({ studentId }) =>
      all(
        `SELECT f.id, f.kind, f.file_name, f.mime, f.size, f.created_at, f.created_by, ap.date_from, ap.date_to
         FROM student_files f LEFT JOIN absences ap ON ap.file_id = f.id
         WHERE f.student_id = :studentId ORDER BY f.id DESC`,
        { studentId }
      ),

    'files.get': ({ id }) => {
      const f = one('SELECT file_name, mime, data FROM student_files WHERE id = :id', { id });
      if (!f) throw new AppError('NOT_FOUND');
      return { fileName: f.file_name, mime: f.mime, data: Buffer.from(f.data).toString('base64') };
    },

    'files.upload': ({ studentId, kind, name, type, data, skipSame }, ctx) => {
      if (!one('SELECT id FROM students WHERE id = :id', { id: studentId })) throw new AppError('NOT_FOUND');
      // Uploading many files at once (signed contracts): the same file name twice for a student is skipped.
      if (skipSame) {
        const same = one('SELECT id FROM student_files WHERE student_id = :studentId AND file_name = :name', { studentId, name: str(name) });
        if (same) return { id: same.id, skipped: true };
      }
      const buf = Buffer.from(String(data || ''), 'base64');
      if (!buf.length) throw new AppError('FILE_EMPTY');
      if (buf.length > 15 * 1024 * 1024) throw new AppError('FILE_TOO_BIG');
      const k = ['medical', 'contract'].includes(kind) ? kind : 'other';
      const r = run(
        `INSERT INTO student_files (student_id, kind, file_name, mime, size, data, created_by)
         VALUES (:studentId, :kind, :name, :type, :size, :data, :user)`,
        { studentId, kind: k, name: str(name) || 'document', type: str(type), size: buf.length, data: buf, user: ctx.user || null }
      );
      // An uploaded medical certificate means it has been provided.
      if (k === 'medical') run('UPDATE students SET medical_doc = 1 WHERE id = :id', { id: studentId });
      log(ctx, 'file.uploaded', `${studentName(studentId)} — ${str(name)}`, studentId, { fileId: Number(r.lastInsertRowid), name: str(name), kind: k });
      return { id: Number(r.lastInsertRowid) };
    },

    'files.delete': ({ id }, ctx) => {
      const f = one('SELECT student_id, file_name, kind FROM student_files WHERE id = :id', { id });
      if (!f) throw new AppError('NOT_FOUND');
      if (f.kind === 'absence') for (const a of all('SELECT id FROM absences WHERE file_id = :id', { id })) removeAbsence(a.id);
      run('DELETE FROM student_files WHERE id = :id', { id });
      log(ctx, 'file.deleted', `${studentName(f.student_id)} — ${f.file_name}`, f.student_id, { name: f.file_name, kind: f.kind });
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

    // A WhatsApp / Viber message opened for a parent (sent by a person from their own app): kept in history.
    'notify.messenger': ({ studentId, channel, kind }, ctx) => {
      if (!one('SELECT id FROM students WHERE id = :id', { id: studentId })) throw new AppError('NOT_FOUND');
      const ch = channel === 'viber' ? 'Viber' : 'WhatsApp';
      const k = ['reminder', 'receipt', 'free'].includes(kind) ? kind : 'free';
      log(ctx, 'message.messenger', `${studentName(studentId)} — ${ch}`, studentId, { channel: ch, kind: k });
      return true;
    },
    'notify.retry': ({ id }) => {
      run(`UPDATE outbox SET status = 'pending', attempts = 0, error = NULL WHERE id = :id AND status = 'failed'`, { id });
      return true;
    },

    // Absence application (Բացակայության դիմում): fills the club's form and keeps it under the student's documents.
    'applications.create': (p, ctx) => {
      const a = createApplication(ctx, p);
      return { id: a.fileId, fileName: a.name, data: a.buf.toString('base64') };
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
        days: all(`SELECT group_id, date, start, end, pitch, note, cancelled, coach, assistant FROM schedule_days WHERE date IN (${inDates(list)})`),
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
    'schedule.setDay': ({ groupId, date, start, end, pitch, note, cancelled, coach, assistant }, ctx) => {
      if (!groupId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new AppError('DATE_REQUIRED');
      if (!cancelled && (blank(start) || blank(end) || str(end) <= str(start))) throw new AppError('TIME_INVALID');
      run(
        `INSERT INTO schedule_days (group_id, date, start, end, pitch, note, cancelled, coach, assistant, updated_by)
         VALUES (:groupId, :date, :start, :end, :pitch, :note, :cancelled, :coach, :assistant, :user)
         ON CONFLICT(group_id, date) DO UPDATE SET start = excluded.start, end = excluded.end, pitch = excluded.pitch,
           note = excluded.note, cancelled = excluded.cancelled, coach = excluded.coach, assistant = excluded.assistant,
           updated_by = excluded.updated_by`,
        {
          groupId, date, start: str(start), end: str(end), pitch: str(pitch), note: str(note), cancelled: cancelled ? 1 : 0,
          coach: cancelled ? null : str(coach), assistant: cancelled ? null : str(assistant), user: ctx.user || null,
        }
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
            `INSERT INTO schedule_days (group_id, date, start, end, pitch, note, cancelled, coach, assistant, updated_by)
             VALUES (:group_id, :date, :start, :end, :pitch, :note, :cancelled, :coach, :assistant, :user)`,
            { ...d, date, user: ctx.user || null }
          );
          n++;
        }
      }
      log(ctx, 'schedule.copied', `${dates.join(', ')} — ${n}`);
      return { copied: n };
    },

    // The group's own coach and assistant (and phones), changed from the timetable.
    'schedule.setCoaches': ({ groupId, coach, coach_phone, assistant, assistant_phone }, ctx) => {
      const g = one('SELECT name FROM groups WHERE id = :groupId', { groupId });
      if (!g) throw new AppError('NOT_FOUND');
      run(
        `UPDATE groups SET coach = :coach, coach_phone = :coachPhone, assistant = :assistant, assistant_phone = :assistantPhone WHERE id = :groupId`,
        { groupId, coach: str(coach), coachPhone: str(coach_phone), assistant: str(assistant), assistantPhone: str(assistant_phone) }
      );
      log(ctx, 'group.coaches', g.name);
      return true;
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
        `SELECT c.*, s.first_name, s.last_name, s.group_id, s.category, s.join_date, s.monthly_fee AS student_fee, g.name AS group_name, pr.name AS product_name,
                (SELECT a.file_id FROM absences a WHERE a.student_id = c.student_id AND a.date_from = c.absence_from AND a.date_to = c.absence_to AND a.file_id IS NOT NULL ORDER BY a.id DESC LIMIT 1) AS absence_file_id
         FROM charges c
         JOIN students s ON s.id = c.student_id
         LEFT JOIN groups g ON g.id = s.group_id
         LEFT JOIN products pr ON pr.id = c.product_id
         WHERE ${p.studentId ? 'c.student_id = :studentId AND' : ''} (:status IS NULL OR c.status = :status)
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
          dueDate:
            str(p.dueDate) ||
            (kind === 'monthly' ? `${p.period}-${pad(int(settings().due_day, 10))}` : /^\d{4}-\d{2}$/.test(p.forPeriod || '') ? `${p.forPeriod}-${pad(int(settings().due_day, 10))}` : today()),
          status: paid ? 'paid' : 'unpaid',
          paidAt: paid ? str(p.paidAt) || today() : null,
          method: paid ? str(p.method) || DEFAULT_METHOD : null,
          note: str(p.note),
          user: ctx.user || null,
          paidBy: paid ? ctx.user || null : null,
        }
      );
      const newId = Number(r.lastInsertRowid);
      log(ctx, paid ? 'charge.created_paid' : 'charge.created', `${studentName(p.studentId)} — ${description || kind} — ${amount}`, p.studentId, chargeMeta(newId));
      if (paid) notifyPaid(p.studentId, [one('SELECT * FROM charges WHERE id = :id', { id: newId })], str(p.method) || DEFAULT_METHOD, ctx);
      return { id: newId };
    },

    'charges.update': (p, ctx) => {
      const c = one('SELECT * FROM charges WHERE id = :id', { id: p.id });
      if (!c) throw new AppError('NOT_FOUND');
      checkVersion('charges', p.id, p.version, c.student_id);
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
      if (p.absenceFrom !== undefined) {
        const absence = absenceRange(p.absenceFrom, p.absenceTo);
        if (absence.from !== (c.absence_from || null) || absence.to !== (c.absence_to || null)) {
          // The old dates: their application goes (its document too); a payment without one just loses the dates.
          const old = c.excused_by ? one('SELECT * FROM absences WHERE id = :id', { id: c.excused_by }) : applicationFor(c.student_id, c.absence_from, c.absence_to);
          if (old) dropApplication(old, ctx);
          run('UPDATE charges SET absence_from = NULL, absence_to = NULL WHERE id = :id', { id: p.id });
          if (absence.from) {
            createApplication(ctx, { studentId: c.student_id, from: absence.from, to: absence.to });
            // A paid month keeps its amount; it shows the dates of its application.
            run('UPDATE charges SET absence_from = :from, absence_to = :to WHERE id = :id AND absence_from IS NULL', { id: p.id, ...absence });
          }
        }
      }
      log(ctx, 'charge.updated', `${studentName(c.student_id)} — ${amount}`, c.student_id, { ...chargeMeta(p.id), before: { amount: c.amount, method: c.method, paidAt: c.paid_at, period: c.period } });
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
        log(ctx, 'charge.paid', `${studentName(c.student_id)} — ${amount}`, c.student_id, chargeMeta(id));
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
      log(ctx, 'charge.unpaid', `${studentName(c.student_id)} — ${c.amount}`, c.student_id, chargeMeta(id));
      return true;
    },

    'charges.waive': ({ id }, ctx) => {
      const c = one('SELECT student_id, amount FROM charges WHERE id = :id', { id });
      if (!c) throw new AppError('NOT_FOUND');
      run(`UPDATE charges SET status = 'waived', paid_at = NULL, method = NULL WHERE id = :id`, { id });
      log(ctx, 'charge.waived', `${studentName(c.student_id)} — ${c.amount}`, c.student_id, chargeMeta(id));
      return true;
    },

    // Deletes a payment / charge. A deleted monthly fee comes back as unpaid on its own if the student
    // has a monthly fee and the month is within their billing (the month is still owed).
    'charges.delete': ({ id }, ctx) => {
      const c = one('SELECT student_id, kind, amount FROM charges WHERE id = :id', { id });
      if (!c) throw new AppError('NOT_FOUND');
      const meta = chargeMeta(id);
      run('DELETE FROM charges WHERE id = :id', { id });
      log(ctx, 'charge.deleted', `${studentName(c.student_id)} — ${c.amount}`, c.student_id, meta);
      return true;
    },

    // Records the monthly fee as paid for the chosen months (YYYY-MM): settles the month's charge if it
    // exists (with the amount received), or creates it already paid. Months already paid are skipped.
    'charges.payMonths': ({ studentId, periods, amount, method, paidAt, note, absenceFrom, absenceTo }, ctx) => {
      const st = one('SELECT monthly_fee, join_date FROM students WHERE id = :id', { id: studentId });
      if (!st) throw new AppError('NOT_FOUND');
      const fee = blank(amount) ? st.monthly_fee : int(amount);
      if (!(fee > 0)) throw new AppError('AMOUNT_REQUIRED');
      const dueDay = pad(int(settings().due_day, 15));
      const absence = absenceRange(absenceFrom, absenceTo);
      const paid = {
        paidAt: str(paidAt) || today(), method: str(method) || DEFAULT_METHOD, user: ctx.user || null, note: str(note), amount: fee,
        absFrom: absence.from, absTo: absence.to,
      };
      const shares = feeShares();
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
        paid.amount = joinsLate(st.join_date) && st.join_date.slice(0, 7) === period ? studentFee(fee, period, st.join_date) : feeFor(fee, period, shares); // holidays / joining after the 15th
        // A month already billed costs what it is billed at (a month halved by an application, or a special
        // price such as the championship groups' August 2026 at 27 000) — unless another fee was typed in.
        const billed = existing?.status === 'unpaid' ? one('SELECT amount, excused_by FROM charges WHERE id = :id', { id: existing.id }) : null;
        if (billed && (billed.excused_by || fee === Number(st.monthly_fee))) paid.amount = billed.amount;
        if (existing) {
          run(
            `UPDATE charges SET status = 'paid', amount = :amount, paid_at = :paidAt, method = :method, paid_by = :user,
                    note = IFNULL(:note, note), absence_from = IFNULL(:absFrom, absence_from), absence_to = IFNULL(:absTo, absence_to)
             WHERE id = :id`,
            { id: existing.id, ...paid }
          );
          done.push(existing.id);
        } else {
          const r = run(
            `INSERT INTO charges (student_id, kind, period, amount, due_date, status, paid_at, method, note, absence_from, absence_to, created_by, paid_by)
             VALUES (:studentId, 'monthly', :period, :amount, :dueDate, 'paid', :paidAt, :method, :note, :absFrom, :absTo, :user, :user)`,
            { studentId, period, dueDate: `${period}-${dueDay}`, ...paid }
          );
          done.push(Number(r.lastInsertRowid));
        }
        total += paid.amount;
        donePeriods.push(period);
      }
      for (const id of done) log(ctx, 'charge.paid', `${studentName(studentId)} — ${total}`, studentId, chargeMeta(id));
      if (done.length) notifyPaid(studentId, done.map((id) => one('SELECT * FROM charges WHERE id = :id', { id })), paid.method, ctx);
      if (done.length && absence.from && !applicationFor(studentId, absence.from, absence.to)) createApplication(ctx, { studentId, from: absence.from, to: absence.to });
      return { total, ids: done, periods: donePeriods };
    },

    // Saves the ՀԴՄ receipt number printed for these payments.
    'charges.setReceipt': ({ ids, receipt, crn, fiscal }, ctx) => {
      for (const id of ids || []) {
        run(
          `UPDATE charges SET hdm_receipt = :receipt, hdm_crn = :crn, hdm_fiscal = :fiscal, hdm_at = datetime('now', 'localtime') WHERE id = :id`,
          { id, receipt: str(receipt), crn: str(crn), fiscal: str(fiscal) }
        );
      }
      log(ctx, 'charge.receipt', `${receipt} — ${(ids || []).length}`);
      for (const id of ids || []) {
        const m = chargeMeta(id);
        const sid = one('SELECT student_id FROM charges WHERE id = :id', { id })?.student_id;
        if (sid) log(ctx, 'charge.hdm', `№ ${receipt}`, sid, { ...m, receipt: str(receipt), fiscal: str(fiscal) });
      }
      return true;
    },

    // After a ՀԴՄ return receipt: every payment of that receipt is unpaid again (the money went back).
    'charges.receiptReturned': ({ receipt, crn, returnNo }, ctx) => {
      const rows = all(`SELECT id, student_id FROM charges WHERE hdm_receipt = :receipt AND IFNULL(hdm_crn, '') = IFNULL(:crn, '')`, {
        receipt: str(receipt),
        crn: str(crn),
      });
      for (const r of rows) {
        log(ctx, 'charge.hdmReturned', `№ ${receipt}`, r.student_id, { ...chargeMeta(r.id), receipt: str(receipt), returnNo: str(returnNo) });
        run(
          `UPDATE charges SET status = 'unpaid', paid_at = NULL, method = NULL, paid_by = NULL,
             note = TRIM(IFNULL(note, '') || ' ' || :mark), hdm_receipt = NULL, hdm_crn = NULL, hdm_fiscal = NULL, hdm_at = NULL
           WHERE id = :id`,
          { id: r.id, mark: `[ՀԴՄ վերադարձ ${str(returnNo) || ''} ← № ${str(receipt)}]` }
        );
      }
      log(ctx, 'charge.receiptReturned', `№ ${receipt} — ${rows.length}`);
      return { count: rows.length };
    },

    // ---------------------------------------------------------------- attendance
    'attendance.save': ({ date, groupId, entries }, ctx) => {
      if (!date) throw new AppError('DATE_REQUIRED');
      let marked = 0;
      for (const e of entries || []) {
        const was = one('SELECT status FROM attendance WHERE student_id = :studentId AND date = :date', { studentId: e.studentId, date })?.status || null;
        if ((was || null) !== (e.status || null) && was)
          log(ctx, 'attendance.changed', formatDate(date), e.studentId, { date, from: was, to: e.status || null });
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
      log(ctx, 'contract.created', `${s.contract_no || ''} — ${studentName(s.id)}`, s.id, { number: s.contract_no || null });
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
      log(ctx, 'contract.updated', `${c.number || ''} — ${studentName(c.student_id)}`, c.student_id, { number: c.number || null });
      return true;
    },

    'contracts.delete': ({ id }, ctx) => {
      const c = one('SELECT number, student_id FROM contracts WHERE id = :id', { id });
      run('DELETE FROM contracts WHERE id = :id', { id });
      if (c) log(ctx, 'contract.deleted', `${c.number || ''} — ${studentName(c.student_id)}`, c.student_id, { number: c.number || null });
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

    // ---------------------------------------------------------------- reports («Հաշվետվություններ»)
    // The rows of one report; the app turns them into an Excel sheet. kind: debts · feesByGroup · discounts ·
    // attendance · joinsLeaves · hdmReceipts · groupsSummary · missingDocs. period = 'YYYY-MM'; from / to = dates.
    'reports.sheet': ({ kind, period, from, to, groupId } = {}) => {
      const t = today();
      const month = /^\d{4}-\d{2}$/.test(period || '') ? period : currentPeriod();
      const f = str(from) || '0000-00-00';
      const tt = str(to) || '9999-12-31';
      const gid = Number(groupId) || null;
      const student = `s.first_name || ' ' || s.last_name || IFNULL(' ' || s.patronymic, '')`;
      const byGroup = `ORDER BY g.name IS NULL, g.name COLLATE NOCASE, s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE`;
      const groupFilter = gid ? 'AND s.group_id = :gid' : '';
      switch (kind) {
        case 'debts':
          return all(
            `SELECT ${student} AS student, g.name AS group_name, s.contract_no, s.parent_name, s.parent_phone,
                    GROUP_CONCAT(IFNULL(c.period, substr(c.due_date, 1, 7)), ',') AS periods, COUNT(c.id) AS months,
                    MIN(c.due_date) AS oldest, SUM(c.amount) AS debt
             FROM students s JOIN charges c ON c.student_id = s.id LEFT JOIN groups g ON g.id = s.group_id
             WHERE c.status = 'unpaid' AND c.due_date < :t ${groupFilter}
             GROUP BY s.id ${byGroup}`,
            { t, gid }
          );
        case 'feesByGroup':
          return all(
            `SELECT IFNULL(g.name, '—') AS group_name, g.coach,
                    COUNT(DISTINCT s.id) AS students,
                    SUM(c.amount) AS expected,
                    SUM(CASE WHEN c.status = 'paid' THEN c.amount ELSE 0 END) AS paid,
                    SUM(CASE WHEN c.status = 'unpaid' THEN c.amount ELSE 0 END) AS unpaid,
                    SUM(c.status = 'paid') AS paid_count, COUNT(c.id) AS charge_count
             FROM charges c JOIN students s ON s.id = c.student_id LEFT JOIN groups g ON g.id = s.group_id
             WHERE c.kind = 'monthly' AND c.period = :month AND c.status != 'waived' ${groupFilter}
             GROUP BY g.id ORDER BY g.name IS NULL, g.name COLLATE NOCASE`,
            { month, gid }
          );
        case 'discounts':
          return all(
            `SELECT ${student} AS student, g.name AS group_name, s.category, s.monthly_fee, s.status, (SELECT group_concat(n.text, char(10)) FROM (SELECT text FROM student_notes WHERE student_id = s.id ORDER BY id) n) AS notes,
                    (SELECT IFNULL(SUM(amount), 0) FROM charges c WHERE c.student_id = s.id AND c.status = 'paid') AS paid_total
             FROM students s LEFT JOIN groups g ON g.id = s.group_id
             WHERE (s.category IS NOT NULL OR s.monthly_fee = 0) ${groupFilter} ${byGroup}`,
            { gid }
          );
        case 'attendance':
          return all(
            `SELECT ${student} AS student, g.name AS group_name,
                    (SELECT COUNT(*) FROM training_days td WHERE td.group_id = s.group_id AND substr(td.date, 1, 7) = :month) AS days,
                    SUM(a.status IN ('present', 'late')) AS present, SUM(a.status = 'absent') AS absent, SUM(a.status = 'excused') AS excused
             FROM students s LEFT JOIN groups g ON g.id = s.group_id
             LEFT JOIN attendance a ON a.student_id = s.id AND substr(a.date, 1, 7) = :month
             WHERE s.status = 'active' AND s.join_date <= :monthEnd ${groupFilter}
             GROUP BY s.id ${byGroup}`,
            { month, monthEnd: `${month}-31`, gid }
          );
        case 'joinsLeaves':
          return all(
            `SELECT * FROM (
               SELECT 'joined' AS change, s.join_date AS date, ${student} AS student, g.name AS group_name, s.monthly_fee, s.contract_no, s.parent_phone, NULL AS reason,
                      g.name AS gname, s.last_name AS lname
               FROM students s LEFT JOIN groups g ON g.id = s.group_id WHERE s.join_date BETWEEN :f AND :tt ${groupFilter}
               UNION ALL
               SELECT 'left', s.leave_date, ${student}, g.name, s.monthly_fee, s.contract_no, s.parent_phone, s.inactive_reason, g.name, s.last_name
               FROM students s LEFT JOIN groups g ON g.id = s.group_id WHERE s.status = 'inactive' AND s.leave_date BETWEEN :f AND :tt ${groupFilter}
             ) ORDER BY date, gname COLLATE NOCASE, lname COLLATE NOCASE`,
            { f, tt, gid }
          );
        case 'hdmReceipts':
          return all(
            `SELECT c.paid_at, ${student} AS student, g.name AS group_name, c.kind, c.period, c.description, c.amount, c.method,
                    c.hdm_receipt, c.hdm_fiscal, c.hdm_crn
             FROM charges c JOIN students s ON s.id = c.student_id LEFT JOIN groups g ON g.id = s.group_id
             WHERE c.status = 'paid' AND c.paid_at BETWEEN :f AND :tt ${groupFilter}
             ORDER BY c.paid_at, s.last_name COLLATE NOCASE`,
            { f, tt, gid }
          );
        case 'groupsSummary':
          return all(
            `SELECT g.name AS group_name, g.coach, g.assistant,
                    (SELECT COUNT(*) FROM students s WHERE s.group_id = g.id AND s.status = 'active') AS students,
                    (SELECT COUNT(*) FROM students s WHERE s.group_id = g.id AND substr(s.join_date, 1, 7) = :month) AS joined,
                    (SELECT COUNT(*) FROM students s WHERE s.group_id = g.id AND s.status = 'inactive' AND substr(s.leave_date, 1, 7) = :month) AS left_count,
                    (SELECT COUNT(*) FROM training_days td WHERE td.group_id = g.id AND substr(td.date, 1, 7) = :month) AS days,
                    (SELECT COUNT(*) FROM attendance a JOIN students s ON s.id = a.student_id
                      WHERE s.group_id = g.id AND substr(a.date, 1, 7) = :month AND a.status IN ('present', 'late')) AS present_marks,
                    (SELECT COUNT(*) FROM attendance a JOIN students s ON s.id = a.student_id
                      WHERE s.group_id = g.id AND substr(a.date, 1, 7) = :month) AS all_marks,
                    (SELECT IFNULL(SUM(c.amount), 0) FROM charges c JOIN students s ON s.id = c.student_id
                      WHERE s.group_id = g.id AND c.kind = 'monthly' AND c.period = :month AND c.status = 'paid') AS paid,
                    (SELECT IFNULL(SUM(c.amount), 0) FROM charges c JOIN students s ON s.id = c.student_id
                      WHERE s.group_id = g.id AND c.status = 'unpaid' AND c.due_date < :t) AS debt
             FROM groups g WHERE g.archived = 0 ${gid ? 'AND g.id = :gid' : ''} ORDER BY g.name COLLATE NOCASE`,
            { month, t, gid }
          );
        case 'missingDocs':
          return all(
            `SELECT ${student} AS student, g.name AS group_name, s.parent_name, s.parent_phone,
                    s.medical_doc, s.contract_no, s.document_no, s.birth_date, s.parent_doc_no, s.parent_ssn
             FROM students s LEFT JOIN groups g ON g.id = s.group_id
             WHERE s.status = 'active' ${groupFilter}
               AND (s.medical_doc = 0 OR IFNULL(s.contract_no, '') = '' OR IFNULL(s.document_no, '') = '' OR IFNULL(s.birth_date, '') = ''
                    OR IFNULL(s.parent_doc_no, '') = '' OR IFNULL(s.parent_ssn, '') = '' OR IFNULL(s.parent_phone, '') = '')
             ${byGroup}`,
            { gid }
          );
        default:
          throw new AppError('NOT_FOUND');
      }
    },

    // ---------------------------------------------------------------- activity
    // The activity log (kept for good): searched and filtered, newest first, a page at a time.
    // q: words in the details, the user, the student's name or what changed; actions: action keys whose
    // names (in the screen's language) contain q; section: a part of the app; user; from / to: dates.
    'activity.list': ({ q, actions, section, user, from, to, limit, offset } = {}) => {
      const SECTIONS = {
        students: ['student.%', 'students.%', 'application.%'],
        payments: ['charge.%', 'message.%', 'notify.%', 'product.%'],
        attendance: ['attendance.%', 'training.%'],
        groups: ['group.%', 'schedule.%'],
        contracts: ['contract.%', 'template.%', 'file.%'],
        notes: ['note.%'],
        users: ['auth.%', 'user.%'],
        system: ['settings.%', 'data.%', 'demo.%'],
      };
      const where = [];
      const p = {};
      if (SECTIONS[section]) where.push(`(${SECTIONS[section].map((pat, i) => ((p[`s${i}`] = pat), `a.action LIKE :s${i}`)).join(' OR ')})`);
      if (str(user)) {
        where.push('a.user = :user');
        p.user = str(user);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(from || '')) {
        where.push('a.at >= :from');
        p.from = from;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
        where.push("a.at < date(:to, '+1 day')");
        p.to = to;
      }
      const words = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
      const keys = (Array.isArray(actions) ? actions : []).filter((k) => /^[a-zA-Z_.]+$/.test(k)).slice(0, 200);
      const keyList = keys.map((k, i) => ((p[`k${i}`] = k), `:k${i}`)).join(', ');
      // Every word must be found somewhere (or the whole text names the action).
      if (words.length) {
        const hay = `ulower(IFNULL(a.details, '') || ' ' || IFNULL(a.user, '') || ' ' || IFNULL(s.first_name, '') || ' ' || IFNULL(s.last_name, '') || ' ' || IFNULL(s.patronymic, '') || ' ' || IFNULL(a.meta, ''))`;
        const conds = words.map((w, i) => ((p[`w${i}`] = `%${w}%`), `${hay} LIKE ulower(:w${i})`)).join(' AND ');
        where.push(keys.length ? `((${conds}) OR a.action IN (${keyList}))` : `(${conds})`);
      }
      const from_ = `FROM activity_log a LEFT JOIN students s ON s.id = a.student_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
      const rows = all(
        `SELECT a.id, a.at, a.user, a.action, a.details, a.student_id, a.meta,
                CASE WHEN s.id IS NOT NULL THEN s.first_name || ' ' || s.last_name END AS student_name
         ${from_} ORDER BY a.id DESC LIMIT :limit OFFSET :offset`,
        { ...p, limit: Math.min(Math.max(int(limit, 100), 1), 20000), offset: Math.max(int(offset, 0), 0) }
      ).map((r) => ({ ...r, meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return null; } })() : null }));
      return {
        rows,
        total: one(`SELECT COUNT(*) AS n ${from_}`, p).n,
        users: int(offset, 0) ? undefined : all('SELECT DISTINCT user FROM activity_log WHERE user IS NOT NULL ORDER BY user').map((r) => r.user),
      };
    },
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

  const READ_ONLY = /\.(get|list|summary|sheet|month|preview|document|status|export|history)$/;
  const auth = createAuth({ all, one, run, AppError, log });
  Object.assign(methods, auth.methods);

  // Single entry point used by both the local IPC bridge and the LAN server.
  // ctx: { user (name from the calling PC), token (sign-in session) }
  // Writes after which no student can be missing a monthly fee (so the next read needn't check everyone
  // again): those that never touch fees, and those that bring the one student's fees up to date themselves.
  const NO_FEE_EFFECT =
    /^((attendance|training|schedule|files|notify|auth|users|activity|contracts|products)\.|students\.(save|link|unlink)$|charges\.(payMonths|markPaid|setReceipt|receiptReturned)$)/;
  let feesChecked = null; // { period, at } of the last full check
  const feesDue = () => !feesChecked || feesChecked.period !== currentPeriod() || Date.now() - feesChecked.at > 10 * 60 * 1000;

  function call(method, params, ctx = {}) {
    const fn = methods[method];
    if (!fn && !method.startsWith('locks.')) return { ok: false, error: 'UNKNOWN_METHOD' };
    const write = !READ_ONLY.test(method);
    try {
      const pc = ctx.pc || ctx.user || null;
      const gate = auth.check(method, write, ctx);
      if (gate.error) return { ok: false, error: gate.error };
      ctx = gate.ctx;
      // Edit locks: kept in memory only (no transaction, other computers don't need a data refresh).
      if (method.startsWith('locks.')) {
        const owner = ctx.owner || pc || 'local';
        const p = params || {};
        const who = { owner, user: ctx.account ? ctx.account.full_name || ctx.account.username : ctx.user || pc, pc };
        if (method === 'locks.acquire') {
          // Taking a lock over from someone else: admins only (everyone, when sign-in is off).
          const admin = ctx.account ? !!ctx.account.is_admin : true;
          if (p.force && !admin) return { ok: false, error: 'FORBIDDEN' };
          return { ok: true, result: locks.acquire(p.keys, who, !!p.force) };
        }
        if (method === 'locks.heartbeat') return { ok: true, result: locks.heartbeat(p.keys, owner) };
        if (method === 'locks.release') return { ok: true, result: locks.release(p.keys, owner) };
        if (method === 'locks.list') return { ok: true, result: locks.list(owner) };
        return { ok: false, error: 'UNKNOWN_METHOD' };
      }
      if (write) {
        const keys = lockKeysFor(method, params || {});
        const holder = keys.length ? locks.heldByOther(keys, ctx.owner || pc || 'local') : null;
        if (holder) return { ok: false, error: 'LOCKED', detail: { who: holder.user, pc: holder.pc } };
      }
      if (!write) {
        // Reads that show dues make sure this month's fees exist first — only when something that
        // changes fees happened since the last check (or a new month began, or 10 minutes passed).
        if (/^(dashboard|students|charges)\./.test(method) && feesDue()) {
          const made = ensureMonthlyCharges();
          feesChecked = { period: currentPeriod(), at: Date.now() };
          if (made > 0) onWrite?.();
        }
        return { ok: true, result: auth.filter(method, fn(params || {}, ctx), ctx) };
      }
      db.exec('BEGIN IMMEDIATE');
      let result;
      actionNotes = [];
      try {
        result = fn(params || {}, ctx);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        actionNotes = [];
        throw err;
      }
      try {
        sendActionNotes();
      } catch (err) {
        console.error('[notify] action message failed:', err.message);
      }
      if (!NO_FEE_EFFECT.test(method)) feesChecked = null;
      // Signing in/out changes no club data, so other PCs don't need to refresh.
      if (!method.startsWith('auth.')) onWrite?.();
      return { ok: true, result };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, error: err.message, ...(err.detail ? { detail: err.detail } : {}) };
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

  // Applications made before the half-month rule freed every month they touched: recalculate them once.
  function recalcOldAbsences() {
    if (settings().absence_halves === '1') return;
    db.exec('BEGIN IMMEDIATE');
    try {
      const holiday = freeHalves(parseHolidays(settings().holidays));
      for (const a of all('SELECT * FROM absences WHERE reduced_charges IS NULL')) {
        const own = freeHalves([{ from: a.date_from, to: a.date_to }]);
        const fee = one('SELECT monthly_fee FROM students WHERE id = :id', { id: a.student_id })?.monthly_fee || 0;
        const reduced = {};
        for (const c of all(`SELECT id, period, amount FROM charges WHERE excused_by = :aid AND status = 'waived' AND kind = 'monthly'`, { aid: a.id })) {
          const free = new Set([...(own.get(c.period) || []), ...(holiday.get(c.period) || [])]);
          if (free.size >= 2) continue;
          if (!(own.get(c.period) || new Set()).size) {
            run(`UPDATE charges SET status = 'unpaid', excused_by = NULL WHERE id = :id`, { id: c.id }); // touched, but no half covered
            continue;
          }
          reduced[c.id] = c.amount;
          run(`UPDATE charges SET status = 'unpaid', amount = :amount, absence_from = :from, absence_to = :to WHERE id = :id`, {
            id: c.id, amount: Math.round((Number(fee) || Number(c.amount)) / 2), from: a.date_from, to: a.date_to,
          });
        }
        run('UPDATE absences SET reduced_charges = :r WHERE id = :id', { id: a.id, r: JSON.stringify(reduced) });
      }
      run(`INSERT INTO settings (key, value) VALUES ('absence_halves', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error('[service] recalcOldAbsences failed:', err);
    }
  }
  recalcOldAbsences();

  return { call, ensureMonthlyCharges, settings, outbox };
}

module.exports = { createService, DEFAULT_TEMPLATES };
