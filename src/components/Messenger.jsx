// WhatsApp / Viber messages to parents, sent by a person from the apps installed on this PC:
// the app writes the message (a payment reminder, a payment confirmation or a free message) from the
// club's templates, opens the parent's chat, and the staff member presses Send.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, MessageCircle, RotateCcw, X } from 'lucide-react';
import { useT, useLang, monthName } from '../i18n';
import { rpc, money, todayIso, currentPeriod, fmtDate } from '../lib';
import { useCan } from './Auth';
import { Button, Field, Loading, Modal, Segmented, useClub, useToast } from './ui';

export const MESSAGE_KINDS = ['reminder', 'receipt', 'free'];
const DEFAULTS = {
  hy: {
    reminder: 'Բարև Ձեզ, {parent}։\nՀիշեցնում ենք, որ {student}-ի վճարը դեռ կատարված չէ՝ {months} ({amount})։\nԽնդրում ենք կատարել վճարումը։\nՀարգանքով՝ {club}',
    receipt: 'Բարև Ձեզ, {parent}։\nՍտացել ենք {student}-ի վճարումը՝ {amount} ({months})։\nՇնորհակալություն։\n{club}',
    free: 'Բարև Ձեզ, {parent}։\n\n{club}',
  },
  en: {
    reminder: 'Hello {parent},\nThis is a reminder that the payment for {student} is not made yet: {months} ({amount}).\nPlease make the payment.\nKind regards, {club}',
    receipt: 'Hello {parent},\nWe have received the payment for {student}: {amount} ({months}).\nThank you!\n{club}',
    free: 'Hello {parent},\n\n{club}',
  },
};
export const defaultTemplate = (lang, kind) => (DEFAULTS[lang] || DEFAULTS.hy)[kind];
const templateOf = (club, lang, kind) => (club?.[`msg_${kind}`] || '').trim() || defaultTemplate(lang, kind);

// 091 23 45 67 / +374 91 234567 / 0037491… → 37491234567
export function phoneDigits(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9 && d.startsWith('0')) d = `374${d.slice(1)}`;
  if (d.length === 8) d = `374${d}`;
  return d.length >= 10 ? d : '';
}

// The charges a message is about: unpaid ones that are overdue (or due this month), or the last payment.
function chargesFor(kind, charges) {
  const today = todayIso();
  if (kind === 'reminder') {
    const unpaid = charges.filter((c) => c.status === 'unpaid');
    const overdue = unpaid.filter((c) => c.due_date && c.due_date < today);
    return (overdue.length ? overdue : unpaid.filter((c) => !c.period || c.period <= currentPeriod())).sort((a, b) =>
      String(a.period || a.due_date).localeCompare(String(b.period || b.due_date))
    );
  }
  if (kind === 'receipt') {
    const paid = charges.filter((c) => c.status === 'paid' && c.paid_at);
    const last = paid.reduce((m, c) => (c.paid_at > m ? c.paid_at : m), '');
    return paid.filter((c) => c.paid_at === last).sort((a, b) => String(a.period).localeCompare(String(b.period)));
  }
  return [];
}

export function buildMessage(t, lang, club, kind, student, charges) {
  const list = chargesFor(kind, charges || []);
  const parent = student.parent_first_name || String(student.parent_name || '').trim().split(/\s+/)[0] || '';
  const vars = {
    parent,
    student: [student.first_name, student.last_name].filter(Boolean).join(' '),
    months: list.map((c) => (c.kind === 'monthly' && c.period ? monthName(t, c.period) : c.description || t(`charge.${c.kind}`))).join(', '),
    amount: money(list.reduce((s, c) => s + Number(c.amount || 0), 0), club?.currency),
    date: list[0]?.paid_at ? fmtDate(list[0].paid_at) : fmtDate(todayIso()),
    club: club?.club_name || '',
    clubPhone: club?.club_phone || '',
  };
  let tpl = templateOf(club, lang, kind);
  // Parent's name unknown: «Բարև Ձեզ, {parent}։» → «Բարև Ձեզ։», «Hello {parent},» → «Hello,»
  if (!parent) tpl = tpl.replace(/[ \t]*,?[ \t]*\{parent\}/g, '');
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).replace(/[ \t]+\n/g, '\n');
}

