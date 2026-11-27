// «Ավտոմատացումներ»: the owner's own rules — When (a trigger) → If (conditions, all must match) → Then (actions).
// Rules run on the main computer, which every save goes through (other computers call its service), so they apply
// to everyone's saves; scheduled rules follow the main computer's clock. See
// docs/superpowers/specs/2026-11-27-automations-design.md.

const { REPORT_KINDS, translator, reportLabel } = require('./reportSheets.mjs');
const { dictionaries } = require('./locales.mjs');

const TRIGGERS = ['student.created', 'student.groupChanged', 'student.statusChanged', 'student.categoryChanged', 'payment.received', 'schedule'];
const STUDENT_TRIGGERS = TRIGGERS.filter((t) => t.startsWith('student.'));

// Condition fields, and which ops each kind of field takes.
const FIELDS = {
  group: 'group',
  oldGroup: 'group',
  newGroup: 'group',
  'group.championship': 'bool',
  'oldGroup.championship': 'bool',
  'newGroup.championship': 'bool',
  category: 'value',
  oldCategory: 'value',
  newCategory: 'value',
  status: 'value',
  oldStatus: 'value',
  newStatus: 'value',
  fee: 'number',
  'payment.total': 'number',
  'payment.method': 'value',
  'payment.hasMonthly': 'bool',
};
const OPS = {
  group: ['is', 'isNot', 'in', 'notIn'],
  value: ['is', 'isNot', 'in', 'notIn'],
  bool: ['is'],
  number: ['eq', 'lt', 'gt'],
};

// Actions that work on one student (student and payment triggers) and the club-wide ones (any trigger).
const STUDENT_ACTIONS = ['setFee', 'setCategory', 'addNote', 'sendEmail', 'addDebt'];
const CLUB_ACTIONS = ['sendTelegram', 'sendSummary', 'sendReminders', 'emailReport', 'sendEmail'];
const ACTIONS = [...new Set([...STUDENT_ACTIONS, ...CLUB_ACTIONS])];

const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const parse = (s, fallback) => {
  try {
    return s == null ? fallback : JSON.parse(s);
  } catch {
    return fallback;
  }
};

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // the week's Thursday decides its year
  const week = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
};

/**
 * The slot a scheduled rule is due for at `now` (local time), or null when it isn't due: '2026-11-27' (daily),
 * '2026-W49' (weekly), '2026-11' (monthly). A monthly rule missed on its day (app closed) runs on a later day of
 * the same month; a daily or weekly one only on its own day.
 */
function slotKey(trigger, now) {
  const [hh, mm] = String(trigger.time || '00:00').split(':').map(Number);
  const timeOk = now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
  switch (trigger.every) {
    case 'daily':
      return timeOk ? localDay(now) : null;
    case 'weekly':
      return now.getDay() === trigger.weekday && timeOk ? isoWeek(now) : null;
    case 'monthly':
      return now.getDate() > trigger.day || (now.getDate() === trigger.day && timeOk) ? localDay(now).slice(0, 7) : null;
    default:
      return null;
  }
}

const hy = translator(dictionaries, 'hy');
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();
// The dates a relative report range covers at `now`; period = the month of its last day.
function reportRange(range, now) {
  const d = (y, m, day) => localDay(new Date(y, m, day));
  const [y, m, day] = [now.getFullYear(), now.getMonth(), now.getDate()];
  let from;
  let to;
  if (range === 'yesterday') from = to = d(y, m, day - 1);
  else if (range === 'last7') [from, to] = [d(y, m, day - 6), d(y, m, day)];
  else if (range === 'thisMonth') [from, to] = [d(y, m, 1), d(y, m, day)];
  else [from, to] = [d(y, m - 1, 1), d(y, m - 1, lastDay(y, m - 1))];
  return { period: to.slice(0, 7), from, to };
}

