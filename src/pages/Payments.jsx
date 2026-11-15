import { Fragment, useEffect, useMemo, useState } from 'react';
import { Plus, Download, Wallet, CheckCircle2, Pencil, Ban, RotateCcw, Trash2, Printer, Package, Receipt } from 'lucide-react';
import { useT, monthName } from '../i18n';
import { useCan } from '../components/Auth';
import { useColumns } from '../components/Columns';
import { useHdm } from '../components/Hdm';
import { useRpc, rpc, fmtDate, todayIso, currentPeriod, addMonths, saveCsv, money } from '../lib';
import {
  Badge, Button, Empty, Field, Loading, Modal, Money, RowMenu, SearchBox, Segmented, StudentPicker, Tabs,
  useAction, useClub, useConfirm,
} from '../components/ui';

// Payment methods the club accepts, in the order shown; the first is the default.
export const PAYMENT_METHODS = ['easypay', 'card', 'transfer'];

export const chargeStatus = (c) =>
  c.status === 'paid' ? 'paid' : c.status === 'waived' ? 'waived' : c.due_date && c.due_date < todayIso() ? 'overdue' : 'unpaid';

const STATUS_TONE = { paid: 'good', unpaid: 'warn', overdue: 'bad', waived: '' };

export function chargeLabel(t, c) {
  if (c.kind === 'monthly') return `${t('charge.monthly')} · ${monthName(t, c.period)}`;
  const name = c.description || c.product_name || t(`charge.${c.kind}`);
  return c.quantity > 1 ? `${name} × ${c.quantity}` : name;
}

export default function Payments({ route, nav }) {
  const t = useT();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('nav.payments')}</h1>
          <div className="sub">{t('payments.subtitle')}</div>
        </div>
      </div>
      <ChargesView preset={route.preset} nav={nav} />
    </>
  );
}