// ---------------------------------------------------------------- the send window
// students: ids to go through (one, or e.g. all debtors with «Հաջորդը»).
function MessengerModal({ studentIds, kind: firstKind, onClose }) {
  const t = useT();
  const lang = useLang();
  const club = useClub();
  const toast = useToast();
  const [i, setI] = useState(0);
  const [kind, setKind] = useState(firstKind || 'reminder');
  const [data, setData] = useState(null); // students.get
  const [text, setText] = useState('');
  const [sent, setSent] = useState({}); // index → channel
  const id = studentIds[i];

  useEffect(() => {
    let live = true;
    setData(null);
    rpc('students.get', { id })
      .then((r) => live && setData(r))
      .catch(() => live && setData({ error: true }));
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    if (data?.student) setText(buildMessage(t, lang, club, kind, data.student, data.charges));
  }, [data, kind]);

  const s = data?.student;
  const phone = s ? phoneDigits(s.parent_phone || s.phone) : '';
  const open = async (app) => {
    const r = await window.fc.openMessenger({ app, phone, text });
    if (!r?.ok) {
      const key = `error.${r?.error || 'MESSENGER_FAILED'}`;
      toast.error(t(key) === key ? r?.detail || r?.error : t(key));
      return;
    }
    if (r.copied) toast.success(t('messenger.copied'));
    else if (r.via === 'web') toast.success(t('messenger.web'));
    setSent((x) => ({ ...x, [i]: app }));
    rpc('notify.messenger', { studentId: id, channel: app, kind }).catch(() => {});
  };
  const last = i >= studentIds.length - 1;
  const next = () => (last ? onClose() : setI(i + 1));

  return (
    <Modal
      title={s ? t('messenger.titleFor', { name: `${s.first_name} ${s.last_name}` }) : t('messenger.title')}
      onClose={onClose}
      width={600}
      footer={
        <>
          {studentIds.length > 1 && (
            <span className="left small muted">
              {i + 1} / {studentIds.length}
            </span>
          )}
          <Button className="btn-whatsapp" disabled={!phone || !text.trim()} onClick={() => open('whatsapp')}>
            WhatsApp
          </Button>
          <Button className="btn-viber" disabled={!phone || !text.trim()} onClick={() => open('viber')}>
            Viber
          </Button>
          {studentIds.length > 1 ? (
            <Button variant="primary" icon={ChevronRight} onClick={next}>
              {last ? t('hdm.done') : sent[i] ? t('messenger.next') : t('messenger.skip')}
            </Button>
          ) : (
            <Button onClick={onClose}>{t('common.close')}</Button>
          )}
        </>
      }
    >
      {!data ? (
        <Loading />
      ) : data.error ? (
        <div className="small" style={{ color: 'var(--bad)' }}>{t('error.NOT_FOUND')}</div>
      ) : (
        <div className="stack">
          <Segmented value={kind} onChange={setKind} options={MESSAGE_KINDS.map((k) => ({ value: k, label: t(`messenger.kind_${k}`) }))} />
          <div className="row small">
            <span className="muted">{t('messenger.to')}:</span>
            <span className="strong">{s.parent_name || '—'}</span>
            {phone ? <span className="num">+{phone}</span> : <span style={{ color: 'var(--bad)' }}>{t('messenger.noPhone')}</span>}
            {sent[i] && <span className="badge good">✓ {sent[i] === 'viber' ? 'Viber' : 'WhatsApp'}</span>}
          </div>
          <textarea className="textarea" rows={7} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="small muted">{t('messenger.hint')}</div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- provider + buttons
const Ctx = createContext(null);
export const useMessenger = () => useContext(Ctx);

export function MessengerProvider({ children }) {
  const t = useT();
  const canPay = useCan('payments', 'view');
  const [modal, setModal] = useState(null); // { studentIds, kind }
  const [offer, setOffer] = useState(null); // { studentId, name } after a payment
  const timer = useRef(null);
  const open = useCallback((studentIds, kind) => {
    const ids = (Array.isArray(studentIds) ? studentIds : [studentIds]).filter(Boolean);
    if (ids.length) setModal({ studentIds: ids, kind });
  }, []);
  // After a payment: a small card in the corner offers the confirmation (never in the way).
  const afterPayment = useCallback(
    (studentId, name) => {
      if (!canPay || !studentId) return;
      clearTimeout(timer.current);
      setOffer({ studentId, name });
      timer.current = setTimeout(() => setOffer(null), 20000);
    },
    [canPay]
  );
  const api = useMemo(() => ({ open, afterPayment }), [open, afterPayment]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {offer && (
        <div className="messenger-offer">
          <MessageCircle size={18} />
          <div className="grow">
            <div className="strong">{t('messenger.offerTitle')}</div>
            <div className="small muted">{offer.name}</div>
          </div>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              open([offer.studentId], 'receipt');
              setOffer(null);
            }}
          >
            {t('messenger.offerSend')}
          </Button>
          <Button size="sm" variant="ghost" icon={X} onClick={() => setOffer(null)} aria-label="Close" />
        </div>
      )}
      {modal && <MessengerModal key={modal.studentIds.join(',')} studentIds={modal.studentIds} kind={modal.kind} onClose={() => setModal(null)} />}
    </Ctx.Provider>
  );
}

// «Ուղարկել ծնողին» — opens the send window for one student (or several, e.g. debtors).
export function MessageButton({ studentIds, kind = 'reminder', size = 'sm', label, variant }) {
  const t = useT();
  const m = useMessenger();
  if (!m) return null;
  return (
    <Button
      size={size}
      variant={variant}
      icon={MessageCircle}
      onClick={(e) => {
        e.stopPropagation();
        m.open(studentIds, kind);
      }}
      title={t('messenger.button')}
    >
      {label === undefined ? t('messenger.button') : label}
    </Button>
  );
}

// ---------------------------------------------------------------- Settings → Notifications: the texts
export function MessengerTemplates({ bare = false }) {
  const t = useT();
  const lang = useLang();
  const club = useClub();
  const toast = useToast();
  const canEdit = useCan('settings');
  const [f, setF] = useState(() => Object.fromEntries(MESSAGE_KINDS.map((k) => [k, templateOf(club, lang, k)])));
  const [dirty, setDirty] = useState(false);
  const save = async () => {
    try {
      await rpc('settings.update', Object.fromEntries(MESSAGE_KINDS.map((k) => [`msg_${k}`, f[k] === defaultTemplate(lang, k) ? '' : f[k]])));
      toast.success(t('common.saved'));
      setDirty(false);
    } catch (err) {
      toast.error(t(`error.${err.code}`, err.detail));
    }
  };
  const body = (
      <div className={bare ? 'stack' : 'card-pad stack'}>
        {!bare && <div className="small muted">{t('messenger.settingsHint')}</div>}
        <div className="small muted">{t('messenger.placeholders')}</div>
        {MESSAGE_KINDS.map((k) => (
          <Field key={k} label={t(`messenger.kind_${k}`)}>
            <textarea
              className="textarea"
              rows={5}
              value={f[k]}
              disabled={!canEdit}
              onChange={(e) => {
                setF({ ...f, [k]: e.target.value });
                setDirty(true);
              }}
            />
          </Field>
        ))}
        {canEdit && (
          <div className="row">
            <Button
              size="sm"
              icon={RotateCcw}
              onClick={() => {
                setF(Object.fromEntries(MESSAGE_KINDS.map((k) => [k, defaultTemplate(lang, k)])));
                setDirty(true);
              }}
            >
              {t('notify.resetTemplates')}
            </Button>
            <div className="grow" />
            <Button variant="primary" onClick={save} disabled={!dirty}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </div>
  );
  if (bare) return body;
  return (
    <div className="card settings-section">
      <div className="card-head">
        <MessageCircle size={17} />
        <h3>{t('messenger.settingsTitle')}</h3>
      </div>
      {body}
    </div>
  );
}
