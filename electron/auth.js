// Users, sign-in, roles and permissions. Enforced in service.call on the host PC, so it applies
// to every computer (the LAN server goes through the same call).
//
// Sign-in is off while there are no users. Once the first (admin) user exists, every request
// needs a valid session token.
//
// Permissions: one tick per action (electron/permissions.json, e.g. «payments.delete»). A user gets the ticks
// of their role (Settings → Users → Roles) with their own changes on top (rights = { v: 2, grant, deny }),
// and may be limited to some groups (users.group_ids: a JSON list of group ids; NULL = all groups).
// Every service method needs the ticks RULES gives it; a method without a rule stops the program at start.
const crypto = require('crypto');
const CATALOG = require('./permissions.json');

const SECTIONS = CATALOG.sections.map((s) => s.id);
const ALL_PERMS = CATALOG.sections.flatMap((s) => s.perms.map((p) => `${s.id}.${p}`));
const KNOWN = new Set(ALL_PERMS);
// Reports and settings ticks stand on their own; in the other menus every tick needs the menu's «view».
const requiresOf = (perm) => {
  if (CATALOG.requires[perm]) return CATALOG.requires[perm];
  const [s, p] = perm.split('.');
  return s === 'reports' || s === 'settings' || p === 'view' ? [] : [`${s}.view`];
};
// Known ticks only, without those whose requirement is missing.
function closePerms(list) {
  const set = new Set([...list].filter((p) => KNOWN.has(p)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of [...set])
      if (!requiresOf(p).every((r) => set.has(r))) {
        set.delete(p);
        changed = true;
      }
  }
  return set;
}