/**
 * «Keep the student's discount» when the group price changes: the same share of the new group's price, rounded
 * to 500 (15 000 of 30 000 → 17 500 of 35 000). null when either price is unknown.
 */
function keepDiscountFee(currentFee, oldPrice, newPrice) {
  if (!(Number(oldPrice) > 0) || !(Number(newPrice) > 0)) return null;
  if (!(Number(currentFee) > 0)) return 0;
  return Math.round((Number(currentFee) * Number(newPrice)) / Number(oldPrice) / 500) * 500;
}

/**
 * Whether every condition holds for these facts (flat: { group, 'group.championship', oldGroup, fee, 'payment.total', … }).
 * An unknown field, or a fact this event doesn't have, makes the condition false — never an error.
 */
function matches(conditions, facts) {
  return conditions.every(({ field, op, value }) => {
    const kind = FIELDS[field];
    const v = facts[field];
    if (!kind || v === undefined) return false;
    const same = (x) => (kind === 'group' ? Number(x) === Number(v) : String(x ?? '') === String(v ?? ''));
    switch (op) {
      case 'is':
        return kind === 'bool' ? !!v === !!value : same(value);
      case 'isNot':
        return !same(value);
      case 'in':
        return Array.isArray(value) && value.some(same);
      case 'notIn':
        return Array.isArray(value) && !value.some(same);
      case 'eq':
        return Number(v) === Number(value);
      case 'lt':
        return Number(v) < Number(value);
      case 'gt':
        return Number(v) > Number(value);
      default:
        return false;
    }
  });
}

/**
 * Checks a rule from the editor and returns it cleaned. Throws AppError('NAME_REQUIRED') or
 * AppError('AUTOMATION_INVALID', { field: 'trigger' | 'conditions' | 'actions', index? }).
 */
function validateRule(p, AppError) {
  const bad = (field, index) => new AppError('AUTOMATION_INVALID', index == null ? { field } : { field, index });
  const name = String(p?.name || '').trim();
  if (!name) throw new AppError('NAME_REQUIRED');

  const tr = p.trigger || {};
  if (!TRIGGERS.includes(tr.type)) throw bad('trigger');
  const trigger = { type: tr.type };
  if (tr.type === 'schedule') {
    if (!['daily', 'weekly', 'monthly'].includes(tr.every) || !isTime(tr.time)) throw bad('trigger');
    Object.assign(trigger, { every: tr.every, time: tr.time });
    if (tr.every === 'weekly') {
      if (!(Number.isInteger(tr.weekday) && tr.weekday >= 0 && tr.weekday <= 6)) throw bad('trigger');
      trigger.weekday = tr.weekday;
    }
    if (tr.every === 'monthly') {
      if (!(Number.isInteger(tr.day) && tr.day >= 1 && tr.day <= 28)) throw bad('trigger');
      trigger.day = tr.day;
    }
  }

  const conditions = (Array.isArray(p.conditions) ? p.conditions : []).map((c, i) => {
    const kind = FIELDS[c?.field];
    if (!kind || !OPS[kind].includes(c.op)) throw bad('conditions', i);
    if (['in', 'notIn'].includes(c.op) && !Array.isArray(c.value)) throw bad('conditions', i);
    if (kind === 'number' && !Number.isFinite(Number(c.value))) throw bad('conditions', i);
    if (kind === 'bool' && typeof c.value !== 'boolean') throw bad('conditions', i);
    return { field: c.field, op: c.op, value: kind === 'number' ? Number(c.value) : c.value };
  });
  if (trigger.type === 'schedule' && conditions.length) throw bad('conditions', 0);

  const list = Array.isArray(p.actions) ? p.actions : [];
  if (!list.length) throw bad('actions');
  const allowed = trigger.type === 'schedule' ? CLUB_ACTIONS : ACTIONS;
  const actions = list.map((a, i) => {
    if (!allowed.includes(a?.type)) throw bad('actions', i);
    switch (a.type) {
      case 'setFee':
        if (a.mode === 'fixed' && Number.isFinite(Number(a.amount)) && Number(a.amount) >= 0) return { type: a.type, mode: 'fixed', amount: Number(a.amount) };
        if (a.mode === 'keepDiscount') return { type: a.type, mode: 'keepDiscount' };
        throw bad('actions', i);
      case 'setCategory':
        return { type: a.type, value: String(a.value || '') };
      case 'addNote':
        if (!String(a.text || '').trim()) throw bad('actions', i);
        return { type: a.type, text: String(a.text) };
      case 'sendEmail': {
        const to = String(a.to || '').trim();
        const toParent = trigger.type !== 'schedule' && !!a.toParent;
        if ((!to && !toParent) || !String(a.body || '').trim()) throw bad('actions', i);
        return { type: a.type, toParent, to, subject: String(a.subject || ''), body: String(a.body) };
      }
      case 'sendTelegram':
        if (!String(a.text || '').trim()) throw bad('actions', i);
        return { type: a.type, text: String(a.text) };
      case 'sendSummary':
        if (!['daily', 'monthly'].includes(a.kind)) throw bad('actions', i);
        return { type: a.type, kind: a.kind, telegram: a.telegram !== false, emails: String(a.emails || '').trim() };
      case 'sendReminders':
        return { type: a.type };
      case 'emailReport':
        if (!REPORT_KINDS.includes(a.report) || !['yesterday', 'last7', 'thisMonth', 'lastMonth'].includes(a.range) || !String(a.to || '').trim()) throw bad('actions', i);
        return { type: a.type, report: String(a.report), range: a.range, to: String(a.to).trim() };
      case 'addDebt':
        if (!(Number(a.amount) > 0) || !['this', 'next'].includes(a.month)) throw bad('actions', i);
        return { type: a.type, amount: Number(a.amount), month: a.month, note: String(a.note || '') };
      default:
        throw bad('actions', i);
    }
  });

  return { id: Number(p.id) || null, name, enabled: p.enabled === false || p.enabled === 0 ? 0 : 1, trigger, conditions, actions };
}

