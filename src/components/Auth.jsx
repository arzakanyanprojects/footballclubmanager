import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Shield, LogIn, UserPlus, Pencil, Trash2, KeyRound, ShieldCheck, Lock, ChevronDown, ChevronRight, Plus, Undo2, Users, Copy } from 'lucide-react';
import { useT } from '../i18n';
import { rpc, fmtDateTime, DataVersion } from '../lib';
import { Badge, BrandLogo, Button, Field, Loading, Modal, Segmented, useAction, useClub, useConfirm, useToast } from './ui';
import CATALOG from '../../electron/permissions.json';

// Every permission, by menu (the same list as electron/auth.js): «students.view», «payments.delete»…
export const PERM_SECTIONS = CATALOG.sections.map((s) => ({ id: s.id, perms: s.perms.map((p) => `${s.id}.${p}`) }));
export const ALL_PERMS = PERM_SECTIONS.flatMap((s) => s.perms);
const VIEW_PERMS = new Set(CATALOG.view);
// What a tick needs first: reports and settings ticks stand on their own; in the other menus, the menu's «view».
export const requiresOf = (perm) => {
  if (CATALOG.requires[perm]) return CATALOG.requires[perm];
  const [s, p] = perm.split('.');
  return s === 'reports' || s === 'settings' || p === 'view' ? [] : [`${s}.view`];
};
// Without the ticks whose requirement is missing.
export function closePerms(set) {
  const out = new Set(set);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of [...out])
      if (!requiresOf(p).every((r) => out.has(r))) {
        out.delete(p);
        changed = true;
      }
  }
  return out;
}
// A tick and everything it needs.
const withRequirements = (set, perm) => {
  const out = new Set(set);
  const add = (p) => {
    if (out.has(p)) return;
    out.add(p);
    requiresOf(p).forEach(add);
  };
  add(perm);
  return out;
};

const AuthCtx = createContext({ required: false, user: null, can: () => true, canAny: () => true, groups: null });
export const useAuth = () => useContext(AuthCtx);
// True when the signed-in user has this tick (always true while sign-in is off), e.g. useCan('payments.delete').
export const useCan = (perm) => useAuth().can(perm);

