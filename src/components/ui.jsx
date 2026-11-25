import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle2, AlertCircle, Search, Inbox, MoreHorizontal, Shield, Minus, CircleX } from 'lucide-react';
import { avatarColor, money, rpc } from '../lib';
import { useT } from '../i18n';

export function Button({ variant, size, icon: Icon, children, className = '', ...rest }) {
  const cls = ['btn', variant, size, !children && Icon ? 'icon' : '', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 15 : 16} />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <div className={`field ${className}`}>
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

// lock: from useEditLock — shows who is editing, and makes the form read-only while someone else is.
const minimizeLabel = () => (document.documentElement.lang === 'en' ? 'Minimize' : 'Փոքրացնել');
// onMinimize: a «minimize» button; hidden: minimized — not shown, but everything in it is kept.
export function Modal({ title, onClose, children, footer, width = 560, lock, onMinimize, hidden }) {
  useEffect(() => {
    if (hidden) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, hidden]);
  return (
    <div className="overlay" style={hidden ? { display: 'none' } : undefined} onMouseDown={(e) => e.target === e.currentTarget && !onMinimize && onClose?.()}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          {onMinimize && <Button variant="ghost" size="sm" icon={Minus} onClick={onMinimize} aria-label="Minimize" title={minimizeLabel()} />}
          <Button variant="ghost" size="sm" icon={X} onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">
          {lock?.banner}
          {lock?.readOnly ? (
            <fieldset disabled className="lock-fieldset">
              {children}
            </fieldset>
          ) : (
            children
          )}
        </div>
        {footer && <div className={`modal-foot ${lock?.readOnly ? 'locked' : ''}`}>{footer}</div>}
      </div>
    </div>
  );
}

export function Badge({ tone, children }) {
  return <span className={`badge ${tone || ''}`}>{children}</span>;
}

export function Empty({ icon: Icon = Inbox, title, text, action }) {
  return (
    <div className="empty">
      <div className="icon">
        <Icon size={24} />
      </div>
      {title && <h4>{title}</h4>}
      {text && <div className="small">{text}</div>}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  );
}

export const Loading = () => (
  <div className="loading">
    <div className="spinner" />
  </div>
);

export function Avatar({ first = '', last = '', photo, size = 34, seed }) {
  const initials = `${first[0] || ''}${last[0] || ''}`.toUpperCase();
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: photo ? 'transparent' : avatarColor(seed ?? first + last) }}>
      {photo ? <img src={photo} alt="" /> : initials}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder, width }) {
  const t = useT();
  const input = useRef(null);
  return (
    <div className={`search${value ? ' has-value' : ''}`} style={width ? { width } : undefined}>
      <Search size={16} />
      <input ref={input} className="input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button
          type="button"
          className="search-clear"
          title={t('search.clear')}
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          <CircleX size={17} />
        </button>
      )}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.icon && <t.icon size={16} />}
          {t.label}
          {t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value ?? 'all'} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Money({ value, currency, className = '' }) {
  const { currency: cur } = useClub();
  return <span className={`num nowrap ${className}`}>{money(value, currency || cur)}</span>;
}

