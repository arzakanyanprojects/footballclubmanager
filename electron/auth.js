// Users, sign-in and per-user rights. Enforced in service.call on the host PC, so it applies
// to every computer (the LAN server goes through the same call).
//
// Sign-in is off while there are no users. Once the first (admin) user exists, every request
// needs a valid session token.
const crypto = require('crypto');

// Menus a right can be given for, in the order the settings screen shows them.
const SECTIONS = ['students', 'payments', 'attendance', 'schedule', 'groups', 'contracts', 'reports', 'settings'];
const LEVEL = { none: 0, view: 1, edit: 2 };

// Which section a method belongs to. Reads need 'view', writes need 'edit'.
function sectionOf(method) {
  const [ns, name] = method.split('.');
  switch (ns) {
    case 'students':
    case 'files':
    case 'applications':
    case 'notes':
      return 'students';
    case 'charges':
    case 'products':
    case 'notify':
      return 'payments';
    case 'attendance':
    case 'training':
      return 'attendance';
    case 'groups':
      return 'groups';
    case 'schedule':
      return 'schedule';
    case 'contracts':
    case 'docTemplates':
      return 'contracts';
    case 'dashboard':
    case 'reports':
      return 'reports';
    case 'settings':
    case 'demo':
    case 'activity':
      return 'settings';
    default:
      return name ? 'settings' : null;
  }
}

// Reads other screens need too (pickers, names): allowed with view on any of these sections.
const SHARED_READS = {
  'groups.list': SECTIONS,
  'students.list': ['students', 'payments', 'attendance', 'contracts'],
  'students.get': ['students', 'payments', 'attendance', 'contracts'],
  'docTemplates.list': ['contracts', 'students'],
};
// Writes that only prepare data for viewing.
const VIEW_WRITES = new Set(['training.ensure', 'notify.messenger']);
// Open to anyone (the sign-in screen needs them).
const PUBLIC = new Set(['auth.status', 'auth.login', 'settings.get']);
// Open to anyone signed in.
const SELF = new Set(['auth.logout', 'auth.changePassword', 'locks.acquire', 'locks.heartbeat', 'locks.release', 'locks.list']);

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

// rights = { section: 'none' | 'view' | 'edit', excel: { section: true | false } } — excel: may export that
// menu's lists to Excel (on unless unticked, so users made before the tick keep it).
const normalizeRights = (r) => {
  const src = typeof r === 'string' ? safeJson(r) : r || {};
  const excel = src.excel && typeof src.excel === 'object' ? src.excel : {};
  return {
    ...Object.fromEntries(SECTIONS.map((s) => [s, LEVEL[src[s]] !== undefined ? src[s] : 'none'])),
    excel: Object.fromEntries(SECTIONS.map((s) => [s, excel[s] !== false])),
  };
};
const safeJson = (s) => {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
};