// Shows the sign-in screen when the club has users and this PC isn't signed in.
export function AuthGate({ children }) {
  const [state, setState] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setState(await rpc('auth.status'));
    } catch {
      setState({ required: false, user: null, error: true });
    }
  }, []);

  // × on the window: sign out (the app keeps running in the tray; opening it again asks for the sign-in).
  useEffect(
    () =>
      window.fc.onLogoutRequested?.(async () => {
        await rpc('auth.logout').catch(() => {});
        await window.fc.setAuthToken(null, false);
        await refresh();
      }),
    [refresh]
  );

  useEffect(() => {
    refresh();
    const lost = () => refresh();
    window.addEventListener('fc-auth-lost', lost);
    return () => window.removeEventListener('fc-auth-lost', lost);
  }, [refresh]);

  // Data changed on any computer (an admin may have changed this user's permissions): read them again.
  const version = useContext(DataVersion);
  useEffect(() => {
    if (!version) return;
    rpc('auth.status')
      .then((s) => setState((prev) => (JSON.stringify(prev) === JSON.stringify(s) ? prev : s)))
      .catch(() => {});
  }, [version]);

  if (!state) return <Loading />;
  if (state.required && !state.user) return <LoginScreen onDone={refresh} />;

  const user = state.user;
  const perms = new Set(user?.perms || []);
  const can = (perm) => !state.required || !!user?.is_admin || perms.has(perm);
  const value = {
    required: state.required,
    user,
    refresh,
    can,
    canAny: (...list) => list.some(can),
    // The groups this user works with (null: all).
    groups: state.required && !user?.is_admin ? user?.groups ?? null : null,
    signIn: async (token, remember) => {
      await window.fc.setAuthToken(token, remember);
      await refresh();
    },
    logout: async () => {
      await rpc('auth.logout').catch(() => {});
      await window.fc.setAuthToken(null, false);
      await refresh();
    },
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

function LoginScreen({ onDone }) {
  const t = useT();
  const club = useClub();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await rpc('auth.login', { username, password });
      await window.fc.setAuthToken(r.token, remember);
      onDone();
    } catch (err) {
      setError(err.code);
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <form className="card login-box" onSubmit={submit}>
        <div className="row" style={{ gap: 12, marginBottom: 6 }}>
          <BrandLogo size={46} />
          <div style={{ minWidth: 0 }}>
            <div className="strong">{club.club_name || 'FC Manager'}</div>
            <div className="small muted">{t('auth.signInTitle')}</div>
          </div>
        </div>
        <Field label={t('auth.username')}>
          <input className="input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label={t('auth.password')}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <label className="check small">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t('auth.remember')}
        </label>
        {error && <div className="small" style={{ color: 'var(--bad)' }}>{t(`error.${error}`) === `error.${error}` ? error : t(`error.${error}`)}</div>}
        <Button variant="primary" icon={LogIn} type="submit" disabled={busy || !username || !password}>
          {t('auth.signIn')}
        </Button>
        <div className="small muted">{t('auth.forgot')}</div>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ Settings → Users
export function UsersSettings() {
  const t = useT();
  const auth = useAuth();
  const act = useAction();
  const confirm = useConfirm();
  const [users, setUsers] = useState(null);
  const [roles, setRoles] = useState([]);
  const [groups, setGroups] = useState([]);
  const [editing, setEditing] = useState(null);
  const [editingRole, setEditingRole] = useState(null);

  const load = () => {
    rpc('users.list').then(setUsers).catch(() => setUsers([]));
    if (auth.required) {
      rpc('roles.list').then(setRoles).catch(() => setRoles([]));
      rpc('groups.list').then(setGroups).catch(() => setGroups([]));
    }
  };
  useEffect(() => {
    load();
  }, [auth.required]);

  const groupName = (id) => groups.find((g) => g.id === id)?.name || `#${id}`;

  if (!users) return <Loading />;
  return (
    <>
      {!auth.required && (
        <div className="card settings-section">
          <div className="card-head">
            <Lock size={17} />
            <h3>{t('users.offTitle')}</h3>
          </div>
          <div className="card-pad">
            <div className="small muted">{t('users.offText')}</div>
            <div className="row">
              <Button variant="primary" icon={ShieldCheck} onClick={() => setEditing({ first: true })}>
                {t('users.createAdmin')}
              </Button>
            </div>
          </div>
        </div>
      )}
      {auth.required && (
        <div className="card settings-section">
          <div className="card-head">
            <h3>{t('users.title')}</h3>
            <div className="spacer" />
            <Button size="sm" variant="primary" icon={UserPlus} onClick={() => setEditing({})}>
              {t('users.add')}
            </Button>
          </div>
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('users.name')}</th>
                  <th>{t('auth.username')}</th>
                  <th>{t('users.access')}</th>
                  <th>{t('users.lastLogin')}</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const own = (u.rights?.grant?.length || 0) + (u.rights?.deny?.length || 0);
                  return (
                    <tr key={u.id}>
                      <td className="strong">
                        {u.full_name || '—'} {!u.active && <Badge>{t('users.disabled')}</Badge>}
                      </td>
                      <td>{u.username}</td>
                      <td className="small">
                        {u.is_admin ? (
                          <Badge tone="good">{t('users.admin')}</Badge>
                        ) : (
                          <div className="stack" style={{ gap: 2 }}>
                            <div>
                              {u.role_name ? <Badge tone="info">{u.role_name}</Badge> : <span className="muted">{t('roles.none')}</span>}
                              {u.role_name && own > 0 && <span className="muted"> · {t('roles.ownChanges', { n: own })}</span>}
                              <span className="muted"> · {t('perm.count', { n: u.perms.length, total: ALL_PERMS.length })}</span>
                            </div>
                            {u.groups && (
                              <div className="muted">
                                {t('users.groupsOnly')}: {u.groups.map(groupName).join(', ') || '—'}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="small muted nowrap">{u.last_login_at ? fmtDateTime(u.last_login_at) : '—'}</td>
                      <td className="actions">
                        <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <Button size="sm" icon={Pencil} onClick={() => setEditing(u)}>
                            {t('common.edit')}
                          </Button>
                          {u.id !== auth.user?.id && (
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={Trash2}
                              onClick={async () => {
                                if (!(await confirm({ title: t('users.deleteTitle'), text: t('users.deleteText', { name: u.full_name || u.username }), confirmLabel: t('common.delete'), danger: true }))) return;
                                if (await act(() => rpc('users.delete', { id: u.id }), t('common.saved'))) load();
                              }}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {auth.required && (
        <div className="card settings-section">
          <div className="card-head">
            <Users size={17} />
            <h3>{t('roles.title')}</h3>
            <div className="spacer" />
            <Button size="sm" icon={Plus} onClick={() => setEditingRole({ name: '', perms: [] })}>
              {t('roles.add')}
            </Button>
          </div>
          <div className="card-pad" style={{ paddingBottom: 0 }}>
            <div className="small muted">{t('roles.text')}</div>
          </div>
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('roles.name')}</th>
                  <th>{t('roles.perms')}</th>
                  <th className="num">{t('roles.users')}</th>
                  <th className="actions" />
                </tr>
              </thead>
              <tbody>
                {roles.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted small">
                      {t('roles.empty')}
                    </td>
                  </tr>
                )}
                {roles.map((r) => (
                  <tr key={r.id}>
                    <td className="strong">{r.name}</td>
                    <td className="small muted">{sectionsSummary(t, new Set(r.perms))}</td>
                    <td className="num">{r.user_count}</td>
                    <td className="actions">
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <Button size="sm" icon={Pencil} onClick={() => setEditingRole(r)}>
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="ghost" icon={Copy} title={t('roles.copy')} onClick={() => setEditingRole({ name: `${r.name} 2`, perms: r.perms })} />
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Trash2}
                          title={t('common.delete')}
                          onClick={async () => {
                            if (!(await confirm({ title: t('roles.deleteTitle'), text: t('roles.deleteText', { name: r.name, n: r.user_count }), confirmLabel: t('common.delete'), danger: true }))) return;
                            if (await act(() => rpc('roles.delete', { id: r.id }), t('common.deleted'))) load();
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing && (
        <UserModal
          user={editing}
          roles={roles}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={async (r) => {
            setEditing(null);
            // The first admin signs this computer in straight away.
            if (r?.token) await auth.signIn(r.token, false);
            load();
          }}
        />
      )}
      {editingRole && (
        <RoleModal
          role={editingRole}
          onClose={() => setEditingRole(null)}
          onSaved={() => {
            setEditingRole(null);
            load();
          }}
        />
      )}
    </>
  );
}

// «Աշակերտներ 5/14 · Վճարումներ 3/15…» — the menus a set of ticks opens, with how many ticks in each.
function sectionsSummary(t, set) {
  const parts = PERM_SECTIONS.map((s) => [s, s.perms.filter((p) => set.has(p)).length])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${t(`users.section_${s.id}`)} ${n}/${s.perms.length}`);
  return parts.join(' · ') || '—';
}

function UserModal({ user, roles, groups, onClose, onSaved }) {
  const t = useT();
  const act = useAction();
  const isNew = !user.id;
  const [f, setF] = useState({
    full_name: user.full_name || '',
    username: user.username || (user.first ? 'admin' : ''),
    password: '',
    is_admin: user.first ? true : !!user.is_admin,
    active: user.active !== false,
    notify_actions: !!user.notify_actions,
    role_id: user.is_admin ? null : user.role_id || null,
  });
  const [perms, setPerms] = useState(() => new Set(user.is_admin ? [] : user.perms || []));
  const [scope, setScope] = useState(() => (user.groups ? new Set(user.groups) : null)); // null: all groups
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const role = roles.find((r) => r.id === Number(f.role_id)) || null;
  const base = useMemo(() => (role ? new Set(role.perms) : null), [role]);

  const pickRole = (id) => {
    const r = roles.find((x) => x.id === Number(id)) || null;
    setF({ ...f, role_id: r ? r.id : null });
    if (r) setPerms(new Set(r.perms)); // a new role: its ticks (the user's own changes start again)
  };

  const save = async () => {
    const r = await act(
      () =>
        rpc('users.save', {
          id: user.id,
          ...f,
          perms: [...perms],
          groups: scope ? [...scope] : null,
        }),
      t('common.saved')
    );
    if (r) onSaved(r);
  };

  return (
    <Modal
      title={user.first ? t('users.createAdmin') : isNew ? t('users.add') : f.full_name || f.username}
      onClose={onClose}
      width={f.is_admin ? 640 : 920}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!f.username.trim() || (isNew && f.password.length < 4) || (scope && scope.size === 0)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {user.first && <div className="small muted">{t('users.firstHint')}</div>}
        <div className="grid-3">
          <Field label={t('users.name')}>
            <input className="input" autoFocus value={f.full_name} onChange={set('full_name')} />
          </Field>
          <Field label={t('auth.username')}>
            <input className="input" value={f.username} onChange={set('username')} />
          </Field>
          <Field label={isNew ? t('auth.password') : t('users.newPassword')} hint={isNew ? t('users.passwordHint') : t('users.newPasswordHint')}>
            <input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
          </Field>
        </div>
        {!user.first && (
          <div className="row wrap" style={{ gap: 20 }}>
            <label className="check">
              <input type="checkbox" checked={f.is_admin} onChange={set('is_admin')} />
              <span className="strong">{t('users.admin')}</span>
            </label>
            {!isNew && (
              <label className="check">
                <input type="checkbox" checked={f.active} onChange={set('active')} />
                {t('users.active')}
              </label>
            )}
            <label className="check" title={t('users.notifyActionsHint')}>
              <input type="checkbox" checked={f.notify_actions} onChange={set('notify_actions')} />
              {t('users.notifyActions')}
            </label>
          </div>
        )}
        {f.is_admin ? (
          <div className="small muted">{t('users.adminHint')}</div>
        ) : (
          <>
            <div className="grid-2">
              <Field label={t('roles.role')} hint={t('roles.roleHint')}>
                <select className="select" value={f.role_id || ''} onChange={(e) => pickRole(e.target.value)}>
                  <option value="">{t('roles.none')}</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('users.groups')} hint={t('users.groupsHint')}>
                <Segmented
                  value={scope ? 'some' : 'all'}
                  onChange={(v) => setScope(v === 'all' ? null : new Set())}
                  options={[
                    { value: 'all', label: t('users.groupsAll') },
                    { value: 'some', label: t('users.groupsSome') },
                  ]}
                />
              </Field>
            </div>
            {scope && (
              <div className="perm-groups">
                {groups.filter((g) => !g.archived || scope.has(g.id)).map((g) => (
                  <label key={g.id} className={`check perm-chip ${scope.has(g.id) ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={scope.has(g.id)}
                      onChange={(e) => {
                        const n = new Set(scope);
                        e.target.checked ? n.add(g.id) : n.delete(g.id);
                        setScope(n);
                      }}
                    />
                    {g.name}
                  </label>
                ))}
                {scope.size === 0 && <div className="small" style={{ color: 'var(--bad)' }}>{t('users.groupsPick')}</div>}
              </div>
            )}
            <PermsEditor value={perms} onChange={setPerms} base={base} />
          </>
        )}
      </div>
    </Modal>
  );
}

function RoleModal({ role, onClose, onSaved }) {
  const t = useT();
  const act = useAction();
  const [name, setName] = useState(role.name || '');
  const [perms, setPerms] = useState(() => new Set(role.perms || []));
  const save = async () => {
    if (await act(() => rpc('roles.save', { id: role.id, name, perms: [...perms] }), t('common.saved'))) onSaved();
  };
  return (
    <Modal
      title={role.id ? role.name : t('roles.add')}
      onClose={onClose}
      width={920}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('roles.name')}>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {role.id > 0 && role.user_count > 0 && <div className="small muted" style={{ alignSelf: 'center' }}>{t('roles.usersHint', { n: role.user_count })}</div>}
        </div>
        <PermsEditor value={perms} onChange={setPerms} />
      </div>
    </Modal>
  );
}

// The ticks, menu by menu: each menu opens to its ticks, with «All / View only / None» and how many are on.
// base: the role's ticks — the user's own changes are marked, with «Back to the role».
export function PermsEditor({ value, onChange, base }) {
  const t = useT();
  const [open, setOpen] = useState(() => new Set());
  const toggleOpen = (id) =>
    setOpen((o) => {
      const n = new Set(o);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const tick = (perm, on) => onChange(on ? withRequirements(value, perm) : closePerms(new Set([...value].filter((p) => p !== perm))));
  const setSection = (sec, mode) => {
    const n = new Set([...value].filter((p) => !sec.perms.includes(p)));
    if (mode === 'all') sec.perms.forEach((p) => n.add(p));
    if (mode === 'view') sec.perms.filter((p) => VIEW_PERMS.has(p)).forEach((p) => n.add(p));
    onChange(closePerms(n));
  };
  const changed = base ? ALL_PERMS.filter((p) => value.has(p) !== base.has(p)) : [];
  const label = (p) => t(`perm.${p}`);
  const hint = (p) => {
    const h = t(`perm.${p}.hint`);
    return h === `perm.${p}.hint` ? '' : h;
  };

  return (
    <div className="perms">
      <div className="perms-head">
        <span className="small muted">{t('perm.title')}</span>
        <div className="spacer" />
        {base && changed.length > 0 && (
          <>
            <span className="small perm-changed-note">{t('roles.ownChanges', { n: changed.length })}</span>
            <Button size="sm" variant="ghost" icon={Undo2} onClick={() => onChange(new Set(base))}>
              {t('roles.backToRole')}
            </Button>
          </>
        )}
      </div>
      {PERM_SECTIONS.map((sec) => {
        const on = sec.perms.filter((p) => value.has(p)).length;
        const isOpen = open.has(sec.id);
        const secChanged = changed.some((p) => sec.perms.includes(p));
        return (
          <div key={sec.id} className={`perm-section ${isOpen ? 'open' : ''}`}>
            <div className="perm-section-head">
              <button type="button" className="perm-section-title" onClick={() => toggleOpen(sec.id)}>
                {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <span className="strong">{t(`users.section_${sec.id}`)}</span>
                <span className={`perm-count ${on === 0 ? 'none' : on === sec.perms.length ? 'all' : ''}`}>
                  {on}/{sec.perms.length}
                </span>
                {secChanged && <span className="perm-dot" title={t('roles.changedHere')} />}
              </button>
              <Segmented
                value={on === 0 ? 'none' : on === sec.perms.length ? 'all' : sec.perms.every((p) => value.has(p) === VIEW_PERMS.has(p)) ? 'view' : null}
                onChange={(v) => setSection(sec, v)}
                options={[
                  { value: 'none', label: t('perm.none') },
                  { value: 'view', label: t('perm.viewOnly') },
                  { value: 'all', label: t('perm.all') },
                ]}
              />
            </div>
            {isOpen && (
              <div className="perm-list">
                {sec.perms.map((p) => {
                  const needs = requiresOf(p).filter((r) => !value.has(r));
                  const diff = base && value.has(p) !== base.has(p);
                  return (
                    <label key={p} className={`perm-item ${needs.length ? 'blocked' : ''} ${diff ? 'changed' : ''}`} title={needs.length ? t('perm.needs', { what: needs.map(label).join(', ') }) : ''}>
                      <input type="checkbox" checked={value.has(p)} onChange={(e) => tick(p, e.target.checked)} />
                      <span>
                        <span className="perm-label">
                          {label(p)}
                          {diff && <span className="perm-dot" title={value.has(p) ? t('roles.addedHere') : t('roles.removedHere')} />}
                        </span>
                        {hint(p) && <span className="perm-hint">{hint(p)}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Settings → This computer: the signed-in user's own password.
export function MyAccount() {
  const t = useT();
  const auth = useAuth();
  const toast = useToast();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ current: '', next: '', again: '' });
  if (!auth.required || !auth.user) return null;
  const save = async () => {
    if (f.next !== f.again) return toast.error(t('users.passwordsDiffer'));
    if (await act(() => rpc('auth.changePassword', { current: f.current, next: f.next }), t('users.passwordChanged'))) {
      setOpen(false);
      setF({ current: '', next: '', again: '' });
    }
  };
  return (
    <div className="card settings-section">
      <div className="card-head">
        <KeyRound size={17} />
        <h3>{t('users.myAccount')}</h3>
      </div>
      <div className="card-pad">
        <div className="small">
          {auth.user.full_name || auth.user.username} · <span className="muted">{auth.user.username}</span>
          {auth.user.is_admin && <> · <Badge tone="good">{t('users.admin')}</Badge></>}
        </div>
        {open ? (
          <>
            <div className="grid-2">
              <Field label={t('users.currentPassword')}>
                <input className="input" type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
              </Field>
              <div />
              <Field label={t('users.newPassword')}>
                <input className="input" type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
              </Field>
              <Field label={t('users.repeatPassword')}>
                <input className="input" type="password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} />
              </Field>
            </div>
            <div className="row">
              <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
              <Button variant="primary" onClick={save} disabled={!f.current || f.next.length < 4}>
                {t('common.save')}
              </Button>
            </div>
          </>
        ) : (
          <div className="row">
            <Button icon={KeyRound} onClick={() => setOpen(true)}>
              {t('users.changePassword')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