function ChargesView({ preset, nav }) {
  const canEdit = useCan('payments');
  const t = useT();
  const [status, setStatus] = useState(preset || 'all');
  const [kind, setKind] = useState('');
  const [period, setPeriod] = useState(preset === 'paid' ? currentPeriod() : '');
  const [groupId, setGroupId] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const { data: groups } = useRpc('groups.list');
  const { data, loading } = useRpc('charges.list', {
    status: status === 'overdue' || status === 'all' ? null : status,
    overdue: status === 'overdue',
    kind: kind || null,
    period: period || null,
    groupId: groupId ? Number(groupId) : null,
    search,
  });
  const rows = data || [];
  const total = rows.reduce((s, c) => s + c.amount, 0);

  const exportCsv = () =>
    saveCsv(`payments-${todayIso()}.csv`, [
      [t('payments.student'), t('students.group'), t('payments.description'), t('payments.dueDate'), t('payments.amount'),
        t('payments.status'), t('payments.paidAt'), t('payments.method')],
      ...rows.map((c) => [`${c.first_name} ${c.last_name}`, c.group_name, chargeLabel(t, c), fmtDate(c.due_date), c.amount,
        t(`chargeStatus.${chargeStatus(c)}`), c.paid_at ? fmtDate(c.paid_at) : '', c.method ? t(`method.${c.method}`) : '']),
    ]);

  return (
    <>
      <div className="toolbar">
        <Segmented
          value={status}
          onChange={setStatus}
          options={['all', 'unpaid', 'overdue', 'paid', 'waived'].map((v) => ({ value: v, label: t(`chargeStatus.${v}`) }))}
        />
        <div className="grow" />
        <Button icon={Download} onClick={exportCsv} disabled={!rows.length}>
          {t('common.exportCsv')}
        </Button>
        {canEdit && (
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            {t('payments.newCharge')}
          </Button>
        )}
      </div>
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder={t('payments.searchPlaceholder')} />
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">{t('payments.allTypes')}</option>
          <option value="monthly">{t('charge.monthly')}</option>
          <option value="product">{t('charge.product')}</option>
          <option value="other">{t('charge.other')}</option>
        </select>
        <select className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">{t('students.allGroups')}</option>
          {(groups || []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <select
          className="select"
          value={period}
          title={status === 'paid' ? t('payments.monthPaid') : t('payments.monthFor')}
          onChange={(e) => setPeriod(e.target.value)}
        >
          <option value="">{t('payments.allMonths')}</option>
          {Array.from({ length: 25 }, (_, i) => addMonths(currentPeriod(), 1 - i)).map((p) => (
            <option key={p} value={p}>
              {monthName(t, p)}
            </option>
          ))}
        </select>
        <div className="grow" />
        <span className="muted">
          {t('payments.shown', { n: rows.length })} · <span className="strong" style={{ color: 'var(--text)' }}><Money value={total} /></span>
        </span>
      </div>

      {loading && !data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty icon={Wallet} title={t('payments.empty')} text={t('common.tryFilters')} />
        </div>
      ) : (
        <ChargesTable rows={rows} showStudent selectable onOpenStudent={(id) => nav('students', { id })} />
      )}

      {creating && <ChargeModal onClose={() => setCreating(false)} />}
    </>
  );
}

export function ChargesTable({ rows, showStudent, selectable, onOpenStudent, student }) {
  const canEdit = useCan('payments');
  const t = useT();
  const act = useAction();
  const confirm = useConfirm();
  const club = useClub();
  const [selected, setSelected] = useState(() => new Set());
  const [paying, setPaying] = useState(null);
  const [editing, setEditing] = useState(null);

  // Drop selections that disappeared after a refresh.
  useEffect(() => {
    setSelected((s) => new Set([...s].filter((id) => rows.some((r) => r.id === id && r.status === 'unpaid'))));
  }, [rows]);

  const payable = rows.filter((r) => r.status === 'unpaid');
  const selRows = payable.filter((r) => selected.has(r.id));
  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const dash = <span className="muted">—</span>;
  const { columns, button: columnsButton } = useColumns(showStudent ? 'payments' : 'studentPayments', [
    {
      id: 'select',
      label: '',
      fixed: true,
      available: !!selectable && canEdit,
      head: () => (
        <th style={{ width: 36 }}>
          <input
            type="checkbox"
            className="check"
            checked={payable.length > 0 && selRows.length === payable.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(payable.map((r) => r.id)) : new Set())}
          />
        </th>
      ),
      cell: (c) => <td>{c.status === 'unpaid' && <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />}</td>,
    },
    {
      id: 'student',
      label: t('payments.student'),
      available: !!showStudent,
      head: () => <th>{t('payments.student')}</th>,
      cell: (c) => (
        <td>
          <a href="#" onClick={(e) => (e.preventDefault(), onOpenStudent?.(c.student_id))} style={{ fontWeight: 500, textDecoration: 'none' }}>
            {c.first_name} {c.last_name}
          </a>
          <div className="small muted">{c.group_name || ''}</div>
        </td>
      ),
    },
    {
      id: 'description',
      label: t('payments.description'),
      head: () => <th>{t('payments.description')}</th>,
      cell: (c) => (
        <td>
          <div>{chargeLabel(t, c)}</div>
          {c.note && <div className="small muted">{c.note}</div>}
        </td>
      ),
    },
    {
      id: 'dueDate',
      label: t('payments.dueDate'),
      head: () => <th>{t('payments.dueDate')}</th>,
      cell: (c) => <td className="nowrap">{fmtDate(c.due_date)}</td>,
    },
    {
      id: 'amount',
      label: t('payments.amount'),
      head: () => <th className="num">{t('payments.amount')}</th>,
      cell: (c) => (
        <td className="num strong">
          <Money value={c.amount} />
        </td>
      ),
    },
    {
      id: 'status',
      label: t('payments.status'),
      head: () => <th>{t('payments.status')}</th>,
      cell: (c) => {
        const st = chargeStatus(c);
        return (
          <td>
            <Badge tone={STATUS_TONE[st]}>{t(`chargeStatus.${st}`)}</Badge>
          </td>
        );
      },
    },
    {
      id: 'paidAt',
      label: t('payments.paidAt'),
      head: () => <th>{t('payments.paidAt')}</th>,
      cell: (c) => (
        <td className="small">
          {c.status === 'paid' ? (
            <>
              {fmtDate(c.paid_at)}
              <div className="muted">
                {t(`method.${c.method || PAYMENT_METHODS[0]}`)}
                {c.paid_by && c.paid_by !== 'system' ? ` · ${c.paid_by}` : ''}
              </div>
              {c.hdm_receipt && <div className="hdm-no">{t('hdm.short')} № {c.hdm_receipt}</div>}
            </>
          ) : (
            dash
          )}
        </td>
      ),
    },
    {
      id: 'method',
      label: t('payments.method'),
      defaultHidden: true,
      head: () => <th>{t('payments.method')}</th>,
      cell: (c) => <td>{c.status === 'paid' ? t(`method.${c.method || PAYMENT_METHODS[0]}`) : dash}</td>,
    },
    {
      id: 'paidBy',
      label: t('columns.paidBy'),
      defaultHidden: true,
      head: () => <th>{t('columns.paidBy')}</th>,
      cell: (c) => <td>{c.status === 'paid' && c.paid_by && c.paid_by !== 'system' ? c.paid_by : dash}</td>,
    },
    {
      id: 'receipt',
      label: t('columns.receipt'),
      defaultHidden: true,
      head: () => <th>{t('columns.receipt')}</th>,
      cell: (c) => <td className="nowrap">{c.hdm_receipt || dash}</td>,
    },
    {
      id: 'note',
      label: t('payments.note'),
      defaultHidden: true,
      head: () => <th>{t('payments.note')}</th>,
      cell: (c) => <td className="small">{c.note || dash}</td>,
    },
    {
      id: 'actions',
      label: '',
      fixed: true,
      available: canEdit,
      head: () => <th className="actions" />,
      cell: (c) => (
        <td className="actions">
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {c.status === 'unpaid' && (
              <Button size="sm" icon={CheckCircle2} onClick={() => setPaying([c])}>
                {t('payments.pay')}
              </Button>
            )}
            <Button size="sm" icon={Pencil} onClick={() => setEditing(c)}>
              {t('common.edit')}
            </Button>
          </div>
        </td>
      ),
    },
  ]);

  const printReceipt = (c) => {
    const name = student ? `${student.first_name} ${student.last_name}` : `${c.first_name} ${c.last_name}`;
    window.fc.print({ html: receiptHtml(t, club, c, name) });
  };

  return (
    <>
      {canEdit && selectable && selRows.length > 0 && (
        <div className="card card-pad row" style={{ marginBottom: 12, padding: '10px 16px', background: 'var(--accent-soft)' }}>
          <span className="strong">{t('payments.selected', { n: selRows.length })}</span>
          <Money value={selRows.reduce((s, r) => s + r.amount, 0)} className="strong" />
          <div className="grow" />
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {t('common.clear')}
          </Button>
          <Button size="sm" variant="primary" icon={CheckCircle2} onClick={() => setPaying(selRows)}>
            {t('payments.markPaid')}
          </Button>
        </div>
      )}
      <div className="table-tools">{columnsButton}</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {columns.map((col) => (
                <Fragment key={col.id}>{col.head()}</Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={selected.has(c.id) ? 'selected' : ''}>
                {columns.map((col) => (
                  <Fragment key={col.id}>{col.cell(c)}</Fragment>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {paying && (
        <PayModal
          charges={paying}
          student={student}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            setSelected(new Set());
          }}
        />
      )}
      {editing && <EditChargeModal charge={editing} onClose={() => setEditing(null)} onPrint={printReceipt} />}
    </>
  );
}

function MethodPicker({ value, onChange }) {
  const t = useT();
  return (
    <Segmented
      value={value}
      onChange={onChange}
      options={PAYMENT_METHODS.map((m) => ({ value: m, label: t(`method.${m}`) }))}
    />
  );
}

export function PayModal({ charges, student, onClose, onDone }) {
  const t = useT();
  const act = useAction();
  const hdm = useHdm();
  const [method, setMethod] = useState(PAYMENT_METHODS[0]);
  const [paidAt, setPaidAt] = useState(todayIso());
  // The amount actually received for each charge; starts at the amount due and can be changed.
  const [amounts, setAmounts] = useState(() => Object.fromEntries(charges.map((c) => [c.id, String(c.amount)])));
  const total = charges.reduce((s, c) => s + (Number(amounts[c.id]) || 0), 0);
  const valid = charges.every((c) => Number(amounts[c.id]) > 0);
  const pay = async () => {
    const ok = await act(
      () => rpc('charges.markPaid', { ids: charges.map((c) => c.id), amounts, method, paidAt }),
      t('payments.paidToast')
    );
    if (!ok) return;
    onDone();
    // One ՀԴՄ receipt per student.
    const paidIds = new Set(ok.ids || []);
    const byStudent = new Map();
    for (const c of charges.filter((c) => paidIds.has(c.id))) {
      if (!byStudent.has(c.student_id)) byStudent.set(c.student_id, []);
      byStudent.get(c.student_id).push(c);
    }
    for (const list of byStudent.values()) {
      const c0 = list[0];
      await hdm.afterPayment({
        method,
        student: c0.first_name ? `${c0.first_name} ${c0.last_name}` : student ? `${student.first_name} ${student.last_name}` : '',
        items: list.map((c) => ({ id: c.id, label: chargeLabel(t, c), amount: Number(amounts[c.id]) })),
      });
    }
  };
  return (
    <Modal
      title={t('payments.markPaid')}
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={CheckCircle2} onClick={pay} disabled={!valid}>
            {t('payments.confirmPaid', { amount: '' })} <Money value={total} />
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="card" style={{ maxHeight: 220, overflow: 'auto' }}>
          <div className="list">
            {charges.map((c) => (
              <div className="list-item" key={c.id} style={{ padding: '8px 14px' }}>
                <div className="grow">
                  {c.first_name && (
                    <div className="small muted">
                      {c.first_name} {c.last_name}
                    </div>
                  )}
                  {chargeLabel(t, c)}
                  {Number(amounts[c.id]) !== c.amount && (
                    <div className="small muted">
                      {t('payments.dueAmount')}: <Money value={c.amount} />
                    </div>
                  )}
                </div>
                <input
                  className="input num"
                  type="number"
                  min="0"
                  step="500"
                  style={{ width: 130, textAlign: 'right', fontWeight: 600 }}
                  value={amounts[c.id]}
                  autoFocus={charges.length === 1}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setAmounts({ ...amounts, [c.id]: e.target.value })}
                  aria-label={t('payments.receivedAmount')}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="grid-2">
          <Field label={t('payments.method')} className="span-2">
            <MethodPicker value={method} onChange={setMethod} />
          </Field>
          <Field label={t('payments.paidAt')}>
            <input className="input" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

export function ChargeModal({ studentId: fixedStudent, onClose }) {
  const t = useT();
  const act = useAction();
  const [studentId, setStudentId] = useState(fixedStudent || null);
  const [student, setStudent] = useState(null);
  const [kind, setKind] = useState('other');
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [period, setPeriod] = useState(currentPeriod());
  const [dueDate, setDueDate] = useState(todayIso());
  const [paid, setPaid] = useState(true);
  const [method, setMethod] = useState(PAYMENT_METHODS[0]);
  const [note, setNote] = useState('');
  const hdm = useHdm();

  useEffect(() => {
    if (fixedStudent) rpc('students.get', { id: fixedStudent }).then((r) => setStudent(r.student)).catch(() => {});
  }, [fixedStudent]);

  useEffect(() => {
    if (!amountTouched && kind === 'monthly' && student) setAmount(student.monthly_fee);
  }, [kind, student, amountTouched]);

  const save = async () => {
    const ok = await act(
      () =>
        rpc('charges.create', {
          studentId,
          kind,
          amount,
          description,
          period: kind === 'monthly' ? period : null,
          dueDate: kind === 'monthly' ? null : dueDate,
          paid,
          method,
          note,
        }),
      t('common.saved')
    );
    if (!ok) return;
    onClose();
    if (paid && ok.id) {
      const label = kind === 'monthly' ? chargeLabel(t, { kind, period }) : description.trim() || t('charge.other');
      await hdm.afterPayment({
        method,
        student: student ? `${student.first_name} ${student.last_name}` : '',
        items: [{ id: ok.id, label, amount: Number(amount) }],
      });
    }
  };

  return (
    <Modal
      title={t('payments.newCharge')}
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!studentId || !(Number(amount) > 0)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!fixedStudent && (
          <Field label={t('payments.student')}>
            <StudentPicker
              autoFocus
              value={studentId}
              onChange={(id, s) => {
                setStudentId(id);
                setStudent(s);
              }}
            />
          </Field>
        )}
        <Field label={t('payments.type')}>
          <Segmented
            value={kind}
            onChange={(k) => {
              setKind(k);
              setAmountTouched(false);
              setAmount('');
            }}
            options={[
              { value: 'other', label: t('charge.other') },
              { value: 'monthly', label: t('charge.monthly') },
            ]}
          />
        </Field>

        {kind === 'monthly' && (
          <Field label={t('payments.month')} hint={t('payments.monthlyHint')}>
            <input className="input" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </Field>
        )}

        {kind !== 'monthly' && (
          <Field label={t('payments.description')}>
            <input
              className="input"
              value={description}
              placeholder={t('payments.descriptionPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        )}

        <div className="grid-2">
          <Field label={t('payments.amount')}>
            <input
              className="input"
              type="number"
              min="0"
              step="500"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setAmountTouched(true);
              }}
            />
          </Field>
          {kind !== 'monthly' && (
            <Field label={t('payments.dueDate')}>
              <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </Field>
          )}
        </div>

        <label className="check">
          <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
          {t('payments.alreadyPaid')}
        </label>
        {paid && <MethodPicker value={method} onChange={setMethod} />}
        <Field label={t('payments.note')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function EditChargeModal({ charge, onClose, onPrint }) {
  const t = useT();
  const act = useAction();
  const hdm = useHdm();
  const confirm = useConfirm();
  const monthly = charge.kind === 'monthly';
  const [f, setF] = useState({
    amount: charge.amount,
    description: charge.description || '',
    note: charge.note || '',
    paidAt: charge.paid_at || '',
    method: charge.method || PAYMENT_METHODS[0],
    period: charge.period || '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });

  // The student's other monthly fees, so months already paid can't be picked.
  const { data: others } = useRpc('charges.list', { studentId: charge.student_id, kind: 'monthly' }, { skip: !monthly });
  const year = (charge.period || todayIso()).slice(0, 4);
  const periods = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const otherOf = (p) => (others || []).find((c) => c.period === p && c.id !== charge.id);
  const stateOf = (p) => {
    const c = otherOf(p);
    if (!c) return 'none';
    return c.status === 'unpaid' ? chargeStatus(c) : c.status;
  };

  const save = async () => {
    if (await act(() => rpc('charges.update', { id: charge.id, ...f }), t('common.saved'))) onClose();
  };
  const run = async (fn, text) => {
    if (await act(fn, text)) onClose();
  };

  return (
    <Modal
      title={chargeLabel(t, charge)}
      onClose={onClose}
      width={monthly ? 620 : 520}
      footer={
        <>
          <div className="left row" style={{ gap: 6 }}>
            {charge.status === 'paid' && hdm.enabled && !charge.hdm_receipt && (
              <Button
                icon={Receipt}
                onClick={() => {
                  onClose();
                  hdm.print({
                    method: charge.method || PAYMENT_METHODS[0],
                    student: `${charge.first_name || ''} ${charge.last_name || ''}`.trim(),
                    items: [{ id: charge.id, label: chargeLabel(t, charge), amount: charge.amount }],
                  });
                }}
              >
                {t('hdm.printNow')}
              </Button>
            )}
            {charge.status === 'paid' && (
              <Button icon={Printer} onClick={() => onPrint(charge)}>
                {t('payments.printReceipt')}
              </Button>
            )}
            {charge.status === 'paid' && (
              <Button
                icon={RotateCcw}
                onClick={async () =>
                  (await confirm({ text: t('payments.markUnpaidConfirm') })) &&
                  run(() => rpc('charges.markUnpaid', { id: charge.id }), t('common.saved'))
                }
              >
                {t('payments.markUnpaid')}
              </Button>
            )}
            {charge.status === 'unpaid' && (
              <Button icon={Ban} onClick={() => run(() => rpc('charges.waive', { id: charge.id }), t('common.saved'))}>
                {t('payments.waive')}
              </Button>
            )}
            {charge.status === 'waived' && (
              <Button icon={RotateCcw} onClick={() => run(() => rpc('charges.markUnpaid', { id: charge.id }), t('common.saved'))}>
                {t('payments.restore')}
              </Button>
            )}
            {!monthly && (
              <Button
                variant="danger"
                icon={Trash2}
                onClick={async () =>
                  (await confirm({ text: t('payments.deleteConfirm'), confirmLabel: t('common.delete') })) &&
                  run(() => rpc('charges.delete', { id: charge.id }), t('common.deleted'))
                }
              >
                {t('common.delete')}
              </Button>
            )}
          </div>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={!(Number(f.amount) > 0)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('payments.amount')}>
            <input className="input" type="number" min="0" value={f.amount} onChange={set('amount')} />
          </Field>
          {charge.status === 'paid' && (
            <Field label={t('payments.paidAt')}>
              <input className="input" type="date" value={f.paidAt} onChange={set('paidAt')} />
            </Field>
          )}
          {!monthly && (
            <Field label={t('payments.description')} className="span-2">
              <input className="input" value={f.description} onChange={set('description')} />
            </Field>
          )}
        </div>
        {monthly && (
          <Field label={t('payments.month')} hint={t('payments.moveMonthHint')}>
            <div className="month-grid">
              {periods.map((p, i) => {
                const st = stateOf(p);
                const on = f.period === p;
                return (
                  <button
                    key={p}
                    type="button"
                    className={`month-btn ${on ? '' : st} ${on ? 'on' : ''}`}
                    disabled={!on && st === 'paid'}
                    onClick={() => set('period')(p)}
                  >
                    <span className="m">{t(`month.${i + 1}`)}</span>
                    <span className="s">{on ? '✓' : st === 'none' ? '' : t(`chargeStatus.${st}`)}</span>
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        <div className="grid-2">
          {charge.status === 'paid' && (
            <Field label={t('payments.method')} className="span-2">
              <MethodPicker value={f.method} onChange={set('method')} />
            </Field>
          )}
          <Field label={t('payments.note')} className="span-2">
            <input className="input" value={f.note} onChange={set('note')} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

export function PayAheadModal({ student, onClose }) {
  const t = useT();
  const act = useAction();
  const hdm = useHdm();
  const [fromPeriod, setFrom] = useState(currentPeriod());
  const [months, setMonths] = useState(3);
  const [method, setMethod] = useState(PAYMENT_METHODS[0]);
  const [paidAt, setPaidAt] = useState(todayIso());
  const save = async () => {
    const r = await act(() => rpc('charges.payAhead', { studentId: student.id, fromPeriod, months, method, paidAt }));
    if (!r) return;
    onClose(r.total);
    if (r.items?.length) {
      await hdm.afterPayment({
        method,
        student: `${student.first_name} ${student.last_name}`,
        items: r.items.map((c) => ({ id: c.id, label: chargeLabel(t, { kind: 'monthly', period: c.period }), amount: c.amount })),
      });
    }
  };
  return (
    <Modal
      title={t('payments.payAhead')}
      onClose={() => onClose()}
      width={480}
      footer={
        <>
          <Button onClick={() => onClose()}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={CheckCircle2} onClick={save} disabled={!(months > 0)}>
            {t('payments.markPaid')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="muted small">{t('payments.payAheadText', { fee: money(student.monthly_fee) })}</div>
        <div className="grid-2">
          <Field label={t('payments.fromMonth')}>
            <input className="input" type="month" value={fromPeriod} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('payments.months')}>
            <input className="input" type="number" min="1" max="24" value={months} onChange={(e) => setMonths(Number(e.target.value))} />
          </Field>
          <Field label={t('payments.method')} className="span-2">
            <MethodPicker value={method} onChange={setMethod} />
          </Field>
          <Field label={t('payments.paidAt')}>
            <input className="input" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
        </div>
        <div className="row">
          <span className="muted">{t('payments.upTo')}</span>
          <span className="strong">
            <Money value={student.monthly_fee * (months || 0)} />
          </span>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ receipt
function receiptHtml(t, club, c, studentName) {
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A5; margin: 14mm; }
    body { font-family: 'Segoe UI', Sylfaen, Arial, sans-serif; color: #111; font-size: 11pt; }
    h1 { font-size: 15pt; margin: 0; } .muted { color: #666; }
    table { width: 100%; border-collapse: collapse; margin-top: 16pt; }
    td { padding: 6pt 0; border-bottom: 1px solid #ddd; } td:last-child { text-align: right; }
    .total { font-size: 14pt; font-weight: 700; margin-top: 14pt; text-align: right; }
  </style></head><body>
    <h1>${esc(club.club_name)}</h1>
    <div class="muted">${esc([club.club_address, club.club_phone].filter(Boolean).join(' · '))}</div>
    <h2 style="font-size:13pt;margin-top:18pt">${esc(t('receipt.title'))} #${c.id}</h2>
    <table>
      <tr><td>${esc(t('payments.student'))}</td><td>${esc(studentName)}</td></tr>
      <tr><td>${esc(t('payments.description'))}</td><td>${esc(chargeLabel(t, c))}</td></tr>
      <tr><td>${esc(t('payments.paidAt'))}</td><td>${esc(fmtDate(c.paid_at))}</td></tr>
      <tr><td>${esc(t('payments.method'))}</td><td>${esc(t(`method.${c.method || PAYMENT_METHODS[0]}`))}</td></tr>
    </table>
    <div class="total">${esc(money(c.amount, club.currency))}</div>
    <p style="margin-top:40pt">${esc(t('receipt.signature'))}: ____________________</p>
  </body></html>`;
}

// Monthly fee payment from a student's page: click the months of this year being paid.
export function MonthlyPaymentModal({ student, charges, onClose }) {
  const t = useT();
  const act = useAction();
  const hdm = useHdm();
  const year = todayIso().slice(0, 4);
  const periods = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const byPeriod = Object.fromEntries(charges.filter((c) => c.kind === 'monthly').map((c) => [c.period, c]));
  const stateOf = (p) => {
    const c = byPeriod[p];
    if (!c) return 'none';
    return c.status === 'unpaid' ? chargeStatus(c) : c.status;
  };
  const payable = (p) => !['paid', 'waived'].includes(stateOf(p));
  // The current month is ticked when it still needs paying.
  const [picked, setPicked] = useState(() => new Set(payable(currentPeriod()) ? [currentPeriod()] : []));
  const [amount, setAmount] = useState(student.monthly_fee || '');
  const [method, setMethod] = useState(PAYMENT_METHODS[0]);
  const [paidAt, setPaidAt] = useState(todayIso());
  const [note, setNote] = useState('');
  const selected = periods.filter((p) => picked.has(p));
  const total = selected.length * (Number(amount) || 0);

  const toggle = (p) =>
    setPicked((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const save = async () => {
    const ok = await act(
      () => rpc('charges.payMonths', { studentId: student.id, periods: selected, amount, method, paidAt, note }),
      t('payments.paidToast')
    );
    if (!ok) return;
    onClose();
    if (ok.ids?.length) {
      await hdm.afterPayment({
        method,
        student: `${student.first_name} ${student.last_name}`,
        items: ok.ids.map((id, i) => ({ id, label: chargeLabel(t, { kind: 'monthly', period: ok.periods[i] }), amount: Number(amount) })),
      });
    }
  };

  return (
    <Modal
      title={`${t('charge.monthly')} — ${student.first_name} ${student.last_name}`}
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={CheckCircle2} onClick={save} disabled={!selected.length || !(Number(amount) > 0)}>
            {t('payments.confirmPaid')} <Money value={total} />
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label={t('payments.monthsOf', { year })} hint={t('payments.pickMonths')}>
          <div className="month-grid">
            {periods.map((p, i) => {
              const st = stateOf(p);
              const on = picked.has(p);
              return (
                <button
                  key={p}
                  type="button"
                  className={`month-btn ${st} ${on ? 'on' : ''}`}
                  disabled={!payable(p)}
                  onClick={() => toggle(p)}
                >
                  <span className="m">{t(`month.${i + 1}`)}</span>
                  <span className="s">{on ? '✓' : st === 'none' ? '' : t(`chargeStatus.${st}`)}</span>
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid-2">
          <Field label={t('payments.amountPerMonth')}>
            <input className="input" type="number" min="0" step="500" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={t('payments.paidAt')}>
            <input className="input" type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
          <Field label={t('payments.method')} className="span-2">
            <MethodPicker value={method} onChange={setMethod} />
          </Field>
          <Field label={t('payments.note')} className="span-2">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