// Dropdown of row actions ("…" button).
export function RowMenu({ items }) {
  const [pos, setPos] = useState(null); // where the open menu is drawn; null when closed
  const ref = useRef(null);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e) => !ref.current?.contains(e.target) && !menuRef.current?.contains(e.target) && setPos(null);
    const hide = () => setPos(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', hide, true);
    };
  }, [pos]);
  const visible = items.filter(Boolean);
  if (!visible.length) return null;

  // Drawn on top of the whole window (a portal into <body>), so no table, card or transform can clip
  // or shift it; opens upwards near the bottom.
  const toggle = (e) => {
    if (pos) return setPos(null);
    const r = e.currentTarget.getBoundingClientRect();
    const up = r.bottom + 40 * visible.length + 20 > window.innerHeight;
    setPos({
      right: window.innerWidth - r.right,
      ...(up ? { top: 'auto', bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4, bottom: 'auto' }),
    });
  };
  const open = !!pos;
  return (
    <div className="rel" ref={ref} onClick={(e) => e.stopPropagation()}>
      <Button variant="ghost" size="sm" icon={MoreHorizontal} onClick={toggle} />
      {open &&
        createPortal(
        <div className="menu" ref={menuRef} style={{ position: 'fixed', left: 'auto', ...pos }} onClick={(e) => e.stopPropagation()}>
          {visible.map((it, i) =>
            it === '-' ? (
              <hr key={i} />
            ) : (
              <button
                key={i}
                className={it.danger ? 'danger' : ''}
                onClick={() => {
                  setPos(null);
                  it.onClick();
                }}
              >
                {it.icon && <it.icon size={15} />}
                {it.label}
              </button>
            )
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

// Searchable student selector.
export function StudentPicker({ value, onChange, autoFocus }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [list, setList] = useState([]);
  const [hl, setHl] = useState(0);
  const ref = useRef(null);

  useEffect(() => {
    rpc('students.list', { status: 'active' }).then(setList).catch(() => {});
  }, []);
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  const selected = list.find((s) => s.id === value);
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return list.filter((s) => !n || `${s.first_name} ${s.last_name} ${s.last_name} ${s.first_name}`.toLowerCase().includes(n)).slice(0, 50);
  }, [q, list]);

  const pick = (s) => {
    onChange(s.id, s);
    setQ('');
    setOpen(false);
  };

  return (
    <div className="rel" ref={ref}>
      <input
        className="input"
        autoFocus={autoFocus}
        placeholder={t('common.searchStudent')}
        value={open ? q : selected ? `${selected.first_name} ${selected.last_name}` : q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setHl(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHl((h) => Math.min(h + 1, filtered.length - 1));
          else if (e.key === 'ArrowUp') setHl((h) => Math.max(h - 1, 0));
          else if (e.key === 'Enter' && filtered[hl]) {
            e.preventDefault();
            pick(filtered[hl]);
          }
        }}
      />
      {open && (
        <div className="dropdown">
          {filtered.length === 0 && <div className="opt muted">{t('common.noResults')}</div>}
          {filtered.map((s, i) => (
            <div key={s.id} className={`opt ${i === hl ? 'hl' : ''}`} onMouseDown={() => pick(s)} onMouseEnter={() => setHl(i)}>
              <Avatar first={s.first_name} last={s.last_name} size={26} seed={s.id} />
              <div className="grow">
                {s.first_name} {s.last_name}
                <div className="small muted">{s.group_name || t('students.noGroup')}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ toasts & confirm
const ToastCtx = createContext(null);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((tone, text) => {
    const id = Math.random();
    setItems((l) => [...l, { id, tone, text }]);
    setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), tone === 'bad' ? 6000 : 3000);
  }, []);
  const api = useMemo(() => ({ success: (t) => push('good', t), error: (t) => push('bad', t) }), [push]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts">
        {items.map((x) => (
          <div key={x.id} className={`toast ${x.tone}`}>
            {x.tone === 'good' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <div>{x.text}</div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

const ConfirmCtx = createContext(null);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }) {
  const t = useT();
  const [req, setReq] = useState(null);
  const confirm = useCallback(
    (opts) => new Promise((resolve) => setReq({ ...(typeof opts === 'string' ? { text: opts } : opts), resolve })),
    []
  );
  const done = (v) => {
    req.resolve(v);
    setReq(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {req && (
        <Modal
          title={req.title || t('common.areYouSure')}
          onClose={() => done(false)}
          width={440}
          footer={
            <>
              <Button onClick={() => done(false)}>{t('common.cancel')}</Button>
              <Button variant={req.danger === false ? 'primary' : 'danger-solid'} onClick={() => done(true)} autoFocus>
                {req.confirmLabel || t('common.confirm')}
              </Button>
            </>
          }
        >
          <div style={{ color: 'var(--text-2)' }}>{req.text}</div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

// ------------------------------------------------------------------ club settings context
export const ClubCtx = createContext({ currency: 'AMD', club_name: '' });
export const useClub = () => useContext(ClubCtx);

// The club's logo (Settings → Club), or the default shield.
export function BrandLogo({ size = 36, logo }) {
  const club = useClub();
  const src = logo !== undefined ? logo : club?.club_logo;
  const radius = Math.round(size * 0.28);
  if (src) return <img className="brand-img" src={src} alt="" style={{ width: size, height: size, borderRadius: radius }} />;
  return (
    <div className="brand-logo" style={{ width: size, height: size, borderRadius: radius }}>
      <Shield size={Math.round(size * 0.55)} />
    </div>
  );
}

// Runs an async action, reporting translated errors as toasts.
export function useAction() {
  const t = useT();
  const toast = useToast();
  return useCallback(
    async (fn, successText) => {
      try {
        const r = await fn();
        if (successText) toast.success(successText);
        return r ?? true;
      } catch (err) {
        if (err?.code === 'CANCELLED') return false;
        const key = `error.${err?.code || 'INTERNAL'}`;
        // Errors with details (e.g. «LOCKED»: who is editing) fill them into the message.
        const msg = t(key, err?.detail && typeof err.detail === 'object' ? err.detail : undefined);
        toast.error(msg === key ? err?.detail || err?.message || t('error.INTERNAL') : err?.showDetail && err?.detail ? `${msg} ${err.detail}` : msg);
        return false;
      }
    },
    [t, toast]
  );
}
