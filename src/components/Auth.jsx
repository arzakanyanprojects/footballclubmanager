import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Shield, LogIn, UserPlus, Pencil, Trash2, KeyRound, ShieldCheck, Lock } from 'lucide-react';
import { useT } from '../i18n';
import { rpc, fmtDateTime } from '../lib';
import { Badge, BrandLogo, Button, Field, Loading, Modal, Segmented, useAction, useClub, useConfirm, useToast } from './ui';

// Menus a right can be given for (same list as electron/auth.js).
export const SECTIONS = ['students', 'payments', 'attendance', 'schedule', 'groups', 'contracts', 'reports', 'settings'];
const LEVEL = { none: 0, view: 1, edit: 2 };

const AuthCtx = createContext({ required: false, user: null, can: () => true });
export const useAuth = () => useContext(AuthCtx);
// True when the signed-in user may do this (always true while sign-in is off).
export const useCan = (section, level = 'edit') => useAuth().can(section, level);

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

  if (!state) return <Loading />;
  if (state.required && !state.user) return <LoginScreen onDone={refresh} />;

  const user = state.user;
  const value = {
    required: state.required,
    user,
    refresh,
    can: (section, level = 'edit') => !state.required || !!user?.is_admin || LEVEL[user?.rights?.[section]] >= LEVEL[level],
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
  const [editing, setEditing] = useState(null);

  const load = () => rpc('users.list').then(setUsers).catch(() => setUsers([]));
  useEffect(() => {
    load();
  }, []);

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
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="strong">
                      {u.full_name || '—'} {!u.active && <Badge>{t('users.disabled')}</Badge>}
                    </td>
                    <td>{u.username}</td>
                    <td className="small">
                      {u.is_admin ? (
                        <Badge tone="good">{t('users.admin')}</Badge>
                      ) : (
                        SECTIONS.filter((s) => u.rights[s] !== 'none')
                          .map((s) => `${t(`users.section_${s}`)}${u.rights[s] === 'view' ? ` (${t('users.viewShort')})` : ''}`)
                          .join(', ') || <span className="muted">—</span>
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
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing && (
        <UserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={async (r) => {
            setEditing(null);
            // The first admin signs this computer in straight away.
            if (r?.token) await auth.signIn(r.token, false);
            load();
          }}
        />
      )}
    </>
  );
}

const NO_RIGHTS = Object.fromEntries(SECTIONS.map((s) => [s, 'none']));

function UserModal({ user, onClose, onSaved }) {
  const t = useT();
  const act = useAction();
  const isNew = !user.id;
  const [f, setF] = useState({
    full_name: user.full_name || '',
    username: user.username || (user.first ? 'admin' : ''),
    password: '',
    is_admin: user.first ? true : !!user.is_admin,
    active: user.active !== false,
    rights: { ...NO_RIGHTS, ...(user.is_admin ? {} : user.rights || {}) },
  });
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const setRight = (s, v) => setF({ ...f, rights: { ...f.rights, [s]: v } });

  const save = async () => {
    const r = await act(() => rpc('users.save', { id: user.id, ...f }), t('common.saved'));
    if (r) onSaved(r);
  };

  return (
    <Modal
      title={user.first ? t('users.createAdmin') : isNew ? t('users.add') : f.full_name || f.username}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!f.username.trim() || (isNew && f.password.length < 4)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {user.first && <div className="small muted">{t('users.firstHint')}</div>}
        <div className="grid-2">
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
          </div>
        )}
        {f.is_admin ? (
          <div className="small muted">{t('users.adminHint')}</div>
        ) : (
          <div className="rights">
            <div className="small muted" style={{ marginBottom: 4 }}>{t('users.rightsHint')}</div>
            {SECTIONS.map((s) => (
              <div key={s} className="rights-row">
                <span>{t(`users.section_${s}`)}</span>
                <Segmented
                  value={f.rights[s]}
                  onChange={(v) => setRight(s, v)}
                  options={['none', 'view', 'edit'].map((v) => ({ value: v, label: t(`users.level_${v}`) }))}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
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
