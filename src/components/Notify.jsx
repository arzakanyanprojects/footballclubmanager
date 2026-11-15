import { useEffect, useState } from 'react';
import { Mail, Send, Users, Megaphone, History, Save, RefreshCw, RotateCcw, Search, CheckCircle2 } from 'lucide-react';
import { useT } from '../i18n';
import { rpc, useRpc, fmtDateTime } from '../lib';
import { Badge, Button, Field, Loading, useAction, useConfirm, useToast } from './ui';
import { useCan } from './Auth';

const ok = (r) => {
  if (!r.ok) throw Object.assign(new Error(r.error), { code: r.error, detail: r.detail, showDetail: true });
  return r.result;
};

// Settings → Notifications. Channels and schedules live on the main (host) PC, which sends everything.
export function NotifySettings() {
  const t = useT();
  const toast = useToast();
  const act = useAction();
  const canEdit = useCan('settings');
  const [state, setState] = useState(null);
  const [f, setF] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [showTpl, setShowTpl] = useState(false);

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

      {/* ---------------------------------------------------------- email */}
      <div className="card settings-section">
        <div className="card-head">
          <Mail size={17} />
          <h3>{t('notify.email')}</h3>
          <div className="spacer" />
          <Badge tone={state.config.email.enabled ? 'good' : ''}>{t(state.config.email.enabled ? 'notify.on' : 'notify.off')}</Badge>
        </div>
        <div className="card-pad">
          <label className="check">
            <input type="checkbox" checked={!!e.enabled} onChange={(ev) => set('email.enabled', ev.target.checked)} />
            <span className="strong">{t('notify.emailEnable')}</span>
          </label>
          {e.enabled && (
            <>
              <div className="small muted">{t('notify.emailHint')}</div>
              <div className="grid-3">
                <Field label={t('notify.smtpHost')}>
                  <input className="input" value={e.host} placeholder="smtp.gmail.com" onChange={(ev) => set('email.host', ev.target.value.trim())} />
                </Field>
                <Field label={t('setup.port')}>
                  <input className="input" type="number" value={e.port} onChange={(ev) => set('email.port', Number(ev.target.value))} />
                </Field>
                <Field label=" ">
                  <label className="check" style={{ height: 38 }}>
                    <input type="checkbox" checked={!!e.secure} onChange={(ev) => set('email.secure', ev.target.checked)} />
                    {t('notify.ssl')}
                  </label>
                </Field>
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
                <input className="input" style={{ maxWidth: 280 }} value={testTo} placeholder={t('notify.testTo')} onChange={(ev) => setTestTo(ev.target.value.trim())} />
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
        </div>
      </div>

      {/* ---------------------------------------------------------- Telegram */}
      <div className="card settings-section">
        <div className="card-head">
          <Send size={17} />
          <h3>Telegram</h3>
          <div className="spacer" />
          <Badge tone={state.config.telegram.enabled ? 'good' : ''}>{t(state.config.telegram.enabled ? 'notify.on' : 'notify.off')}</Badge>
        </div>
        <div className="card-pad">
          <label className="check">
            <input type="checkbox" checked={!!tg.enabled} onChange={(ev) => set('telegram.enabled', ev.target.checked)} />
            <span className="strong">{t('notify.tgEnable')}</span>
          </label>
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
        </div>
      </div>

      {/* ---------------------------------------------------------- parents */}
      <div className="card settings-section">
        <div className="card-head">
          <Users size={17} />
          <h3>{t('notify.parents')}</h3>
        </div>
        <div className="card-pad">
          {!e.enabled && <div className="small" style={{ color: 'var(--warn)' }}>{t('notify.needsEmail')}</div>}
          <label className="check">
            <input type="checkbox" checked={!!f.receipts} onChange={(ev) => set('receipts', ev.target.checked)} />
            {t('notify.receipts')}
          </label>
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="check">
              <input type="checkbox" checked={!!f.reminders.auto} onChange={(ev) => set('reminders.auto', ev.target.checked)} />
              {t('notify.autoReminders')}
            </label>
            <input
              className="input"
              type="number"
              min="1"
              max="28"
              style={{ width: 70 }}
              value={f.reminders.day}
              onChange={(ev) => set('reminders.day', Math.min(28, Math.max(1, Number(ev.target.value) || 1)))}
            />
            <span className="small muted">{t('notify.autoRemindersDay')}</span>
          </div>
          <div className="small muted">{t('notify.remindersHint')}</div>
          <div className="row">
            <SendRemindersButton />
            <Button variant="ghost" onClick={() => setShowTpl((v) => !v)}>
              {t(showTpl ? 'notify.hideTemplates' : 'notify.editTemplates')}
            </Button>
          </div>
          {showTpl && (
            <div className="stack">
              <div className="small muted">{t('notify.placeholders')}</div>
              {[
                ['reminderSubject', 'notify.tplReminderSubject', false],
                ['reminderBody', 'notify.tplReminderBody', true],
                ['receiptSubject', 'notify.tplReceiptSubject', false],
                ['receiptBody', 'notify.tplReceiptBody', true],
              ].map(([k, label, multi]) => (
                <Field key={k} label={t(label)}>
                  {multi ? (
                    <textarea className="textarea" rows={8} value={tpl[k]} onChange={(ev) => setTpl(k, ev.target.value)} />
                  ) : (
                    <input className="input" value={tpl[k]} onChange={(ev) => setTpl(k, ev.target.value)} />
                  )}
                </Field>
              ))}
              <div className="row">
                <Button size="sm" icon={RotateCcw} onClick={() => set('templates', {})}>
                  {t('notify.resetTemplates')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------- staff */}
      <div className="card settings-section">
        <div className="card-head">
          <Megaphone size={17} />
          <h3>{t('notify.staff')}</h3>
        </div>
        <div className="card-pad">
          {!tg.enabled && !e.enabled && <div className="small" style={{ color: 'var(--warn)' }}>{t('notify.needsChannel')}</div>}
          <label className="check">
            <input type="checkbox" checked={!!f.paymentAlerts} onChange={(ev) => set('paymentAlerts', ev.target.checked)} />
            {t('notify.paymentAlerts')}
          </label>
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="check">
              <input type="checkbox" checked={!!f.daily.enabled} onChange={(ev) => set('daily.enabled', ev.target.checked)} />
              {t('notify.daily')}
            </label>
            <input className="input" type="time" style={{ width: 120 }} value={f.daily.time} onChange={(ev) => set('daily.time', ev.target.value)} />
          </div>
          <label className="check">
            <input type="checkbox" checked={!!f.monthly.enabled} onChange={(ev) => set('monthly.enabled', ev.target.checked)} />
            {t('notify.monthly')}
          </label>
          <Field label={t('notify.summaryEmails')} hint={t('notify.summaryEmailsHint')}>
            <input className="input" value={f.summaryEmails} placeholder="director@example.com, admin@example.com" onChange={(ev) => set('summaryEmails', ev.target.value)} />
          </Field>
          <div className="row wrap">
            {['daily', 'monthly'].map((k) => (
              <Button
                key={k}
                icon={Send}
                onClick={() =>
                  act(async () => {
                    await save(true);
                    const n = ok(await window.fc.notify.run(k));
                    if (!n) throw Object.assign(new Error(), { code: 'NO_RECIPIENTS' });
                    return n;
                  }, t('notify.queued'))
                }
              >
                {t(`notify.sendNow_${k}`)}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <Outbox />
    </fieldset>
  );
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
