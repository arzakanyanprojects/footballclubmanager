import { useEffect, useState } from 'react';
import { Mail, Send, Users, Megaphone, History, Save, RefreshCw, RotateCcw, Search, CheckCircle2, BellRing, FileText, CalendarClock, UserCheck, Workflow, AtSign, MessageCircle } from 'lucide-react';
import { useT } from '../i18n';
import { rpc, useRpc, fmtDateTime } from '../lib';
import { Badge, Button, Field, Loading, useAction, useConfirm, useToast } from './ui';
import { useCan } from './Auth';
import { MessengerTemplates } from './Messenger';

const ok = (r) => {
  if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail, showDetail: true });
  return r.result;
};

// Settings → Notifications. Channels and schedules live on the main (host) PC, which sends everything.
export function NotifySettings() {
  const t = useT();
  const toast = useToast();
  const act = useAction();
  const canEdit = useCan('settings.notify');
  const [state, setState] = useState(null);
  const [f, setF] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [showTpl, setShowTpl] = useState(false);
  const [showMsg, setShowMsg] = useState(false);
  const messengerCard = (
    <OptCard icon={MessageCircle} title={t('messenger.settingsTitle')} text={t('messenger.settingsHint')} className={showMsg ? 'span-all' : ''}>
      <div className="row">
        <Button variant={showMsg ? 'ghost' : undefined} onClick={() => setShowMsg((v) => !v)}>
          {t(showMsg ? 'notify.hideTemplates' : 'notify.editMessages')}
        </Button>
      </div>
      {showMsg && <MessengerTemplates bare />}
    </OptCard>
  );

  useEffect(() => {
    window.fc.notify.get().then((s) => {
      setState(s);
      setF(s.config);
    });
  }, []);

  if (!state) return <Loading />;
  if (!state.isHost)
    return (
      <>
        <div className="card settings-section">
          <div className="card-pad small muted">{t('notify.clientNote')}</div>
        </div>
        <div className="opt-grid" style={{ marginBottom: 18 }}>{messengerCard}</div>
        <Outbox />
      </>
    );

  const dirty = JSON.stringify(f) !== JSON.stringify(state.config);
  const set = (path, value) => {
    const [a, b] = path.split('.');
    setF((x) => (b ? { ...x, [a]: { ...x[a], [b]: value } } : { ...x, [a]: value }));
  };
  const save = async (quiet) => {
    const s = await window.fc.notify.set(f);
    setState(s);
    setF(s.config);
    if (!quiet) toast.success(t('common.saved'));
    return s;
  };
  const tpl = { ...state.defaults, ...(f.templates || {}) };
  const setTpl = (k, v) => setF((x) => ({ ...x, templates: { ...(x.templates || {}), [k]: v } }));
  const e = f.email;
  const tg = f.telegram;
  const disabled = !canEdit;

  const needEmail = !e.enabled ? t('notify.needsEmailShort') : null;
  const needTg = !tg.enabled ? t('notify.needsTgShort') : null;
  const needAny = !tg.enabled && !e.enabled ? t('notify.needsChannelShort') : null;

  return (
    <fieldset className="plain-fieldset" disabled={disabled}>
      {canEdit && dirty && (
        <div className="save-bar">
          <span className="grow small">{t('notify.unsaved')}</span>
          <Button size="sm" onClick={() => setF(state.config)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" icon={Save} onClick={() => save()}>
            {t('common.save')}
          </Button>
        </div>
      )}

      {/* ---------------------------------------------------------- channels */}
      <div className="opt-group-title">{t('notify.channels')}</div>
      <div className="opt-grid wide">
        <OptCard icon={Mail} title={t('notify.email')} text={t('notify.emailText')} on={e.enabled} onToggle={(v) => set('email.enabled', v)}>
          {e.enabled && (
            <>
              <div className="small muted">{t('notify.emailHint')}</div>
              <div className="grid-2">
                <Field label={t('notify.smtpHost')}>
                  <input className="input" value={e.host} placeholder="smtp.gmail.com" onChange={(ev) => set('email.host', ev.target.value.trim())} />
                </Field>
                <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
                  <Field label={t('setup.port')}>
                    <input className="input" type="number" style={{ width: 90 }} value={e.port} onChange={(ev) => set('email.port', Number(ev.target.value))} />
                  </Field>
                  <label className="check" style={{ height: 38 }}>
                    <input type="checkbox" checked={!!e.secure} onChange={(ev) => set('email.secure', ev.target.checked)} />
                    {t('notify.ssl')}
                  </label>
                </div>
                <Field label={t('notify.smtpUser')}>
                  <input className="input" value={e.user} placeholder="club@gmail.com" onChange={(ev) => set('email.user', ev.target.value.trim())} />
                </Field>
                <Field label={t('notify.smtpPassword')} hint={t('notify.smtpPasswordHint')}>
                  <input className="input" type="password" value={e.password} autoComplete="new-password" onChange={(ev) => set('email.password', ev.target.value)} />
                </Field>
                <Field label={t('notify.fromName')}>
                  <input className="input" value={e.fromName} placeholder="FC Pyunik" onChange={(ev) => set('email.fromName', ev.target.value)} />
                </Field>
              </div>
              <div className="row wrap">
                <input className="input" style={{ maxWidth: 240 }} value={testTo} placeholder={t('notify.testTo')} onChange={(ev) => setTestTo(ev.target.value.trim())} />
                <Button
                  icon={Send}
                  disabled={!testTo.includes('@')}
                  onClick={() => act(async () => (await save(true), ok(await window.fc.notify.testEmail(testTo))), t('notify.testSent'))}
                >
                  {t('notify.sendTest')}
                </Button>
              </div>
            </>
          )}
        </OptCard>

        <OptCard icon={Send} title="Telegram" text={t('notify.tgText')} on={tg.enabled} onToggle={(v) => set('telegram.enabled', v)}>
          {tg.enabled && (
            <>
              <ol className="small muted steps">
                <li>{t('notify.tgStep1')}</li>
                <li>{t('notify.tgStep2')}</li>
                <li>{t('notify.tgStep3')}</li>
              </ol>
              <Field label={t('notify.tgToken')}>
                <input className="input" type="password" value={tg.token} autoComplete="off" placeholder="123456789:AA…" onChange={(ev) => set('telegram.token', ev.target.value.trim())} />
              </Field>
              <div>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span className="strong small grow">{t('notify.tgChats')}</span>
                  <Button
                    size="sm"
                    icon={Search}
                    disabled={!tg.token}
                    onClick={async () => {
                      await save(true);
                      const found = await act(async () => ok(await window.fc.notify.findChats()));
                      if (!found) return;
                      const known = new Map((tg.chats || []).map((c) => [c.id, c]));
                      for (const c of found) if (!known.has(c.id)) known.set(c.id, { ...c, on: true });
                      set('telegram.chats', [...known.values()]);
                      toast.success(t('notify.tgFound', { n: found.length }));
                    }}
                  >
                    {t('notify.tgFind')}
                  </Button>
                </div>
                {(tg.chats || []).length === 0 ? (
                  <div className="small muted">{t('notify.tgNoChats')}</div>
                ) : (
                  <div className="stack" style={{ gap: 4 }}>
                    {tg.chats.map((c, i) => (
                      <label key={c.id} className="check small">
                        <input
                          type="checkbox"
                          checked={c.on !== false}
                          onChange={(ev) => set('telegram.chats', tg.chats.map((x, j) => (j === i ? { ...x, on: ev.target.checked } : x)))}
                        />
                        {c.name} <span className="muted">({c.id})</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div className="row">
                <Button
                  icon={Send}
                  disabled={!tg.token || !(tg.chats || []).some((c) => c.on !== false)}
                  onClick={() => act(async () => (await save(true), ok(await window.fc.notify.testTelegram())), t('notify.testSent'))}
                >
                  {t('notify.sendTest')}
                </Button>
              </div>
            </>
          )}
        </OptCard>
      </div>

      <div className="small muted" style={{ margin: '4px 0 2px' }}>
        <Workflow size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
        {t('notify.movedToAutomations')}
      </div>

      {/* ---------------------------------------------------------- parents */}
      <div className="opt-group-title">
        <Users size={16} /> {t('notify.forParents')}
      </div>
      <div className="opt-grid">
        {messengerCard}
        <OptCard icon={BellRing} title={t('notify.optReminders')} text={t('notify.remindersManual')} needs={needEmail}>
          <div className="row">
            <SendRemindersButton />
          </div>
        </OptCard>
        <OptCard icon={FileText} title={t('notify.optTemplates')} text={t('notify.optTemplatesText')} className={showTpl ? 'span-all' : ''}>
          <div className="row">
            <Button variant={showTpl ? 'ghost' : undefined} onClick={() => setShowTpl((v) => !v)}>
              {t(showTpl ? 'notify.hideTemplates' : 'notify.editTemplates')}
            </Button>
          </div>
          {showTpl && (
            <div className="stack">
              <div className="small muted">{t('notify.placeholders')}</div>
              <div className="grid-2">
                {[
                  ['reminderSubject', 'notify.tplReminderSubject', false],
                  ['reminderBody', 'notify.tplReminderBody', true],
                ].map(([k, label, multi]) => (
                  <Field key={k} label={t(label)}>
                    {multi ? (
                      <textarea className="textarea" rows={8} value={tpl[k]} onChange={(ev) => setTpl(k, ev.target.value)} />
                    ) : (
                      <input className="input" value={tpl[k]} onChange={(ev) => setTpl(k, ev.target.value)} />
                    )}
                  </Field>
                ))}
              </div>
              <div className="row">
                <Button size="sm" icon={RotateCcw} onClick={() => set('templates', {})}>
                  {t('notify.resetTemplates')}
                </Button>
              </div>
            </div>
          )}
        </OptCard>
      </div>

      {/* ---------------------------------------------------------- staff */}
      <div className="opt-group-title">
        <Megaphone size={16} /> {t('notify.forStaff')}
      </div>
      <div className="opt-grid">
        <OptCard icon={CalendarClock} title={t('notify.optSummaries')} text={t('notify.summariesManual')} needs={needAny}>
          <div className="row wrap">
            <SendNowButton kind="daily" act={act} save={save} t={t} />
            <SendNowButton kind="monthly" act={act} save={save} t={t} />
          </div>
        </OptCard>
        <OptCard icon={AtSign} title={t('notify.optRecipients')} text={t('notify.summaryEmailsHint')} needs={needEmail}>
          <input className="input" value={f.summaryEmails} placeholder="director@example.com, admin@example.com" onChange={(ev) => set('summaryEmails', ev.target.value)} />
        </OptCard>
        <OptCard icon={UserCheck} title={t('notify.optActions')} text={t('notify.watchMoved')} needs={needTg}>
          <WatchedUsers />
        </OptCard>
      </div>

      <Outbox />
    </fieldset>
  );
}

// One option of the notifications page: its own card with an on/off switch in the corner.
function OptCard({ icon: Icon, title, text, on, onToggle, needs, className = '', children }) {
  return (
    <div className={`card opt-card ${onToggle && !on ? 'off' : ''} ${className}`}>
      <div className="opt-head">
        <div className="opt-icon">
          <Icon size={17} />
        </div>
        <h4 className="grow">{title}</h4>
        {onToggle && (
          <label className="switch" title={title}>
            <input type="checkbox" checked={!!on} onChange={(ev) => onToggle(ev.target.checked)} />
            <span />
          </label>
        )}
      </div>
      <div className="opt-body">
        {text && <div className="small muted">{text}</div>}
        {needs && on !== false && <div className="small opt-needs">{needs}</div>}
        {children}
      </div>
    </div>
  );
}

function SendNowButton({ kind, act, save, t }) {
  return (
    <Button
      icon={Send}
      onClick={() =>
        act(async () => {
          await save(true);
          const n = ok(await window.fc.notify.run(kind));
          if (!n) throw Object.assign(new Error(), { code: 'NO_RECIPIENTS' });
          return n;
        }, t('notify.queued'))
      }
    >
      {t(`notify.sendNow_${kind}`)}
    </Button>
  );
}

// Who has «Գործողությունները՝ Telegram-ով» ticked (Settings → Users).
function WatchedUsers() {
  const t = useT();
  const { data } = useRpc('users.list');
  const names = (data || []).filter((u) => u.notify_actions).map((u) => u.full_name || u.username);
  return <div className="small strong">{names.length ? t('notify.optActionsWho', { names: names.join(', ') }) : <span className="muted">{t('notify.optActionsNone')}</span>}</div>;
}

// "Send reminders" to the parents of every student with an overdue fee.
export function SendRemindersButton({ studentIds, size, label }) {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  return (
    <Button
      size={size}
      icon={Mail}
      onClick={async () => {
        if (!(await confirm({ title: t('notify.remindTitle'), text: t(studentIds ? 'notify.remindOne' : 'notify.remindAll'), confirmLabel: t('notify.remindSend'), danger: false })))
          return;
        const r = await act(() => rpc('notify.remind', { studentIds }));
        if (!r) return;
        toast.success(t('notify.remindQueued', { n: r.queued }));
        if (r.noEmail.length) toast.error(t('notify.remindNoEmail', { n: r.noEmail.length, names: r.noEmail.slice(0, 5).join(', ') }));
      }}
    >
      {label || t('notify.remindNow')}
    </Button>
  );
}

// Recent messages and whether they went out.
function Outbox() {
  const t = useT();
  const act = useAction();
  const [n, setN] = useState(0);
  const { data } = useRpc('notify.outbox', { limit: 40, n });
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), 10000);
    return () => clearInterval(id);
  }, []);
  const tone = { sent: 'good', pending: 'warn', failed: 'bad' };
  return (
    <div className="card settings-section">
      <div className="card-head">
        <History size={17} />
        <h3>{t('notify.outbox')}</h3>
        <div className="spacer" />
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => setN((x) => x + 1)} />
      </div>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <div className="card-pad small muted">{t('notify.outboxEmpty')}</div>
      ) : (
        <div className="table-wrap" style={{ border: 0, borderRadius: 0, maxHeight: 360 }}>
          <table className="table">
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  <td className="small nowrap muted">{fmtDateTime(m.created_at)}</td>
                  <td className="small">
                    <div className="strong">{t(`notify.kind_${m.kind}`)}</div>
                    <div className="muted">
                      {m.channel === 'email' ? '✉' : '✈'} {m.recipient}
                      {m.first_name ? ` · ${m.first_name} ${m.last_name}` : ''}
                    </div>
                  </td>
                  <td className="small">
                    <Badge tone={tone[m.status]}>{t(`notify.status_${m.status}`)}</Badge>
                    {m.error && <div className="small muted" title={m.error} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.error}</div>}
                  </td>
                  <td className="actions">
                    {m.status === 'failed' && (
                      <Button size="sm" icon={RotateCcw} onClick={() => act(() => rpc('notify.retry', { id: m.id }).then(() => setN((x) => x + 1)))}>
                        {t('notify.retry')}
                      </Button>
                    )}
                    {m.status === 'sent' && <CheckCircle2 size={16} style={{ color: 'var(--good)' }} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

