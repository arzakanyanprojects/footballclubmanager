// «Ավտոմատացումներ» (Settings): the owner's own rules — When (a trigger) → If (conditions) → Then (actions).
// The rules run on the main computer for everyone's saves (electron/automations.js); this screen lists them,
// edits them and shows what each run did.
import { useEffect, useState } from 'react';
import { Workflow, Plus, Pencil, Trash2, History, X } from 'lucide-react';
import { useT } from '../i18n';
import { useRpc, rpc, fmtDateTime } from '../lib';
import { Badge, Button, Empty, Field, Loading, Modal, Segmented, useAction, useConfirm, useToast } from './ui';
import { CATEGORIES } from '../pages/Students';
import { PAYMENT_METHODS } from '../pages/Payments';
import { REPORT_KINDS } from '../../electron/reportSheets.mjs';

const TRIGGERS = ['student.created', 'student.groupChanged', 'student.statusChanged', 'student.categoryChanged', 'payment.received', 'schedule'];

// Which condition fields each trigger offers, and the kind of value each field takes.
const STUDENT_FIELDS = ['group', 'group.championship', 'category', 'status', 'fee'];
const FIELDS_BY_TRIGGER = {
  'student.created': STUDENT_FIELDS,
  'student.groupChanged': [...STUDENT_FIELDS, 'oldGroup', 'oldGroup.championship', 'newGroup', 'newGroup.championship'],
  'student.statusChanged': [...STUDENT_FIELDS, 'oldStatus', 'newStatus'],
  'student.categoryChanged': [...STUDENT_FIELDS, 'oldCategory', 'newCategory'],
  'payment.received': [...STUDENT_FIELDS, 'payment.total', 'payment.method', 'payment.hasMonthly'],
  schedule: [],
};
const kindOf = (field) =>
  /championship$|hasMonthly$/.test(field) ? 'bool' : /^(group|oldGroup|newGroup)$/.test(field) ? 'group' : /fee$|total$/.test(field) ? 'number' : /ategory$/i.test(field) ? 'category' : /tatus$/i.test(field) ? 'status' : 'method';
const OPS = { group: ['is', 'isNot', 'in', 'notIn'], category: ['is', 'isNot', 'in', 'notIn'], status: ['is', 'isNot'], method: ['is', 'isNot'], bool: ['is'], number: ['eq', 'lt', 'gt'] };
const firstValue = (kind, groups) => ({ bool: true, number: 0, group: groups?.[0]?.id ?? null, category: '', status: 'active', method: PAYMENT_METHODS[0] })[kind];

const CLUB_ACTIONS = ['sendTelegram', 'sendSummary', 'sendReminders', 'emailReport', 'sendEmail'];
const ACTIONS = ['setFee', 'setCategory', 'addNote', 'sendEmail', 'sendTelegram', 'addDebt', 'sendSummary', 'sendReminders', 'emailReport'];
const NEW_ACTION = {
  setFee: { mode: 'keepDiscount', amount: '' },
  setCategory: { value: '' },
  addNote: { text: '' },
  sendEmail: { toParent: true, to: '', subject: '', body: '' },
  sendTelegram: { text: '' },
  addDebt: { amount: '', month: 'this', note: '' },
  sendSummary: { kind: 'daily', telegram: true, emails: '' },
  sendReminders: {},
  emailReport: { report: REPORT_KINDS[0], range: 'lastMonth', to: '' },
};

// The placeholders a trigger's texts can use.
const PLACEHOLDERS = {
  schedule: ['club', 'date'],
  'student.created': ['student', 'parent', 'group', 'club', 'date'],
  'student.groupChanged': ['student', 'parent', 'oldGroup', 'newGroup', 'oldFee', 'newFee', 'club', 'date'],
  'student.statusChanged': ['student', 'parent', 'group', 'oldStatus', 'newStatus', 'club', 'date'],
  'student.categoryChanged': ['student', 'parent', 'group', 'oldCategory', 'newCategory', 'club', 'date'],
  'payment.received': ['student', 'parent', 'group', 'total', 'method', 'items', 'by', 'club', 'date'],
};