const safeJson = (s, fallback) => {
  try {
    const v = JSON.parse(s);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
};
const list = (v) => (Array.isArray(v) ? v.map(String).filter((p) => KNOWN.has(p)) : []);

// Rights saved before 1.5.0 ({ section: 'none' | 'view' | 'edit', excel: { section: false } }) as ticks, so
// nobody gains or loses anything: «view» gives what that level showed, «edit» every tick of the menu.
const LEGACY_VIEW = {
  students: ['view', 'personal', 'print', 'excel'],
  payments: ['view', 'excel'],
  attendance: ['view', 'print', 'excel'],
  schedule: ['view', 'print', 'excel'],
  groups: ['view', 'excel'],
  contracts: ['view', 'print'],
  settings: ['data', 'backups', 'log', 'logExcel'],
};
function fromLegacy(r) {
  const out = [];
  const excel = r && typeof r.excel === 'object' && r.excel ? r.excel : {};
  for (const s of CATALOG.sections) {
    const level = r?.[s.id];
    if (level !== 'view' && level !== 'edit') continue;
    for (const p of level === 'edit' ? s.perms : LEGACY_VIEW[s.id] || s.perms) {
      if (excel[s.id] === false && (p === 'excel' || p === 'logExcel')) continue;
      out.push(`${s.id}.${p}`);
    }
  }
  if (r?.payments === 'edit') out.push('settings.hdm'); // the ՀԴՄ tab was shown with the Payments right
  // The student's and the group's form changed the fee with the Students / Groups right.
  if (r?.students === 'edit' || r?.groups === 'edit') out.push('payments.fee');
  return [...closePerms(out)];
}
// A user's own changes on top of their role: { v: 2, grant: [...], deny: [...] }.
function parseRights(raw) {
  const src = typeof raw === 'string' ? safeJson(raw, {}) : raw || {};
  if (src.v === 2) return { v: 2, grant: list(src.grant), deny: list(src.deny) };
  return { v: 2, grant: fromLegacy(src), deny: [] };
}
const parseGroups = (raw) => {
  if (raw == null || raw === '') return null;
  const v = typeof raw === 'string' ? safeJson(raw, null) : raw;
  return Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => n > 0))] : null;
};

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Open to anyone (the sign-in screen needs them).
const PUBLIC = new Set(['auth.status', 'auth.login', 'settings.get']);
// Open to anyone signed in.
const SELF = new Set(['auth.logout', 'auth.changePassword', 'locks.acquire', 'locks.heartbeat', 'locks.release', 'locks.list']);
// Admins only.
const ADMIN = /^(users|roles)\./;

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
};
const checkPassword = (password, stored) => {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(String(password), salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

// Student data only people with «students.personal» see (and keep when they save a student without it).
const PERSONAL_FIELDS = ['phone', 'email', 'address', 'document_no', 'parent_phone', 'parent_doc_no', 'parent_doc_issuer', 'parent_doc_date',
  'parent_ssn', 'parent_address', 'parent_email', 'parent_messenger'];

function createAuth({ all, one, run, AppError, log }) {
  const userCount = () => one('SELECT COUNT(*) AS n FROM users WHERE active = 1').n;
  const roleOf = (id) => (id ? one('SELECT id, name, perms FROM roles WHERE id = :id', { id }) : null);
  const rolePerms = (role) => (role ? list(safeJson(role.perms, [])) : []);

  // The ticks a user really has: the role's, plus their own, minus the ones taken away.
  function effective(u) {
    if (u.is_admin) return new Set(ALL_PERMS);
    const r = parseRights(u.rights);
    const set = new Set(rolePerms(roleOf(u.role_id)));
    r.grant.forEach((p) => set.add(p));
    r.deny.forEach((p) => set.delete(p));
    return closePerms(set);
  }

  const publicUser = (u) => {
    if (!u) return u;
    const role = u.is_admin ? null : roleOf(u.role_id);
    const r = parseRights(u.rights);
    return {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      is_admin: !!u.is_admin,
      active: !!u.active,
      notify_actions: !!u.notify_actions,
      role_id: role ? role.id : null,
      role_name: role ? role.name : null,
      rights: u.is_admin ? { v: 2, grant: [], deny: [] } : r,
      perms: [...effective(u)],
      groups: u.is_admin ? null : parseGroups(u.group_ids),
      last_login_at: u.last_login_at,
      created_at: u.created_at,
    };
  };

  const userForToken = (token) => {
    if (!token) return null;
    const u = one(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = :token AND u.active = 1`,
      { token: String(token) }
    );
    if (u)
      run(
        `UPDATE sessions SET last_seen_at = datetime('now', 'localtime')
         WHERE token = :token AND last_seen_at < datetime('now', 'localtime', '-5 minutes')`,
        { token: String(token) }
      );
    return u || null;
  };

  // ------------------------------------------------------------------ what each method needs
  // A rule is a tick, or a function (params, account) giving a list of needs; a need is a tick, or a list of
  // ticks any one of which will do. [] = anyone signed in.
  const anyStudentMenu = ['students.view', 'payments.view', 'attendance.view', 'contracts.view'];
  const charge = (id) => one('SELECT status, paid_at, student_id FROM charges WHERE id = :id', { id }) || {};
  const isPast = (c) => c.status === 'paid' && !!c.paid_at && String(c.paid_at).slice(0, 10) < localToday();
  // A payment dated another day than today.
  const otherDay = (paidAt) => !!paidAt && String(paidAt).slice(0, 10) !== localToday();
  const past = (cond) => (cond ? ['payments.past'] : []);
  const less = (paid, due) => paid != null && paid !== '' && Number(paid) < Number(due);

  const RULES = {
    'settings.update': (p) => [
      ...new Set(Object.keys(p).map((k) => (k.startsWith('msg_') ? 'settings.notify' : 'settings.club'))),
    ],
    'dashboard.summary': 'reports.dashboard',
    'dashboard.today.list': (p) => (p.mine === false ? ['reports.dashboard', 'reports.salesAll'] : ['reports.dashboard']),

    'groups.list': () => [],
    'groups.save': 'groups.edit',
    'groups.delete': 'groups.delete',

    'students.contractNo.get': () => [['students.add', 'students.edit', 'settings.club']],
    'students.summary': () => [anyStudentMenu],
    'students.list': () => [anyStudentMenu],
    'students.get': () => [anyStudentMenu],
    'students.history': 'students.view',
    'students.save': (p) => {
      if (!p.id) return ['students.add'];
      const was = one('SELECT status FROM students WHERE id = :id', { id: p.id });
      const status = p.status === 'inactive' ? 'inactive' : 'active';
      return ['students.edit', ...(was && was.status !== status ? ['students.terminate'] : [])];
    },
    'students.terminate': 'students.terminate',
    'students.delete': 'students.delete',
    'students.link': 'students.link',
    'students.unlink': 'students.link',
    'students.import': 'students.import',
    'students.importFull': 'students.import',
    'students.export': 'settings.data',
    'notes.add': 'students.notes',
    'notes.delete': (p, a) => {
      const n = one('SELECT user_id FROM student_notes WHERE id = :id', { id: p.id });
      return [n && a && n.user_id === a.id ? ['students.notes', 'students.notesDelete'] : 'students.notesDelete'];
    },
    'files.list': () => [anyStudentMenu],
    'files.get': () => [anyStudentMenu],
    // A student's documents; also the signed contract uploaded with a new student, a contract's scan and an
    // absence application's scan.
    'files.upload': (p) => [
      {
        application: ['students.files', 'students.absence', 'payments.waive'],
        contract: ['students.files', 'students.add', 'contracts.edit'],
        medical: ['students.files', 'students.add', 'students.edit'], // the certificate added in the student's form
      }[p.kind] || 'students.files',
    ],
    'files.delete': 'students.filesDelete',
    'applications.create': () => [['students.absence', 'payments.waive']],

    'notify.remind': 'payments.remind',
    'notify.outbox': 'settings.notify',
    'automations.list': 'settings.automations',
    'automations.save': 'settings.automations',
    'automations.delete': 'settings.automations',
    'automations.runs': 'settings.automations',
    'notify.retry': 'settings.notify',
    // Only records that a WhatsApp / Viber message was opened for a parent.
    'notify.messenger': () => [['payments.remind', 'payments.take', 'students.personal']],

    'schedule.get': () => [['schedule.view', 'attendance.view']],
    'schedule.saveBase': 'schedule.base',
    'schedule.savePitches': 'schedule.base',
    'schedule.setCoaches': 'schedule.base',
    'schedule.setDay': 'schedule.day',
    'schedule.resetDay': 'schedule.day',
    'schedule.copyWeek': 'schedule.copy',
    'schedule.toAttendance': () => ['schedule.view', 'attendance.days'],

    'products.list': 'payments.view',
    'products.save': 'payments.products',
    'products.delete': 'payments.products',

    'charges.list': 'payments.view',
    'charges.create': (p) => (p.paid ? ['payments.take', ...past(otherDay(p.paidAt))] : ['payments.charge']),
    'charges.update': (p) => {
      const c = one('SELECT status, paid_at, amount, absence_from, absence_to FROM charges WHERE id = :id', { id: p.id }) || {};
      const absence = p.absenceFrom !== undefined && ((p.absenceFrom || null) !== (c.absence_from || null) || (p.absenceTo || null) !== (c.absence_to || null));
      const moved = c.status === 'paid' && p.paidAt && String(p.paidAt).slice(0, 10) !== String(c.paid_at || '').slice(0, 10);
      return ['payments.edit', ...past(isPast(c) || (moved && otherDay(p.paidAt))), ...(absence ? ['payments.waive'] : [])];
    },
    'charges.markPaid': (p) => {
      const amounts = p.amounts || {};
      const lower = (p.ids || []).some((id) => {
        const c = one('SELECT amount FROM charges WHERE id = :id', { id });
        return c && less(amounts[id], c.amount);
      });
      return ['payments.take', ...past(otherDay(p.paidAt)), ...(lower ? ['payments.waive'] : [])];
    },
    'charges.payMonths': (p) => {
      const st = one('SELECT monthly_fee FROM students WHERE id = :id', { id: p.studentId }) || {};
      const lower = less(p.amount, st.monthly_fee) || !!p.absenceFrom;
      return ['payments.take', ...past(otherDay(p.paidAt)), ...(lower ? ['payments.waive'] : [])];
    },
    // A waived month back to unpaid is part of waiving; a payment made unpaid is cancelling it.
    'charges.markUnpaid': (p) => {
      const c = charge(p.id);
      return c.status === 'waived' ? ['payments.waive'] : ['payments.cancel', ...past(isPast(c))];
    },
    'charges.waive': 'payments.waive',
    'charges.delete': (p) => ['payments.delete', ...past(isPast(charge(p.id)))],
    // Saved by whoever took the payment (its receipt printed with it), or printed later.
    'charges.setReceipt': () => [['payments.take', 'payments.hdm']],
    'charges.receiptReturned': 'payments.hdmReturn',

    'attendance.save': 'attendance.mark',
    'attendance.mark': 'attendance.mark',
    'training.submit': 'attendance.mark',
    'training.ensure': 'attendance.view',
    'training.month': 'attendance.view',
    'training.addDay': 'attendance.days',
    'training.moveDay': 'attendance.days',
    'training.removeDay': 'attendance.deleteDays',
    'training.clearMonth': 'attendance.deleteDays',

    'docTemplates.list': () => [['contracts.view', 'students.add']],
    'docTemplates.get': () => [['contracts.view', 'students.add']],
    'docTemplates.save': 'contracts.templates',
    'docTemplates.delete': 'contracts.templatesDelete',
    'contracts.list': 'contracts.view',
    'contracts.get': 'contracts.view',
    'contracts.document': 'contracts.view',
    'contracts.create': 'contracts.edit',
    'contracts.save': 'contracts.edit',
    'contracts.delete': 'contracts.delete',

    'reports.list': 'reports.view',
    'reports.sheet': (p) => [p.kind === 'salesAnalysis' ? 'reports.sales' : 'reports.view'],
    'activity.list': 'settings.log',
  };

  // Every method has a rule (or is open / admin-only): a new method without one stops the program at start.
  function verify(methodNames) {
    const missing = methodNames.filter((m) => !RULES[m] && !PUBLIC.has(m) && !SELF.has(m) && !ADMIN.test(m) && !m.startsWith('auth.'));
    if (missing.length) throw new Error(`[auth] no permission rule for: ${missing.join(', ')}`);
  }

  const has = (account, perm) => !!account && (account.is_admin || account.perms.includes(perm));
  function needsOf(method, params, account) {
    const rule = RULES[method];
    const needs = typeof rule === 'function' ? rule(params || {}, account) : [rule];
    return needs.every((n) => (Array.isArray(n) ? n.length === 0 || n.some((p) => has(account, p)) : has(account, n)));
  }

  // Returns { error } or { ctx } with ctx.account (the signed-in user) and ctx.user (name for the activity log).
  function check(method, write, ctx, params) {
    if (PUBLIC.has(method)) {
      const account = publicUser(userForToken(ctx.token));
      return { ctx: { ...ctx, account, user: account ? account.full_name || account.username : ctx.user } };
    }
    const required = userCount() > 0;
    const account = publicUser(userForToken(ctx.token));
    if (!required) {
      // Sign-in is off: everything is open, as before users existed.
      return { ctx: { ...ctx, account: null } };
    }
    if (!account) return { error: 'AUTH_REQUIRED' };
    const next = { ...ctx, account, user: account.full_name || account.username };
    if (SELF.has(method) || account.is_admin) return { ctx: next };
    if (ADMIN.test(method)) return { error: 'FORBIDDEN' };
    if (!RULES[method] || !needsOf(method, params, account)) return { error: 'FORBIDDEN' };
    return { ctx: next };
  }

  // Removes parts of a result the user may not see.
  function filter(method, result, ctx) {
    const a = ctx.account;
    if (!a || a.is_admin || !result) return result;
    const can = (p) => has(a, p);
    const hidePersonal = (s) => {
      if (can('students.personal') || !s) return s;
      const r = { ...s };
      for (const f of PERSONAL_FIELDS) if (f in r) r[f] = null;
      return r;
    };
    const hideMoney = (s) => (can('payments.view') || !s ? s : { ...s, monthly_fee: null, first_fee: null, ...('months' in s ? { months: [], overdue: 0, unpaid: 0 } : {}) });
    if (method === 'students.get') {
      const r = { ...result, student: hideMoney(hidePersonal(result.student)) };
      if (!can('payments.view')) r.charges = [];
      if (!can('attendance.view')) {
        r.attendance = [];
        r.attendanceStats = null;
      }
      if (!can('contracts.view')) r.contracts = [];
      if (!can('students.view')) {
        r.notes = [];
        r.files = (r.files || []).filter((f) => f.kind === 'application' || f.kind === 'contract');
      }
      return r;
    }
    if (method === 'students.list') return result.map((s) => hideMoney(hidePersonal(s)));
    if (method === 'students.history') {
      return result.filter(
        (e) =>
          (!e.action.startsWith('charge.') || can('payments.view')) &&
          (!e.action.startsWith('attendance.') || can('attendance.view')) &&
          (!e.action.startsWith('contract.') || can('contracts.view'))
      );
    }
    if (method === 'training.month' && !can('payments.view')) {
      return { ...result, students: (result.students || []).map((s) => ({ ...s, unpaid: 0, overdue: 0 })) };
    }
    if ((method === 'reports.list' || method === 'reports.sheet') && !can('students.personal') && Array.isArray(result)) {
      return result.map((r) => {
        const x = { ...r };
        for (const f of [...PERSONAL_FIELDS, 'parent_phone']) if (f in x) x[f] = null;
        return x;
      });
    }
    return result;
  }

  // ------------------------------------------------------------------ users and roles
  const permsDiff = (before, after) => ({
    added: [...after].filter((p) => !before.has(p)),
    removed: [...before].filter((p) => !after.has(p)),
  });
  // The ticks wanted for a user, saved as their role plus changes: { v: 2, grant, deny }.
  function rightsFor(perms, roleId) {
    const want = closePerms(list(perms));
    const base = new Set(rolePerms(roleOf(roleId)));
    return { v: 2, grant: [...want].filter((p) => !base.has(p)), deny: [...base].filter((p) => !want.has(p)) };
  }
  const groupsJson = (g) => {
    const v = parseGroups(g);
    return v ? JSON.stringify(v) : null;
  };

  const methods = {
    'auth.status': (_p, ctx) => ({ required: userCount() > 0, user: ctx.account || null }),

    'auth.login': ({ username, password }, ctx) => {
      const u = one('SELECT * FROM users WHERE username = :username COLLATE NOCASE AND active = 1', { username: String(username || '').trim() });
      if (!u || !checkPassword(password, u.password_hash)) throw new AppError('BAD_LOGIN');
      const token = crypto.randomBytes(32).toString('hex');
      run(`INSERT INTO sessions (token, user_id) VALUES (:token, :userId)`, { token, userId: u.id });
      run(`UPDATE users SET last_login_at = datetime('now', 'localtime') WHERE id = :id`, { id: u.id });
      // Old sessions nobody used for 60 days.
      run(`DELETE FROM sessions WHERE last_seen_at < datetime('now', 'localtime', '-60 days')`);
      log({ ...ctx, user: u.full_name || u.username }, 'auth.login', u.username);
      return { token, user: publicUser(u) };
    },

    'auth.logout': (_p, ctx) => {
      if (ctx.token) run('DELETE FROM sessions WHERE token = :token', { token: String(ctx.token) });
      return true;
    },

    'auth.changePassword': ({ current, next }, ctx) => {
      if (!ctx.account) throw new AppError('AUTH_REQUIRED');
      const u = one('SELECT * FROM users WHERE id = :id', { id: ctx.account.id });
      if (!checkPassword(current, u.password_hash)) throw new AppError('BAD_PASSWORD');
      if (String(next || '').length < 4) throw new AppError('PASSWORD_SHORT');
      run('UPDATE users SET password_hash = :hash WHERE id = :id', { id: u.id, hash: hashPassword(next) });
      log(ctx, 'user.password', u.username);
      return true;
    },

    'users.list': () => all('SELECT * FROM users ORDER BY is_admin DESC, full_name COLLATE NOCASE').map(publicUser),

    // p.perms: every tick the user should have; saved as their role (p.role_id) plus the differences.
    'users.save': (p, ctx) => {
      const username = String(p.username || '').trim();
      if (!username) throw new AppError('USERNAME_REQUIRED');
      const clash = one('SELECT id FROM users WHERE username = :username COLLATE NOCASE AND id != :id', { username, id: p.id || 0 });
      if (clash) throw new AppError('USERNAME_TAKEN');
      const first = userCount() === 0;
      const roleId = p.role_id && roleOf(p.role_id) ? Number(p.role_id) : null;
      const row = {
        id: p.id || null,
        username,
        fullName: String(p.full_name || '').trim() || null,
        isAdmin: first ? 1 : p.is_admin ? 1 : 0, // the first user is always an admin
        rights: JSON.stringify(Array.isArray(p.perms) ? rightsFor(p.perms, roleId) : parseRights(p.rights)),
        roleId,
        groupIds: groupsJson(p.groups),
        active: first ? 1 : p.active === false ? 0 : 1,
        notifyActions: p.notify_actions ? 1 : 0,
      };
      if (p.id) {
        const old = one('SELECT * FROM users WHERE id = :id', { id: p.id });
        if (!old) throw new AppError('NOT_FOUND');
        // Never leave the club without an active admin.
        if ((!row.isAdmin || !row.active) && old.is_admin) {
          const others = one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND active = 1 AND id != :id', { id: p.id }).n;
          if (others === 0) throw new AppError('LAST_ADMIN');
        }
        const before = effective(old);
        run(
          `UPDATE users SET username = :username, full_name = :fullName, is_admin = :isAdmin, rights = :rights, role_id = :roleId,
                  group_ids = :groupIds, active = :active, notify_actions = :notifyActions WHERE id = :id`,
          row
        );
        if (p.password) {
          if (String(p.password).length < 4) throw new AppError('PASSWORD_SHORT');
          run('UPDATE users SET password_hash = :hash WHERE id = :id', { id: p.id, hash: hashPassword(p.password) });
          run('DELETE FROM sessions WHERE user_id = :id', { id: p.id }); // sign out everywhere
        }
        if (!row.active) run('DELETE FROM sessions WHERE user_id = :id', { id: p.id });
        const now = one('SELECT * FROM users WHERE id = :id', { id: p.id });
        const diff = permsDiff(before, effective(now));
        const groupsChanged = (old.group_ids || null) !== (now.group_ids || null);
        const roleChanged = (old.role_id || null) !== (now.role_id || null);
        log(ctx, 'user.update', username, null, {
          ...(diff.added.length || diff.removed.length ? diff : {}),
          ...(roleChanged ? { role: roleOf(now.role_id)?.name || null } : {}),
          ...(groupsChanged ? { groups: groupNames(parseGroups(now.group_ids)) } : {}),
          ...(!!old.is_admin !== !!now.is_admin ? { admin: !!now.is_admin } : {}),
          ...(old.username !== now.username ? { renamed: old.username } : {}),
          ...((old.full_name || '') !== (now.full_name || '') ? { name: [old.full_name || '', now.full_name || ''] } : {}),
          ...(!!old.active !== !!now.active ? { active: !!now.active } : {}),
          ...(p.password ? { password: true } : {}),
        });
        return { id: p.id };
      }
      if (String(p.password || '').length < 4) throw new AppError('PASSWORD_SHORT');
      const r = run(
        `INSERT INTO users (username, full_name, password_hash, is_admin, rights, role_id, group_ids, active, notify_actions)
         VALUES (:username, :fullName, :hash, :isAdmin, :rights, :roleId, :groupIds, :active, :notifyActions)`,
        { ...row, hash: hashPassword(p.password) }
      );
      const id = Number(r.lastInsertRowid);
      const made = one('SELECT * FROM users WHERE id = :id', { id });
      log(ctx, 'user.create', username, null, {
        added: made.is_admin ? [] : [...effective(made)],
        ...(made.role_id ? { role: roleOf(made.role_id)?.name || null } : {}),
        ...(made.group_ids ? { groups: groupNames(parseGroups(made.group_ids)) } : {}),
        ...(made.is_admin ? { admin: true } : {}),
      });
      // Creating the first admin turns sign-in on: sign this computer in with it straight away.
      if (first) {
        const token = crypto.randomBytes(32).toString('hex');
        run(`INSERT INTO sessions (token, user_id) VALUES (:token, :userId)`, { token, userId: id });
        return { id, token };
      }
      return { id };
    },

    'users.delete': ({ id }, ctx) => {
      const u = one('SELECT * FROM users WHERE id = :id', { id });
      if (!u) throw new AppError('NOT_FOUND');
      if (ctx.account?.id === u.id) throw new AppError('CANNOT_DELETE_SELF');
      if (u.is_admin && one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND active = 1 AND id != :id', { id }).n === 0)
        throw new AppError('LAST_ADMIN');
      run('DELETE FROM sessions WHERE user_id = :id', { id });
      run('DELETE FROM users WHERE id = :id', { id });
      log(ctx, 'user.delete', u.username);
      return true;
    },

    'roles.list': () =>
      all(
        `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.is_admin = 0) AS user_count
         FROM roles r ORDER BY r.name COLLATE NOCASE`
      ).map((r) => ({ id: r.id, name: r.name, perms: [...closePerms(rolePerms(r))], user_count: r.user_count })),

    // A role's ticks changed: everyone with that role gets the change (their own changes stay).
    'roles.save': (p, ctx) => {
      const name = String(p.name || '').trim();
      if (!name) throw new AppError('NAME_REQUIRED');
      const clash = all('SELECT id, name FROM roles WHERE id != :id', { id: p.id || 0 }).some((r) => r.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new AppError('NAME_TAKEN');
      const perms = JSON.stringify([...closePerms(list(p.perms))]);
      if (p.id) {
        const old = one('SELECT * FROM roles WHERE id = :id', { id: p.id });
        if (!old) throw new AppError('NOT_FOUND');
        run('UPDATE roles SET name = :name, perms = :perms WHERE id = :id', { id: p.id, name, perms });
        const diff = permsDiff(new Set(rolePerms(old)), new Set(list(JSON.parse(perms))));
        log(ctx, 'role.update', name, null, { ...diff, ...(old.name !== name ? { renamed: old.name } : {}) });
        return { id: p.id };
      }
      const r = run('INSERT INTO roles (name, perms) VALUES (:name, :perms)', { name, perms });
      log(ctx, 'role.create', name, null, { added: list(JSON.parse(perms)) });
      return { id: Number(r.lastInsertRowid) };
    },

    // Users of a deleted role keep exactly the ticks they had (as their own).
    'roles.delete': ({ id }, ctx) => {
      const role = one('SELECT * FROM roles WHERE id = :id', { id });
      if (!role) throw new AppError('NOT_FOUND');
      for (const u of all('SELECT * FROM users WHERE role_id = :id', { id }))
        run('UPDATE users SET role_id = NULL, rights = :rights WHERE id = :uid', {
          uid: u.id,
          rights: JSON.stringify({ v: 2, grant: [...effective(u)], deny: [] }),
        });
      run('DELETE FROM roles WHERE id = :id', { id });
      log(ctx, 'role.delete', role.name);
      return true;
    },
  };

  const groupNames = (ids) => (ids ? ids.map((g) => one('SELECT name FROM groups WHERE id = :g', { g })?.name || `#${g}`) : null);

  return { methods, check, filter, verify, has, PERSONAL_FIELDS };
}

module.exports = { createAuth, SECTIONS, ALL_PERMS, fromLegacy, parseRights, closePerms };