/**
 * The engine, created by the service. sql: { one, all, run }; deps: what the actions need from the service
 * (filled in by later steps). Returns the RPC methods and the run entry points.
 */
function createAutomations(sql, deps) {
  const { one, all, run } = sql;
  const { AppError } = deps;
  const ruleOf = (r) => ({ ...r, trigger: parse(r.trigger, {}), conditions: parse(r.conditions, []), actions: parse(r.actions, []), schedule_state: parse(r.schedule_state, null) });

  const methods = {
    'automations.list': () =>
      all(
        `SELECT a.*, (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id) AS runs_count,
                (SELECT MAX(r.at) FROM automation_runs r WHERE r.automation_id = a.id) AS last_run_at
         FROM automations a ORDER BY a.name COLLATE NOCASE`
      ).map(ruleOf),

    'automations.save': (p, ctx) => {
      const r = validateRule(p, AppError);
      const row = { ...r, trigger: JSON.stringify(r.trigger), conditions: JSON.stringify(r.conditions), actions: JSON.stringify(r.actions), by: ctx.user || null };
      // A scheduled rule that is new, changed its time or was turned back on starts with its next slot — not
      // right away for a slot already past (e.g. «reminders on the 20th» saved on the 27th).
      const startState = () => {
        const slot = r.trigger.type === 'schedule' ? slotKey(r.trigger, new Date()) : null;
        return slot ? JSON.stringify({ slot }) : null;
      };
      if (r.id) {
        const was = one('SELECT trigger, enabled, schedule_state FROM automations WHERE id = :id', { id: r.id });
        if (!was) throw new AppError('NOT_FOUND');
        const restart = was.trigger !== row.trigger || (!was.enabled && r.enabled);
        run(
          `UPDATE automations SET name = :name, enabled = :enabled, trigger = :trigger, conditions = :conditions, actions = :actions,
                  schedule_state = :state, updated_at = datetime('now', 'localtime') WHERE id = :id`,
          { ...row, state: restart ? startState() : was.schedule_state }
        );
        deps.log?.(ctx, 'automation.saved', r.name);
        return { id: r.id };
      }
      const res = run(
        `INSERT INTO automations (name, enabled, trigger, conditions, actions, schedule_state, created_by)
         VALUES (:name, :enabled, :trigger, :conditions, :actions, :state, :by)`,
        { ...row, state: startState() }
      );
      deps.log?.(ctx, 'automation.saved', r.name);
      return { id: Number(res.lastInsertRowid) };
    },

    'automations.delete': ({ id } = {}, ctx) => {
      const r = one('SELECT name FROM automations WHERE id = :id', { id: Number(id) || 0 });
      if (!r) throw new AppError('NOT_FOUND');
      run('DELETE FROM automations WHERE id = :id', { id: Number(id) });
      deps.log?.(ctx, 'automation.deleted', r.name);
      return true;
    },

    'automations.runs': ({ id, limit = 200 } = {}) =>
      all(
        `SELECT r.*, s.first_name, s.last_name FROM automation_runs r LEFT JOIN students s ON s.id = r.student_id
         WHERE (:id IS NULL OR r.automation_id = :id) ORDER BY r.id DESC LIMIT :limit`,
        { id: Number(id) || null, limit: Math.min(Math.max(Number(limit) || 200, 1), 1000) }
      ).map((r) => ({ ...r, detail: parse(r.detail, []) })),
  };

  // ---------------------------------------------------------------- running
  const LABELS = require('./activityLabels');
  const groupRow = (id) => (id ? one('SELECT id, name, monthly_fee, championship FROM groups WHERE id = :id', { id }) : null);
  const statusText = (v) => (v ? LABELS.statuses[v] || v : '');
  const categoryText = (v) => (v ? LABELS.categories[v] || v : 'Առանց կարգավիճակ');

  // The placeholders a rule's texts can use for this event.
  function varsFor(event) {
    const base = event.studentId ? deps.studentVars(event.studentId).vars : { club: deps.studentVars(0).vars.club, date: deps.studentVars(0).vars.date };
    const s = event.studentId ? one('SELECT group_id FROM students WHERE id = :id', { id: event.studentId }) : null;
    const v = { ...base, group: groupRow(s?.group_id)?.name || '' };
    if (event.before) {
      Object.assign(v, {
        oldGroup: groupRow(event.before.group_id)?.name || '—',
        newGroup: groupRow(event.after.group_id)?.name || '—',
        oldFee: deps.amd(event.before.monthly_fee),
        newFee: deps.amd(event.after.monthly_fee),
        oldStatus: statusText(event.before.status),
        newStatus: statusText(event.after.status),
        oldCategory: categoryText(event.before.category),
        newCategory: categoryText(event.after.category),
      });
    }
    if (event.payment) {
      const charges = event.payment.chargeIds.map((id) => one('SELECT * FROM charges WHERE id = :id', { id })).filter(Boolean);
      Object.assign(v, {
        total: deps.amd(event.payment.total),
        method: LABELS.methods[event.payment.method] || deps.methodName(event.payment.method),
        items: charges.map((c) => `• ${deps.chargeText(c)} — ${deps.amd(c.amount)}`).join('\n'),
        by: event.by || '',
      });
    }
    return v;
  }

  // Each action: (action, env) → { status: 'done' | 'skipped' | 'failed', text }. Throwing fails the whole rule.
  const done = (text) => ({ status: 'done', text });
  const skipped = (text) => ({ status: 'skipped', text });
  const failed = (text) => ({ status: 'failed', text });
  const emails = (list) => String(list || '').split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));

  const ACTION_RUN = {
    addNote: (a, env) => {
      const text = deps.fill(a.text, env.vars());
      deps.addNote(env.event.studentId, text, env.ctx, true);
      return done(`Նշում՝ ${text}`);
    },

    setFee: (a, env) => {
      const { event } = env;
      const s = one('SELECT monthly_fee, category FROM students WHERE id = :id', { id: event.studentId });
      if (!s) return skipped('Սանը չգտնվեց');
      // The user typed the fee in this same save: their number wins.
      if (event.feeByHand) return skipped('Ամսավճարը փոխվել է ձեռքով — չփոխվեց');
      let fee = Number(a.amount);
      if (a.mode === 'keepDiscount') {
        // Set by the director's order: the amount isn't a share of the price.
        if (s.category === 'order') return skipped('Ըստ հրամանի — ամսավճարը չփոխվեց');
        if (!event.before) return skipped('Միայն խմբի փոփոխության դեպքում');
        fee = keepDiscountFee(event.before.monthly_fee, groupRow(event.before.group_id)?.monthly_fee, groupRow(event.after.group_id)?.monthly_fee);
        if (fee == null) return skipped('Խմբի գինը հայտնի չէ — ամսավճարը չփոխվեց');
      }
      if (fee === s.monthly_fee) return skipped(`Ամսավճարն արդեն ${deps.amd(fee)} է`);
      deps.setFee(event.studentId, fee, env.ctx);
      env.setVar('newFee', deps.amd(fee));
      return done(`Ամսավճար՝ ${deps.amd(s.monthly_fee)} → ${deps.amd(fee)}`);
    },

    setCategory: (a, env) => {
      const s = one('SELECT category FROM students WHERE id = :id', { id: env.event.studentId });
      if ((s?.category || '') === (a.value || '')) return skipped(`Կարգավիճակն արդեն ${categoryText(a.value)} է`);
      deps.setCategory(env.event.studentId, a.value, env.ctx);
      env.setVar('newCategory', categoryText(a.value));
      return done(`Կարգավիճակ՝ ${categoryText(a.value)}`);
    },

    sendEmail: (a, env) => {
      if (!deps.emailOn()) return failed('Էլ. փոստը կարգավորված չէ (Ծանուցումներ)');
      const vars = env.vars();
      const to = emails(a.to);
      let note = '';
      if (a.toParent) {
        const parent = one('SELECT parent_email FROM students WHERE id = :id', { id: env.event.studentId })?.parent_email;
        if (parent) to.unshift(parent);
        else note = ' (ծնողի էլ. հասցեն նշված չէ)';
      }
      // Only to the parent, who has no email: nothing to send (as the old receipt did), not an error.
      if (!to.length) return a.toParent && !emails(a.to).length ? skipped('Ծնողի էլ. հասցեն նշված չէ') : failed(`Ստացող չկա${note}`);
      for (const recipient of to)
        deps.enqueue({ channel: 'email', recipient, subject: deps.fill(a.subject, vars), body: deps.fill(a.body, vars), kind: 'automation', studentId: env.event.studentId || null }, env.ctx);
      return done(`Էլ. նամակ՝ ${to.join(', ')}${note}`);
    },

    sendTelegram: (a, env) => {
      const chats = deps.telegramChats();
      if (!chats.length) return failed('Telegram-ը կարգավորված չէ (Ծանուցումներ)');
      const text = deps.fill(a.text, env.vars());
      for (const chat of chats) deps.enqueue({ channel: 'telegram', recipient: chat, body: text, kind: 'automation', studentId: env.event.studentId || null }, env.ctx);
      return done(`Telegram՝ ${chats.length} չատ`);
    },

    sendSummary: (a, env) => {
      const now = env.event.now || new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const when = a.kind === 'daily' ? localDay(now) : `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}`;
      const { subject, body } = deps.summaryText(a.kind, when);
      const chats = a.telegram ? deps.telegramChats() : [];
      const to = deps.emailOn() ? emails(a.emails) : [];
      if (!chats.length && !to.length) return failed('Ստացող չկա (Telegram / էլ. փոստ կարգավորված չէ)');
      for (const chat of chats) deps.enqueue({ channel: 'telegram', recipient: chat, body, kind: a.kind }, env.ctx);
      for (const recipient of to) deps.enqueue({ channel: 'email', recipient, subject, body, kind: a.kind }, env.ctx);
      return done(`Ամփոփում՝ ${chats.length + to.length} ստացող`);
    },

    sendReminders: (a, env) => {
      if (!deps.emailOn()) return failed('Էլ. փոստը կարգավորված չէ (Ծանուցումներ)');
      const r = deps.remindOverdue(null, env.ctx, { skipReminded: true });
      return done(`Հիշեցումներ՝ ${r.queued}${r.noEmail.length ? `, առանց էլ. հասցեի՝ ${r.noEmail.length}` : ''}`);
    },

    emailReport: (a, env) => {
      if (!deps.emailOn()) return failed('Էլ. փոստը կարգավորված չէ (Ծանուցումներ)');
      const to = emails(a.to);
      if (!to.length) return failed('Ստացող չկա');
      const spec = { report: a.report, ...reportRange(a.range, env.event.now || new Date()) };
      const { title, when } = reportLabel(spec, hy, localDay(env.event.now || new Date()));
      const vars = env.vars();
      // The file itself is made when the email is sent (main process), from this description.
      for (const recipient of to)
        deps.enqueue(
          { channel: 'email', recipient, subject: `${title} — ${when}`, body: `${title} — ${when}\n\n${vars.club}`, kind: 'report', attachment: JSON.stringify(spec) },
          env.ctx
        );
      return done(`Հաշվետվություն «${title}» (${when})՝ ${to.join(', ')}`);
    },

    addDebt: (a, env) => {
      const sid = env.event.studentId;
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth() + (a.month === 'next' ? 1 : 0), 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      // As «Ավելացնել պարտք» does it: an extra charge for a month that already has its fee, else that month's fee.
      const fee = one(`SELECT id FROM charges WHERE student_id = :sid AND kind = 'monthly' AND period = :period`, { sid, period });
      const note = a.note.trim() || 'Լրացուցիչ վճար';
      deps.createCharge(
        fee
          ? { studentId: sid, kind: 'other', amount: a.amount, description: `${deps.monthHy(period)} · ${note}`, forPeriod: period, paid: false }
          : { studentId: sid, kind: 'monthly', amount: a.amount, period, paid: false, note },
        env.ctx
      );
      return done(`Պարտք՝ ${deps.amd(a.amount)} (${deps.monthHy(period)})`);
    },
  };

  // persist(): saves what must stay even when the rule fails (a scheduled rule's slot), inside its transaction.
  function runRule(rule, event, persist = () => {}) {
    const ctx = { user: `Ավտոմատացում · ${rule.name}`, automation: true, quiet: true, account: null };
    let vars = null;
    const env = {
      event, ctx, rule,
      vars: () => (vars = vars || varsFor(event)),
      // A later action's texts see what an earlier one changed ({newFee} after «set monthly fee»).
      setVar: (k, v) => (env.vars()[k] = v),
    };
    const record = (status, detail) =>
      run(`INSERT INTO automation_runs (automation_id, rule_name, student_id, status, detail) VALUES (:id, :name, :sid, :status, :detail)`, {
        id: rule.id, name: rule.name, sid: event.studentId || null, status, detail: JSON.stringify(detail),
      });
    sql.exec('BEGIN IMMEDIATE');
    try {
      const detail = rule.actions.map((a) => {
        const fn = ACTION_RUN[a.type];
        if (!fn) throw new Error(`Unknown action: ${a.type}`);
        return { action: a.type, ...fn(a, env) };
      });
      const status = detail.some((d) => d.status === 'failed') ? 'failed' : detail.some((d) => d.status === 'done') ? 'done' : 'skipped';
      record(status, detail);
      persist();
      sql.exec('COMMIT');
      return { ruleId: rule.id, name: rule.name, status, summary: detail.map((d) => d.text).filter(Boolean).join(' · ') };
    } catch (err) {
      try {
        sql.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled back by itself (disk full, I/O error).
      }
      const text = err instanceof AppError ? err.message : String(err?.message || err);
      try {
        record('failed', [{ action: null, status: 'failed', text }]);
        persist();
      } catch (e) {
        console.error('[automations] could not record a failed run:', e.message);
      }
      return { ruleId: rule.id, name: rule.name, status: 'failed', summary: text };
    }
  }

  // What the conditions are checked against: the student as saved now, and the event's before / after.
  function factsFor(event) {
    const f = {};
    const s = event.studentId ? one('SELECT group_id, category, status, monthly_fee FROM students WHERE id = :id', { id: event.studentId }) : null;
    const putGroup = (key, id) => {
      if (id === undefined) return;
      f[key] = id ?? null;
      f[`${key}.championship`] = !!groupRow(id)?.championship;
    };
    if (s) {
      putGroup('group', s.group_id);
      Object.assign(f, { category: s.category || '', status: s.status, fee: s.monthly_fee ?? 0 });
    }
    if (event.before) {
      putGroup('oldGroup', event.before.group_id);
      putGroup('newGroup', event.after.group_id);
      Object.assign(f, {
        oldCategory: event.before.category, newCategory: event.after.category,
        oldStatus: event.before.status, newStatus: event.after.status,
      });
    }
    if (event.payment) {
      const kinds = event.payment.chargeIds.map((id) => one('SELECT kind FROM charges WHERE id = :id', { id })?.kind);
      Object.assign(f, { 'payment.total': event.payment.total, 'payment.method': event.payment.method, 'payment.hasMonthly': kinds.includes('monthly') });
    }
    return f;
  }
  const matchesEvent = (rule, event) => matches(rule.conditions, factsFor(event));

  /** Runs the enabled rules for the events of one save (already committed). Returns what ran, for the screen. */
  function handle(events) {
    const out = [];
    const rules = all('SELECT * FROM automations WHERE enabled = 1 ORDER BY id').map(ruleOf);
    for (const event of events)
      for (const rule of rules) {
        if (rule.trigger.type !== event.type) continue;
        // One broken rule (e.g. a damaged row) never stops the others, nor the save that started them.
        try {
          if (matchesEvent(rule, event)) out.push(runRule(rule, event));
        } catch (err) {
          const text = String(err?.message || err);
          try {
            run(`INSERT INTO automation_runs (automation_id, rule_name, student_id, status, detail) VALUES (:id, :name, :sid, 'failed', :detail)`, {
              id: rule.id, name: rule.name, sid: event.studentId || null, detail: JSON.stringify([{ action: null, status: 'failed', text }]),
            });
          } catch (e) {
            console.error('[automations] could not record a failed rule:', e.message);
          }
          out.push({ ruleId: rule.id, name: rule.name, status: 'failed', summary: text });
        }
      }
    return out;
  }

  // ---------------------------------------------------------------- scheduled rules
  let prunedOn = null;
  /** Called every minute on the main computer: runs the scheduled rules that are due, once per slot. */
  function tick(now = new Date()) {
    const out = [];
    for (const rule of all(`SELECT * FROM automations WHERE enabled = 1 ORDER BY id`).map(ruleOf)) {
      if (rule.trigger.type !== 'schedule') continue;
      const slot = slotKey(rule.trigger, now);
      if (!slot || rule.schedule_state?.slot === slot) continue;
      const persist = () => run('UPDATE automations SET schedule_state = :st WHERE id = :id', { id: rule.id, st: JSON.stringify({ slot }) });
      out.push(runRule(rule, { type: 'schedule', now }, persist));
    }
    // Run history is kept for 12 months.
    const today = localDay(now);
    if (prunedOn !== today) {
      run(`DELETE FROM automation_runs WHERE at < datetime('now', 'localtime', '-12 months')`);
      prunedOn = today;
    }
    return out;
  }

  // ---------------------------------------------------------------- today's automations → rules (once)
  /**
   * The switches that used to be in Ծանուցումներ (config.notify), as rules — only the ones turned on. Their
   * scheduler progress (cfg.state) becomes the rules' slots, so nothing already sent is sent again.
   * Returns the names created; a rule whose name already exists is not created again.
   */
  function migrateNotify(cfg = {}) {
    const tpl = deps.templates(cfg);
    const st = cfg.state || {};
    const wanted = [];
    if (cfg.daily?.enabled)
      wanted.push({
        name: 'Օրական ամփոփում', slot: st.daily,
        trigger: { type: 'schedule', every: 'daily', time: /^\d\d:\d\d$/.test(cfg.daily.time || '') ? cfg.daily.time : '20:00' },
        actions: [{ type: 'sendSummary', kind: 'daily', telegram: true, emails: cfg.summaryEmails || '' }],
      });
    if (cfg.monthly?.enabled)
      wanted.push({
        name: 'Ամսական ամփոփում', slot: st.monthly,
        trigger: { type: 'schedule', every: 'monthly', day: 1, time: '00:00' },
        actions: [{ type: 'sendSummary', kind: 'monthly', telegram: true, emails: cfg.summaryEmails || '' }],
      });
    if (cfg.reminders?.auto)
      wanted.push({
        name: 'Պարտքի հիշեցումներ', slot: st.reminders,
        trigger: { type: 'schedule', every: 'monthly', day: Math.min(Math.max(Number(cfg.reminders.day) || 20, 1), 28), time: '00:00' },
        actions: [{ type: 'sendReminders' }],
      });
    if (cfg.receipts)
      wanted.push({
        name: 'Անդորրագիր ծնողին',
        trigger: { type: 'payment.received' },
        actions: [{ type: 'sendEmail', toParent: true, to: '', subject: tpl.receiptSubject, body: tpl.receiptBody }],
      });
    if (cfg.paymentAlerts)
      wanted.push({
        name: 'Վճարման ծանուցում Telegram-ով',
        trigger: { type: 'payment.received' },
        actions: [{ type: 'sendTelegram', text: '💳 Վճարում — {student}\n{items}\nԸնդամենը՝ {total} ({method})\nԳրանցող՝ {by}' }],
      });
    const created = [];
    sql.exec('BEGIN IMMEDIATE');
    try {
      for (const w of wanted) {
        if (one('SELECT id FROM automations WHERE name = :name', { name: w.name })) continue;
        const r = validateRule({ name: w.name, trigger: w.trigger, conditions: [], actions: w.actions }, AppError);
        run(
          `INSERT INTO automations (name, enabled, trigger, conditions, actions, schedule_state, created_by)
           VALUES (:name, 1, :trigger, '[]', :actions, :state, 'FC Manager')`,
          { name: r.name, trigger: JSON.stringify(r.trigger), actions: JSON.stringify(r.actions), state: w.slot ? JSON.stringify({ slot: w.slot }) : null }
        );
        created.push(r.name);
      }
      sql.exec('COMMIT');
    } catch (err) {
      sql.exec('ROLLBACK');
      throw err;
    }
    return created;
  }

  return { methods, handle, tick, migrateNotify };
}

module.exports = { createAutomations, validateRule, matches, keepDiscountFee, slotKey, TRIGGERS, STUDENT_TRIGGERS, FIELDS, OPS, STUDENT_ACTIONS, CLUB_ACTIONS };