function createAuth({ all, one, run, AppError, log }) {
  const userCount = () => one('SELECT COUNT(*) AS n FROM users WHERE active = 1').n;

  const publicUser = (u) =>
    u && {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      is_admin: !!u.is_admin,
      active: !!u.active,
      notify_actions: !!u.notify_actions,
      rights: u.is_admin
        ? { ...Object.fromEntries(SECTIONS.map((s) => [s, 'edit'])), excel: Object.fromEntries(SECTIONS.map((s) => [s, true])) }
        : normalizeRights(u.rights),
      last_login_at: u.last_login_at,
      created_at: u.created_at,
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

  const can = (user, section, need) => !!user && (user.is_admin || LEVEL[user.rights[section]] >= LEVEL[need]);

  // Returns { error } or { ctx } with ctx.account (the signed-in user) and ctx.user (name for the activity log).
  function check(method, write, ctx) {
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
    if (method.startsWith('users.')) return { error: 'FORBIDDEN' };
    const need = write && !VIEW_WRITES.has(method) ? 'edit' : 'view';
    if (!write && SHARED_READS[method] && SHARED_READS[method].some((s) => can(account, s, 'view'))) return { ctx: next };
    const section = sectionOf(method);
    if (!section || !can(account, section, need)) return { error: 'FORBIDDEN' };
    return { ctx: next };
  }

  // Removes parts of a result the user may not see.
  function filter(method, result, ctx) {
    const a = ctx.account;
    if (!a || a.is_admin || !result) return result;
    if (method === 'students.get') {
      const r = { ...result };
      if (!can(a, 'payments', 'view')) r.charges = [];
      if (!can(a, 'attendance', 'view')) {
        r.attendance = [];
        r.attendanceStats = null;
      }
      if (!can(a, 'contracts', 'view')) r.contracts = [];
      return r;
    }
    if (method === 'students.history') {
      return result.filter(
        (e) =>
          (!e.action.startsWith('charge.') || can(a, 'payments', 'view')) &&
          (!e.action.startsWith('attendance.') || can(a, 'attendance', 'view')) &&
          (!e.action.startsWith('contract.') || can(a, 'contracts', 'view'))
      );
    }
    if (method === 'training.month' && !can(a, 'payments', 'view')) {
      return { ...result, students: (result.students || []).map((s) => ({ ...s, unpaid: 0, overdue: 0 })) };
    }
    if (method === 'students.list' && !can(a, 'payments', 'view')) {
      return result.map((s) => ({ ...s, months: [], overdue: 0, unpaid: 0 }));
    }
    return result;
  }

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

    'users.save': (p, ctx) => {
      const username = String(p.username || '').trim();
      if (!username) throw new AppError('USERNAME_REQUIRED');
      const clash = one('SELECT id FROM users WHERE username = :username COLLATE NOCASE AND id != :id', { username, id: p.id || 0 });
      if (clash) throw new AppError('USERNAME_TAKEN');
      const first = userCount() === 0;
      const row = {
        id: p.id || null,
        username,
        fullName: String(p.full_name || '').trim() || null,
        isAdmin: first ? 1 : p.is_admin ? 1 : 0, // the first user is always an admin
        rights: JSON.stringify(normalizeRights(p.rights)),
        active: first ? 1 : p.active === false ? 0 : 1,
        notifyActions: p.notify_actions ? 1 : 0,
      };
      if (p.id) {
        // Never leave the club without an active admin.
        if ((!row.isAdmin || !row.active) && one('SELECT is_admin, active FROM users WHERE id = :id', { id: p.id })?.is_admin) {
          const others = one('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND active = 1 AND id != :id', { id: p.id }).n;
          if (others === 0) throw new AppError('LAST_ADMIN');
        }
        run(
          `UPDATE users SET username = :username, full_name = :fullName, is_admin = :isAdmin, rights = :rights, active = :active,
                  notify_actions = :notifyActions WHERE id = :id`,
          row
        );
        if (p.password) {
          if (String(p.password).length < 4) throw new AppError('PASSWORD_SHORT');
          run('UPDATE users SET password_hash = :hash WHERE id = :id', { id: p.id, hash: hashPassword(p.password) });
          run('DELETE FROM sessions WHERE user_id = :id', { id: p.id }); // sign out everywhere
        }
        if (!row.active) run('DELETE FROM sessions WHERE user_id = :id', { id: p.id });
        log(ctx, 'user.update', username);
        return { id: p.id };
      }
      if (String(p.password || '').length < 4) throw new AppError('PASSWORD_SHORT');
      const r = run(
        `INSERT INTO users (username, full_name, password_hash, is_admin, rights, active, notify_actions)
         VALUES (:username, :fullName, :hash, :isAdmin, :rights, :active, :notifyActions)`,
        { ...row, hash: hashPassword(p.password) }
      );
      const id = Number(r.lastInsertRowid);
      log(ctx, 'user.create', username);
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
  };

  return { methods, check, filter };
}

module.exports = { createAuth, SECTIONS };