export function AutomationsSettings() {
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const { data: rules } = useRpc('automations.list');
  const { data: groups } = useRpc('groups.list');
  const [editing, setEditing] = useState(null); // a rule, or {} for a new one
  const [history, setHistory] = useState(null); // { id?, name? }

  const toggle = (r) => act(() => rpc('automations.save', { ...r, enabled: !r.enabled }));
  const remove = async (r) => {
    if (await confirm({ title: t('auto.deleteTitle'), text: t('auto.deleteText', { name: r.name }), confirmLabel: t('common.delete') }))
      act(() => rpc('automations.delete', { id: r.id }), t('auto.deleted'));
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="small muted" style={{ maxWidth: 720 }}>{t('auto.intro')}</div>
        <div className="row">
          <Button icon={History} onClick={() => setHistory({})}>
            {t('auto.history')}
          </Button>
          <Button variant="primary" icon={Plus} onClick={() => setEditing({})}>
            {t('auto.new')}
          </Button>
        </div>
      </div>
      {!rules ? (
        <Loading />
      ) : rules.length === 0 ? (
        <Empty icon={Workflow} title={t('auto.empty')} text={t('auto.emptyText')} />
      ) : (
        rules.map((r) => (
          <div key={r.id} className={`card opt-card ${r.enabled ? '' : 'off'}`}>
            <div className="opt-head">
              <div className="opt-icon">
                <Workflow size={17} />
              </div>
              <div className="grow">
                <h4>{r.name}</h4>
                <div className="small muted">
                  {t('auto.when')}՝ {triggerText(t, r.trigger)} · {t('auto.nConditions', { n: r.conditions.length })} · {t('auto.nActions', { n: r.actions.length })}
                </div>
                <div className="small muted">
                  {r.last_run_at ? t('auto.lastRun', { when: fmtDateTime(r.last_run_at), n: r.runs_count }) : t('auto.neverRan')}
                </div>
              </div>
              <Button size="sm" icon={History} onClick={() => setHistory({ id: r.id, name: r.name })} title={t('auto.history')} />
              <Button size="sm" icon={Pencil} onClick={() => setEditing(r)} title={t('common.edit')} />
              <Button size="sm" icon={Trash2} onClick={() => remove(r)} title={t('common.delete')} />
              <label className="switch" title={t(r.enabled ? 'auto.turnOff' : 'auto.turnOn')}>
                <input type="checkbox" checked={!!r.enabled} onChange={() => toggle(r)} />
                <span />
              </label>
            </div>
          </div>
        ))
      )}
      {editing && <AutomationEditor rule={editing} groups={groups || []} onClose={() => setEditing(null)} />}
      {history && <AutomationRuns {...history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function triggerText(t, tr) {
  if (tr.type !== 'schedule') return t(`auto.trigger.${tr.type}`);
  if (tr.every === 'weekly') return t('auto.everyWeekly', { day: t(`weekday.${tr.weekday}`), time: tr.time });
  if (tr.every === 'monthly') return t('auto.everyMonthly', { day: tr.day, time: tr.time });
  return t('auto.everyDaily', { time: tr.time });
}

function AutomationEditor({ rule, groups, onClose }) {
  const t = useT();
  const act = useAction();
  const [f, setF] = useState(() => ({
    name: rule.name || '',
    enabled: rule.id ? !!rule.enabled : true,
    trigger: rule.trigger || { type: 'student.groupChanged' },
    conditions: rule.conditions || [],
    actions: rule.actions || [],
  }));
  const tr = f.trigger;
  const isSchedule = tr.type === 'schedule';
  const fields = FIELDS_BY_TRIGGER[tr.type] || [];
  const allowed = isSchedule ? CLUB_ACTIONS : ACTIONS;

  const setTrigger = (patch) =>
    setF((x) => {
      const trigger = { ...x.trigger, ...patch };
      if (trigger.type === 'schedule') Object.assign(trigger, { every: trigger.every || 'daily', time: trigger.time || '09:00', weekday: trigger.weekday ?? 1, day: trigger.day ?? 1 });
      const keep = FIELDS_BY_TRIGGER[trigger.type] || [];
      const ok = trigger.type === 'schedule' ? CLUB_ACTIONS : ACTIONS;
      return { ...x, trigger, conditions: x.conditions.filter((c) => keep.includes(c.field)), actions: x.actions.filter((a) => ok.includes(a.type)) };
    });
  const setCond = (i, patch) => setF((x) => ({ ...x, conditions: x.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const setAction = (i, patch) => setF((x) => ({ ...x, actions: x.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));
  const addCond = () => {
    const field = fields[0];
    setF((x) => ({ ...x, conditions: [...x.conditions, { field, op: OPS[kindOf(field)][0], value: firstValue(kindOf(field), groups) }] }));
  };
  const addAction = () => setF((x) => ({ ...x, actions: [...x.actions, { type: allowed[0], ...NEW_ACTION[allowed[0]] }] }));

  const save = async () => {
    const trigger = isSchedule
      ? { type: 'schedule', every: tr.every, time: tr.time, ...(tr.every === 'weekly' ? { weekday: Number(tr.weekday) } : {}), ...(tr.every === 'monthly' ? { day: Number(tr.day) } : {}) }
      : { type: tr.type };
    const ok = await act(() => rpc('automations.save', { id: rule.id, name: f.name, enabled: f.enabled, trigger, conditions: isSchedule ? [] : f.conditions, actions: f.actions }), t('common.saved'));
    if (ok) onClose();
  };

  return (
    <Modal
      title={rule.id ? t('auto.editTitle') : t('auto.new')}
      onClose={onClose}
      width={820}
      footer={
        <>
          <label className="check">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF((x) => ({ ...x, enabled: e.target.checked }))} />
            {t('auto.enabled')}
          </label>
          <div className="grow" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!f.name.trim() || !f.actions.length}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('auto.name')}>
          <input className="input" value={f.name} autoFocus onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} placeholder={t('auto.namePlaceholder')} />
        </Field>

        <div className="auto-section">
          <h4>{t('auto.when')}</h4>
          <select className="select" value={tr.type} onChange={(e) => setTrigger({ type: e.target.value })}>
            {TRIGGERS.map((x) => (
              <option key={x} value={x}>
                {t(`auto.trigger.${x}`)}
              </option>
            ))}
          </select>
          {isSchedule && (
            <div className="row wrap" style={{ gap: 10, marginTop: 10 }}>
              <Segmented
                value={tr.every}
                onChange={(every) => setTrigger({ every })}
                options={['daily', 'weekly', 'monthly'].map((x) => ({ value: x, label: t(`auto.every.${x}`) }))}
              />
              {tr.every === 'weekly' && (
                <select className="select" value={tr.weekday} onChange={(e) => setTrigger({ weekday: Number(e.target.value) })} style={{ width: 160 }}>
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <option key={d} value={d}>
                      {t(`weekday.${d}`)}
                    </option>
                  ))}
                </select>
              )}
              {tr.every === 'monthly' && (
                <label className="row small" style={{ gap: 6 }}>
                  {t('auto.dayOfMonth')}
                  <input className="input" type="number" min="1" max="28" style={{ width: 70 }} value={tr.day} onChange={(e) => setTrigger({ day: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })} />
                </label>
              )}
              <label className="row small" style={{ gap: 6 }}>
                {t('auto.at')}
                <input className="input" type="time" style={{ width: 120 }} value={tr.time} onChange={(e) => setTrigger({ time: e.target.value })} />
              </label>
            </div>
          )}
        </div>

        {!isSchedule && (
          <div className="auto-section">
            <h4>{t('auto.if')}</h4>
            {f.conditions.length === 0 && <div className="small muted">{t('auto.noConditions')}</div>}
            {f.conditions.map((c, i) => (
              <ConditionRow
                key={i}
                c={c}
                fields={fields}
                groups={groups}
                onChange={(patch) => setCond(i, patch)}
                onRemove={() => setF((x) => ({ ...x, conditions: x.conditions.filter((_, j) => j !== i) }))}
              />
            ))}
            <div>
              <Button size="sm" icon={Plus} onClick={addCond}>
                {t('auto.addCondition')}
              </Button>
            </div>
          </div>
        )}

        <div className="auto-section">
          <h4>{t('auto.then')}</h4>
          {f.actions.map((a, i) => (
            <ActionRow
              key={i}
              a={a}
              allowed={allowed}
              isSchedule={isSchedule}
              onChange={(patch) => setAction(i, patch)}
              onType={(type) => setF((x) => ({ ...x, actions: x.actions.map((y, j) => (j === i ? { type, ...NEW_ACTION[type] } : y)) }))}
              onRemove={() => setF((x) => ({ ...x, actions: x.actions.filter((_, j) => j !== i) }))}
            />
          ))}
          <div>
            <Button size="sm" icon={Plus} onClick={addAction}>
              {t('auto.addAction')}
            </Button>
          </div>
          <div className="small muted">
            {t('auto.placeholders')} {(PLACEHOLDERS[tr.type] || []).map((p) => `{${p}}`).join(' ')}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ConditionRow({ c, fields, groups, onChange, onRemove }) {
  const t = useT();
  const kind = kindOf(c.field);
  const multi = c.op === 'in' || c.op === 'notIn';
  const setField = (field) => {
    const k = kindOf(field);
    onChange({ field, op: OPS[k][0], value: firstValue(k, groups) });
  };
  const setOp = (op) => {
    const toMulti = op === 'in' || op === 'notIn';
    onChange({ op, value: toMulti === multi ? c.value : toMulti ? (c.value == null ? [] : [c.value]) : Array.isArray(c.value) ? c.value[0] ?? firstValue(kind, groups) : c.value });
  };
  const options =
    kind === 'group'
      ? groups.map((g) => ({ value: g.id, label: g.name }))
      : kind === 'category'
        ? [{ value: '', label: t('category.none') }, ...CATEGORIES.map((x) => ({ value: x, label: t(`category.${x}`) }))]
        : kind === 'status'
          ? ['active', 'inactive'].map((x) => ({ value: x, label: t(`status.${x}`) }))
          : PAYMENT_METHODS.map((x) => ({ value: x, label: t(`method.${x}`) }));
  const cast = (v) => (kind === 'group' ? Number(v) : v);
  return (
    <div className="auto-row">
      <select className="select" value={c.field} onChange={(e) => setField(e.target.value)}>
        {fields.map((x) => (
          <option key={x} value={x}>
            {t(`auto.field.${x}`)}
          </option>
        ))}
      </select>
      <select className="select" value={c.op} onChange={(e) => setOp(e.target.value)} style={{ width: 150 }}>
        {OPS[kind].map((x) => (
          <option key={x} value={x}>
            {t(`auto.op.${x}`)}
          </option>
        ))}
      </select>
      {kind === 'bool' ? (
        <select className="select" value={c.value ? '1' : '0'} onChange={(e) => onChange({ value: e.target.value === '1' })} style={{ width: 120 }}>
          <option value="1">{t('common.yes')}</option>
          <option value="0">{t('common.no')}</option>
        </select>
      ) : kind === 'number' ? (
        <input className="input" type="number" value={c.value} onChange={(e) => onChange({ value: e.target.value })} style={{ width: 140 }} />
      ) : multi ? (
        <select
          className="select"
          multiple
          size={Math.min(6, options.length)}
          value={(c.value || []).map(String)}
          onChange={(e) => onChange({ value: [...e.target.selectedOptions].map((o) => cast(o.value)) })}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <select className="select" value={c.value ?? ''} onChange={(e) => onChange({ value: cast(e.target.value) })}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <Button size="sm" icon={X} onClick={onRemove} title={t('common.delete')} />
    </div>
  );
}

function ActionRow({ a, allowed, isSchedule, onChange, onType, onRemove }) {
  const t = useT();
  const input = (k, props = {}) => <input className="input" value={a[k] ?? ''} onChange={(e) => onChange({ [k]: e.target.value })} {...props} />;
  const area = (k) => <textarea className="textarea" rows={4} value={a[k] ?? ''} onChange={(e) => onChange({ [k]: e.target.value })} />;
  return (
    <div className="auto-action card">
      <div className="auto-row">
        <select className="select" value={a.type} onChange={(e) => onType(e.target.value)}>
          {allowed.map((x) => (
            <option key={x} value={x}>
              {t(`auto.action.${x}`)}
            </option>
          ))}
        </select>
        <Button size="sm" icon={X} onClick={onRemove} title={t('common.delete')} />
      </div>
      {a.type === 'setFee' && (
        <div className="row wrap" style={{ gap: 10 }}>
          <Segmented value={a.mode} onChange={(mode) => onChange({ mode })} options={['keepDiscount', 'fixed'].map((x) => ({ value: x, label: t(`auto.fee.${x}`) }))} />
          {a.mode === 'fixed' && input('amount', { type: 'number', min: 0, style: { width: 140 } })}
          <div className="small muted" style={{ flexBasis: '100%' }}>{t(`auto.fee.${a.mode}Hint`)}</div>
        </div>
      )}
      {a.type === 'setCategory' && (
        <select className="select" value={a.value} onChange={(e) => onChange({ value: e.target.value })}>
          <option value="">{t('category.none')}</option>
          {CATEGORIES.map((x) => (
            <option key={x} value={x}>
              {t(`category.${x}`)}
            </option>
          ))}
        </select>
      )}
      {a.type === 'addNote' && area('text')}
      {a.type === 'sendEmail' && (
        <div className="stack" style={{ gap: 8 }}>
          {!isSchedule && (
            <label className="check">
              <input type="checkbox" checked={!!a.toParent} onChange={(e) => onChange({ toParent: e.target.checked })} />
              {t('auto.toParent')}
            </label>
          )}
          <Field label={t('auto.toAddresses')}>{input('to', { placeholder: 'director@example.com' })}</Field>
          <Field label={t('auto.subject')}>{input('subject')}</Field>
          <Field label={t('auto.body')}>{area('body')}</Field>
        </div>
      )}
      {a.type === 'sendTelegram' && area('text')}
      {a.type === 'addDebt' && (
        <div className="row wrap" style={{ gap: 10 }}>
          {input('amount', { type: 'number', min: 1, style: { width: 140 }, placeholder: t('payments.amount') })}
          <Segmented value={a.month} onChange={(month) => onChange({ month })} options={['this', 'next'].map((x) => ({ value: x, label: t(`auto.month.${x}`) }))} />
          {input('note', { placeholder: t('auto.debtNote'), style: { flex: 1, minWidth: 200 } })}
        </div>
      )}
      {a.type === 'sendSummary' && (
        <div className="row wrap" style={{ gap: 10 }}>
          <Segmented value={a.kind} onChange={(kind) => onChange({ kind })} options={['daily', 'monthly'].map((x) => ({ value: x, label: t(`auto.summary.${x}`) }))} />
          <label className="check">
            <input type="checkbox" checked={!!a.telegram} onChange={(e) => onChange({ telegram: e.target.checked })} />
            Telegram
          </label>
          {input('emails', { placeholder: t('auto.emailsPlaceholder'), style: { flex: 1, minWidth: 220 } })}
        </div>
      )}
      {a.type === 'sendReminders' && <div className="small muted">{t('auto.remindersHint')}</div>}
      {a.type === 'emailReport' && (
        <div className="row wrap" style={{ gap: 10 }}>
          <select className="select" value={a.report} onChange={(e) => onChange({ report: e.target.value })} style={{ width: 240 }}>
            {REPORT_KINDS.map((x) => (
              <option key={x} value={x}>
                {t(`reportsx.${x}`)}
              </option>
            ))}
          </select>
          <select className="select" value={a.range} onChange={(e) => onChange({ range: e.target.value })} style={{ width: 200 }}>
            {['yesterday', 'last7', 'thisMonth', 'lastMonth'].map((x) => (
              <option key={x} value={x}>
                {t(`auto.range.${x}`)}
              </option>
            ))}
          </select>
          {input('to', { placeholder: 'director@example.com', style: { flex: 1, minWidth: 220 } })}
        </div>
      )}
    </div>
  );
}

const RUN_TONE = { done: 'good', skipped: '', failed: 'bad' };

function AutomationRuns({ id, name, onClose }) {
  const t = useT();
  const { data: runs } = useRpc('automations.runs', { id: id || null });
  return (
    <Modal title={name ? `${t('auto.history')} — ${name}` : t('auto.history')} onClose={onClose} width={1000} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {!runs ? (
        <Loading />
      ) : runs.length === 0 ? (
        <Empty icon={History} title={t('auto.noRuns')} />
      ) : (
        <div className="table-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('auto.runAt')}</th>
                {!id && <th>{t('auto.rule')}</th>}
                <th>{t('payments.student')}</th>
                <th>{t('auto.result')}</th>
                <th>{t('auto.details')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{fmtDateTime(r.at)}</td>
                  {!id && <td>{r.rule_name}</td>}
                  <td>{r.first_name ? `${r.first_name} ${r.last_name}` : '—'}</td>
                  <td>
                    <Badge tone={RUN_TONE[r.status]}>{t(`auto.status.${r.status}`)}</Badge>
                  </td>
                  <td className="small">
                    {(r.detail || []).map((d, i) => (
                      <div key={i} className={d.status === 'skipped' ? 'muted' : ''} style={d.status === 'failed' ? { color: 'var(--bad)' } : undefined}>
                        {d.text}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// Toasts for the rules that ran on this person's save («Ավտոմատացում "…"՝ ամսավճարը 17 500»). Mounted once in App.
export function AutomationToasts() {
  const t = useT();
  const toast = useToast();
  useEffect(() => {
    const show = (e) => {
      for (const r of e.detail || []) {
        const text = t('auto.toast', { name: r.name, summary: r.summary || t(`auto.status.${r.status}`) });
        if (r.status === 'failed') toast.error(text);
        else if (r.status === 'done') toast.success(text);
      }
    };
    window.addEventListener('fc-automations', show);
    return () => window.removeEventListener('fc-automations', show);
  }, [t, toast]);
  return null;
}
